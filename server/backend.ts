import { mirrorConfig } from "../mirror.config.ts";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract, conflictRpcContract, probeRpcContract, globalStateSchema, projectStateSchema, updateStatusSchema, STATE_CHANGED } from "../shared/rpc.ts";
import { loadCatalog, loadRuntimeNote, findPluginRoot, registeredSkillNames, detectPrerequisites } from "./files.ts";
import { resolveSkillSelections, resolveSkills, type SkillSelection, applySkillChanges, defaultGlobal, defaultProject, type GlobalState, type ProjectState, type Scope } from "./resolve.ts";
import { fetchUpdates, initialUpdate, errorMessage, type Fetch, type UpdateStatus } from "./updates.ts";
import { registerCli } from "./cli.ts";
import { loadRenameLedger, migrateStoredState } from "./migrations.ts";
import { catalogStateSchema, resolvedSkillSchema, type CatalogState, type RenameLedger, type ResolvedSkill } from "../shared/state.ts";
import { canonicalIdSchema } from "../shared/catalog.ts";
import { scanSnapshotSchema, type ScanSnapshot, providerProbeSchema, type ProviderProbe } from "../shared/conflicts.ts";
import { PluginScan, bbSkillDiscovery, resolveConflicts, resolveConflictChoices, installedBbVersion, type Discover } from "./conflicts.ts";

export interface CommittedDelivery {
  snapshot: ScanSnapshot;
  resolved: readonly ResolvedSkill[];
  addendum: string;
}
/** Delivery differs by provider only in its addendum: ACP agents get an advisory note. */
export interface DeliveryScope { projectId: string; providerId: string }

/** Reads the committed plugin scan and resolves only in memory. */
export type ReadCommittedSnapshot = (
  scope: DeliveryScope, selections: readonly SkillSelection[], project: ProjectState,
) => CommittedDelivery | undefined;

export interface BackendOptions {
  root?: string;
  catalogPath?: string;
  runtimeNotePath?: string;
  registeredNames?: ReadonlySet<string>;
  prerequisites?: Record<string, boolean>;
  fetch?: Fetch;
  renameLedger?: RenameLedger;
  readCommittedSnapshot?: ReadCommittedSnapshot;
  discoverConflicts?: Discover;
  bbVersion?: string;
  prerequisiteContext?: Pick<Parameters<typeof detectPrerequisites>[0], "tracker" | "conditionalCommands">;
  /** null skips the startup check in tests. Production checks after one second. */
  startupDelayMs?: number | null;
}

export async function startBackend(bb: BbPluginApi, options: BackendOptions = {}) {
  const root = options.root ?? await findPluginRoot();
  const catalog = await loadCatalog(options.catalogPath ?? join(root, mirrorConfig.paths.catalog));
  const version = z.object({ version: z.string() }).parse(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).version;
  const runtimeNote = await loadRuntimeNote(options.runtimeNotePath ?? join(root, mirrorConfig.paths.runtimeNote));
  const registered = options.registeredNames ?? await registeredSkillNames(root, catalog);
  const allowedNames = new Set(catalog.skills.flatMap(skill => [skill.canonicalId, skill.aliasName]).filter(name => registered.has(name)));
  if (allowedNames.size !== catalog.skills.length * 2) bb.log.warn("Some Matt variants lack matching static registrations and cannot be selected");
  const prerequisites = options.prerequisites ?? await detectPrerequisites({ catalog, ...options.prerequisiteContext });
  let global: GlobalState = defaultGlobal();
  const projects = new Map<string, ProjectState>();
  let seenSkills: string[] = [];
  let startHereDismissed = false;
  let update: UpdateStatus | null = initialUpdate();
  const lifecycle = new AbortController();

  let catalogState: CatalogState;
  let writes: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = writes.then(() => {
      if (lifecycle.signal.aborted) throw new Error("Matt Pocock backend is disposed");
      return operation();
    });
    writes = pending.catch(() => undefined);
    return pending;
  }
  const malformedKeys = new Set<string>();
  const migrated = await migrateStoredState({
    catalog, ledger: options.renameLedger ?? await loadRenameLedger(join(root, "compat/renames.json")), serialize,
    storage: {
      list: prefix => bb.storage.kv.list(prefix),
      set: async (key, value) => { if (!malformedKeys.has(key)) await bb.storage.kv.set(key, value); },
      get: async key => {
        const value = await bb.storage.kv.get<unknown>(key);
        if (value === undefined) return undefined;
        const schema = key === "global" ? globalStateSchema.strip().extend({ arrivalPolicy: globalStateSchema.shape.arrivalPolicy.strip() })
          : key.startsWith("project:") ? projectStateSchema.strip().extend({ conflicts: projectStateSchema.shape.conflicts.default({}) })
          : key === "seenSkills" ? z.array(canonicalIdSchema)
          : key === "startHereDismissed" ? z.boolean()
          : key === "updateStatus" ? updateStatusSchema.nullable()
          : key === "catalogState" ? catalogStateSchema : null;
        if (!schema) return value;
        const parsed = schema.safeParse(value);
        if (parsed.success) return parsed.data;
        if (!malformedKeys.has(key)) bb.log.warn(`Ignoring malformed Matt Pocock state at ${key}`);
        malformedKeys.add(key);
        return undefined;
      },
    },
    commit: state => {
      global = state.global;
      for (const [id, project] of Object.entries(state.projects)) projects.set(id, project);
      seenSkills = state.seenSkills;
      catalogState = state.catalogState;
      startHereDismissed = state.startHereDismissed;
      const cached = state.updateStatus;
      if (cached) {
        const sameBundle = cached.bundledCommit === catalog.upstream.commit;
        update = { ...cached, bundledCommit: catalog.upstream.commit,
          bundledUpstreamVersion: catalog.upstream.version, installedPluginVersion: version,
          upstreamAheadCount: sameBundle ? cached.upstreamAheadCount : cached.latestUpstreamCommit === catalog.upstream.commit ? 0 : null,
          checkedAt: sameBundle ? cached.checkedAt : "",
        };
      }
    },
  });
  if (update && !malformedKeys.has("updateStatus") && !isDeepStrictEqual(update, migrated.updateStatus)) {
    await serialize(() => bb.storage.kv.set("updateStatus", update));
  }
  const projectAt = (id: string): ProjectState => projects.get(id) ?? defaultProject();
  const projectFor = (scope: Scope): ProjectState | null => scope.kind === "global" ? null : projectAt(scope.projectId);
  const scanKey = "pluginScan";
  const legacyPrefixes = ["conflictSnapshot:", "conflictInvalidation:"];
  const names = catalog.skills.flatMap(skill => [skill.canonicalId, skill.aliasName]);
  const bbVersion = options.bbVersion ?? await installedBbVersion();
  const storedProbes = z.array(providerProbeSchema).safeParse(await bb.storage.kv.get<unknown>("conflictProbes"));
  let probes: ProviderProbe[] = storedProbes.success ? storedProbes.data : [];
  const scan = new PluginScan(options.discoverConflicts ?? bbSkillDiscovery(bb, names, message => bb.log.warn(message)), names, snapshot => {
    if (lifecycle.signal.aborted) return;
    if (snapshot.complete) void serialize(() => bb.storage.kv.set(scanKey, snapshot))
      .catch(error => { if (!lifecycle.signal.aborted) bb.log.warn(`Saving Matt plugin scan: ${errorMessage(error)}`); });
    publish();
  });
  const readCommittedSnapshot: ReadCommittedSnapshot = options.readCommittedSnapshot ?? ((scope, selections, project) => {
    const snapshot = scan.read();
    return snapshot ? resolveConflicts({ catalog, selections, projectId: scope.projectId, project, snapshot, bbVersion, probes, providerId: scope.providerId }) : undefined;
  });

  function conflictResponse(projectId: string) {
    const snapshot = scan.read() ?? null;
    if (!snapshot) return { snapshot, conflicts: [] };
    const project = projectAt(projectId);
    const result = resolveConflicts({ catalog, projectId, project, snapshot, bbVersion, probes,
      selections: resolveSkillSelections(catalog, global, project, catalogState) });
    return { snapshot, conflicts: result.resolved.map(row => structuredClone(row.conflict)) };
  }

  /** Resolves in memory from the committed scan; never scans. */
  function deliver(scope: DeliveryScope): CommittedDelivery | undefined {
    const project = projectAt(scope.projectId);
    const selections = resolveSkillSelections(catalog, global, project, catalogState);
    const committed = readCommittedSnapshot(structuredClone(scope), structuredClone(selections), structuredClone(project));
    if (!committed) return undefined;
    const snapshot = scanSnapshotSchema.parse(committed.snapshot);
    if (snapshot.freshness === "invalidated") return undefined;
    const rows = z.array(resolvedSkillSchema).parse(committed.resolved);
    const choices = new Map(selections.map(selection => [selection.canonicalId, selection]));
    const definitions = new Map(catalog.skills.map(skill => [skill.canonicalId, skill]));
    const selectedIds = new Set<string>();
    const safe = rows.map(row => {
      const skill = definitions.get(row.canonicalId);
      const selection = choices.get(row.canonicalId);
      if (!skill || !selection || selectedIds.has(row.canonicalId)) throw new Error(`Invalid scoped identity ${row.canonicalId}`);
      selectedIds.add(row.canonicalId);
      if (!selection.active) {
        const outcome = selection.reason === "off-dependency" ? "blocked" as const : "yielded" as const;
        return { ...row, ...selection, active: false, bbName: null, outcome,
          conflict: { ...row.conflict, outcome, effectiveName: null, reason: selection.reason } };
      }
      if (!row.active && row.bbName === null) return row;
      const complete = snapshot.complete || !snapshot.affectedUnknownNames.some(name => name === skill.canonicalId || name === skill.aliasName);
      const mapped = row.bbName !== skill.aliasName || committed.addendum.includes(`when Matt's skills reference ${skill.canonicalId}, load ${skill.aliasName}`);
      const valid = selection.active && complete && row.active && row.conflict.snapshotGeneration === snapshot.generation &&
        row.bbName === row.conflict.effectiveName &&
        ((row.outcome === "canonical-selected" && row.bbName === skill.canonicalId) ||
          (row.outcome === "alias-selected" && row.bbName === skill.aliasName)) &&
        row.bbName !== null && allowedNames.has(row.bbName) && mapped;
      if (valid) return row;
      return { ...row, active: false, bbName: null, outcome: "unknown" as const, reason: "off-scan" as const,
        conflict: { ...row.conflict, effectiveName: null, outcome: "unknown" as const,
          reason: "Delivery is unavailable: pending discovery, unregistered variant, or missing alias mapping." } };
    });
    // Missing or unsafe dependency variants block their callers, including cycles.
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of safe) {
        if (!row.active) continue;
        const skill = definitions.get(row.canonicalId);
        const blockedBy = skill?.dependsOn.flatMap(edge => (edge.kind === "hard" || edge.kind === "conditional-hard") &&
          !safe.some(dependency => dependency.canonicalId === edge.canonicalId && dependency.active) ? [edge.canonicalId] : []) ?? [];
        if (!blockedBy.length) continue;
        Object.assign(row, { active: false, bbName: null, outcome: "blocked", reason: "off-dependency", blockedBy,
          conflict: { ...row.conflict, outcome: "blocked", effectiveName: null, reason: `Unavailable dependencies: ${blockedBy.join(", ")}` } });
        changed = true;
      }
    }
    const result = { snapshot, resolved: safe, addendum: committed.addendum };
    const instructions = projectInstructions(result);
    if (!runtimeNote || (instructions !== null && instructions.length > 4096)) {
      for (const row of result.resolved) if (row.active) {
        Object.assign(row, { active: false, bbName: null, outcome: "blocked", reason: "off-conflict",
          conflict: { ...row.conflict, outcome: "blocked", effectiveName: null, reason: "Runtime instructions are missing or exceed the 4096-character budget." } });
      }
    }
    return result;
  }
  function projectInstructions(entry: CommittedDelivery): string | null {
    if (!runtimeNote || !entry.resolved.some(row => row.active)) return null;
    return `${runtimeNote}\nMatt scan ${JSON.stringify({ generation: entry.snapshot.generation })}\n${entry.addendum}`;
  }

  const resolved = (scope: Scope) => resolveSkills(catalog, global, projectFor(scope), seenSkills, catalogState);
  bb.agents.configure(ctx => {
    try {
      const scope = z.object({ projectId: z.string(), providerId: z.string() }).parse({ projectId: ctx.project?.id, providerId: ctx.provider?.id });
      const entry = lifecycle.signal.aborted ? undefined : deliver(scope);
      const names = entry?.resolved.flatMap(row => row.active && row.bbName ? [row.bbName] : []) ?? [];
      const instructions = entry ? projectInstructions(entry) : null;
      return names.length <= 256 && instructions ? { tools: [], skills: names, instructions } : { tools: [], skills: [] };
    } catch (error) {
      bb.log.error(`Configuring Matt Pocock skills: ${errorMessage(error)}`);
      return { tools: [], skills: [] };
    }
  });


  function publish() {
    try { bb.realtime.publish(STATE_CHANGED, { changed: true }); }
    catch (error) { bb.log.error(`Publishing Matt Pocock state: ${errorMessage(error)}`); }
  }
  async function persistGlobal(next: GlobalState) {
    await bb.storage.kv.set("global", next);
    global = next;
    publish();
  }
  async function persistProject(projectId: string, next: ProjectState) {
    await bb.storage.kv.set(`project:${projectId}`, next);
    projects.set(projectId, next);
    publish();
  }

  let pendingCheck: Promise<UpdateStatus> | null = null;
  function checkUpdates(): Promise<UpdateStatus> {
    if (pendingCheck) return pendingCheck;
    pendingCheck = (async () => {
      const next = await fetchUpdates(catalog, version, options.fetch, lifecycle.signal);
      return serialize(async () => {
        await bb.storage.kv.set("updateStatus", next);
        update = next;
        publish();
        return structuredClone(update);
      });
    })().finally(() => { pendingCheck = null; });
    return pendingCheck;
  }

  const handlers: PluginRpcHandlers<typeof rpcContract & typeof conflictRpcContract & typeof probeRpcContract> = {
    matt_pocock_conflicts: async ({ projectId, refresh }) => {
      if (refresh) await scan.refresh();
      return conflictResponse(projectId);
    },
    matt_pocock_resolve: ({ projectId, canonicalId, choice }) => serialize(async () => {
      if (!catalog.skills.some(skill => skill.canonicalId === canonicalId)) throw new Error(`Unknown skill: ${canonicalId}`);
      const next = { ...projectAt(projectId), conflicts: { ...projectAt(projectId).conflicts, [canonicalId]: choice } };
      if (choice === "both" || choice === "ours") {
        const selected = resolveSkillSelections(catalog, global, next, catalogState)
          .map(row => row.canonicalId === canonicalId ? { ...row, active: true } : row);
        const proposed = readCommittedSnapshot({ projectId, providerId: "" }, selected, next);
        const row = proposed && resolveConflictChoices({ catalog, selections: selected, projectId, project: next,
          snapshot: proposed.snapshot, bbVersion, probes }).find(item => item.canonicalId === canonicalId);
        if (!row || !row.bbName || !allowedNames.has(row.bbName) ||
          (choice === "both" ? row.outcome !== "alias-selected" : row.outcome !== "canonical-selected"))
          throw new Error(`Choice ${choice} blocked: ${row?.conflict.reason ?? "Discovery is pending"}; a registered and mapped variant is required`);
        const instructions = proposed ? projectInstructions(proposed) : null;
        if (!runtimeNote || (instructions !== null && instructions.length > 4096))
          throw new Error(`Choice ${choice} blocked: runtime instructions are missing or exceed the 4096-character budget`);
      }
      await persistProject(projectId, next);
      return { ok: true as const };
    }),
    matt_pocock_record_probe: record => serialize(async () => {
      const probe = providerProbeSchema.parse(record);
      const next = [...probes.filter(item => !(item.requirement === probe.requirement && item.bbVersion === probe.bbVersion && item.providerId === probe.providerId)), probe];
      await bb.storage.kv.set("conflictProbes", next);
      probes = next;
      publish();
      return { ok: true as const };
    }),
    matt_pocock_state: async ({ scope }) => {
      await writes;
      // SDK list returns project DTOs directly, not a { projects } wrapper.
      const available = await bb.sdk.projects.list({ includePersonal: true });
      return {
        installedPluginVersion: version,
        delivery: scope.kind === "project" ? deliveryState(scope.projectId) : null,
        catalog: structuredClone(catalog), global: structuredClone(global), project: structuredClone(projectFor(scope)),
        resolved: resolved(scope), projects: available.map(({ id, name }) => ({ id, name, mode: projectAt(id).mode, enabled: projectAt(id).mode === "custom" ? projectAt(id).enabled : global.enabled })),
        prerequisites: { ...prerequisites }, update: structuredClone(update), startHereDismissed,
      };
    },
    matt_pocock_set_skills: ({ scope, changes, cascade }) => serialize(async () => {
      const project = scope.kind === "project" ? { ...projectAt(scope.projectId), mode: "custom" as const } : null;
      const skills = applySkillChanges(catalog, global, project, seenSkills, changes, cascade, catalogState);
      if (scope.kind === "project" && project) await persistProject(scope.projectId, { ...project, skills });
      else await persistGlobal({ ...global, skills });
      return { resolved: resolved(scope) };
    }),
    matt_pocock_set_master: ({ scope, enabled }) => serialize(async () => {
      if (scope.kind === "global") await persistGlobal({ ...global, enabled });
      else await persistProject(scope.projectId, { ...projectAt(scope.projectId), mode: "custom", enabled });
      return { ok: true as const };
    }),
    matt_pocock_set_project_mode: ({ projectId, mode }) => serialize(async () => {
      await persistProject(projectId, { ...projectAt(projectId), mode });
      return { ok: true as const };
    }),
    matt_pocock_set_arrival_policy: ({ value }) => serialize(async () => {
      await persistGlobal({ ...global, arrivalPolicy: { newStableSkills: value } });
      return { ok: true as const };
    }),
    matt_pocock_dismiss_start_here: ({ dismissed }) => serialize(async () => {
      await bb.storage.kv.set("startHereDismissed", dismissed);
      startHereDismissed = dismissed;
      publish();
      return { ok: true as const };
    }),
    matt_pocock_mark_seen: () => serialize(async () => {
      const next = catalog.skills.map(skill => skill.canonicalId);
      await bb.storage.kv.set("seenSkills", next);
      seenSkills = next;
      publish();
      return { ok: true as const };
    }),
    matt_pocock_check_updates: () => checkUpdates(),
  };
  bb.rpc.register({ ...rpcContract, ...conflictRpcContract, ...probeRpcContract }, handlers);
  registerCli(bb, handlers);
  bb.background.schedule("upstream-check", mirrorConfig.release.updateCron, async () => { await checkUpdates(); });
  const delay = options.startupDelayMs === undefined ? 1000 : options.startupDelayMs;
  const timer = delay === null ? null : setTimeout(() => {
    void checkUpdates().catch(error => bb.log.error(`Startup update check: ${errorMessage(error)}`));
  }, delay);
  function deliveryState(projectId: string) {
    const entry = deliver({ projectId, providerId: "" });
    return entry ? { snapshot: structuredClone(entry.snapshot), resolved: structuredClone([...entry.resolved]) } : null;
  }
  // Per-scope scan state from 0.1.0–0.1.2 is obsolete.
  for (const prefix of legacyPrefixes) for (const key of await bb.storage.kv.list(prefix)) {
    await serialize(() => bb.storage.kv.delete(key)).catch(error => bb.log.warn(`Removing obsolete Matt scan state: ${errorMessage(error)}`));
  }
  const stored = scanSnapshotSchema.safeParse(await bb.storage.kv.get<unknown>(scanKey));
  if (stored.success) scan.restore(stored.data);
  void scan.refresh();
  const unsubscribe = bb.sdk.subscribe?.({ event: "system:changed", callback: event => {
    if (!event.changes.includes("plugins-changed")) return;
    scan.invalidate(); publish();
  } });
  bb.onDispose(async () => {
    unsubscribe?.(); scan.dispose();
    if (timer !== null) clearTimeout(timer);
    lifecycle.abort(new Error("Matt Pocock backend disposed"));
  });
  bb.log.info(`loaded ${catalog.skills.length} Matt Pocock skills`);
}
