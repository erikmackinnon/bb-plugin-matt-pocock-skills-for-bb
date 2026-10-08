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
import { scanScopeSchema, scanSnapshotSchema, type ScanScope, type ScanSnapshot, providerProbeSchema, type ProviderProbe } from "../shared/conflicts.ts";

import { ConflictScanner, sdkDiscovery, resolveConflicts, resolveConflictChoices, installedBbVersion, applicableScopes, type Discover } from "./conflicts.ts";

export interface CommittedScopeSnapshot {
  snapshot: ScanSnapshot;
  resolved: readonly ResolvedSkill[];
  addendum: string;
}

/** Reads committed discovery and resolves only in memory. */
export type ReadCommittedSnapshot = (
  scope: ScanScope, selections: readonly SkillSelection[], project: ProjectState,
) => CommittedScopeSnapshot | undefined;

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
  conflictScopes?: (projectId: string) => Promise<ScanScope[]>;
  bbVersion?: string;
  conflictRefreshMs?: number;
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
  const scopeKey = (scope: ScanScope) => JSON.stringify([scope.projectId, scope.providerId, scope.environmentId, scope.hostId]);
  const cachedScopes = new Map<string, CommittedScopeSnapshot>();
  const snapshotPrefix = "conflictSnapshot:";
  const invalidationPrefix = "conflictInvalidation:";
  const invalidationWrites = new Map<string, Promise<void>>();
  const names = catalog.skills.flatMap(skill => [skill.canonicalId, skill.aliasName]);
  const bbVersion = options.bbVersion ?? await installedBbVersion();
  const storedProbes = z.array(providerProbeSchema).safeParse(await bb.storage.kv.get<unknown>("conflictProbes"));
  let probes: ProviderProbe[] = storedProbes.success ? storedProbes.data : [];
  const scanner = new ConflictScanner(options.discoverConflicts ?? sdkDiscovery(bb, names), names, (scope, changed) => {
    if (lifecycle.signal.aborted) return;
    try {
      readScope(scope);
      const snapshot = scanner.read(scope);
      if (snapshot) void serialize(() => bb.storage.kv.set(`${snapshotPrefix}${scopeKey(scope)}`, snapshot))
        .catch(error => { if (!lifecycle.signal.aborted) bb.log.warn(`Saving Matt conflict scan: ${errorMessage(error)}`); });
      if (changed) publish();
    }
    catch (error) { bb.log.error(`Committing Matt conflict scan: ${errorMessage(error)}`); }
  });
  const readCommittedSnapshot: ReadCommittedSnapshot = options.readCommittedSnapshot ?? ((scope, selections, project) => {
    const snapshot = scanner.read(scope);
    return snapshot ? resolveConflicts({ catalog, selections, project, snapshot, bbVersion, probes }) : undefined;
  });
  const scopeRequests = new Map<string, Promise<ScanScope[]>>();
  function projectScopes(projectId: string, snapshotKeys?: readonly string[]): Promise<ScanScope[]> {
    const pending = scopeRequests.get(projectId);
    if (pending) return pending;
    const operation = (async () => {
      const discovered = await (options.conflictScopes ?? (id => applicableScopes(bb, id)))(projectId);
      if (lifecycle.signal.aborted) return [];
      const scopes = discovered.map(scope => scanScopeSchema.parse(scope));
      const applicable = new Set(scopes.map(scopeKey));
      scanner.retain(projectId, applicable);
      for (const [key, entry] of cachedScopes) if (entry.snapshot.scope.projectId === projectId && !applicable.has(key)) cachedScopes.delete(key);
      for (const key of snapshotKeys ?? await bb.storage.kv.list(snapshotPrefix)) {
        const parsed = scanSnapshotSchema.safeParse(await bb.storage.kv.get<unknown>(key));
        if (parsed.success && parsed.data.scope.projectId === projectId && !applicable.has(scopeKey(parsed.data.scope)))
          void serialize(async () => {
            const scopeId = scopeKey(parsed.data.scope);
            if (scanner.known(projectId).some(scope => scopeKey(scope) === scopeId)) return;
            await invalidationWrites.get(scopeId);
            await bb.storage.kv.delete(key);
            await bb.storage.kv.delete(`${invalidationPrefix}${scopeId}`);
            invalidationWrites.delete(scopeId);
          }).catch(error => {
            if (!lifecycle.signal.aborted) bb.log.warn(`Removing obsolete Matt scope: ${errorMessage(error)}`);
          });
      }
      return [...new Map(scopes.map(scope => [scopeKey(scope), scope])).values()];
    })().finally(() => { scopeRequests.delete(projectId); });
    scopeRequests.set(projectId, operation);
    return operation;
  }

  function conflictResponse(projectId: string) {
    const entries = scanner.known(projectId).flatMap(scope => {
      const committed = cachedScopes.get(scopeKey(scope));
      if (committed) return [committed];
      const snapshot = scanner.read(scope);
      if (!snapshot) return [];
      const project = projectAt(projectId);
      return [resolveConflicts({ catalog, project, snapshot, bbVersion, probes,
        selections: resolveSkillSelections(catalog, global, project, catalogState) })];
    });
    for (const entry of cachedScopes.values()) if (entry.snapshot.scope.projectId === projectId &&
      !entries.some(existing => scopeKey(existing.snapshot.scope) === scopeKey(entry.snapshot.scope))) entries.push(entry);
    return { snapshots: entries.map(entry => structuredClone(entry.snapshot)),
      conflicts: entries.flatMap(entry => entry.resolved.map(row => structuredClone(row.conflict))) };
  }
  const projectScans = new Map<string, Promise<ScanScope[]>>();
  function scanProject(projectId: string, snapshotKeys?: readonly string[]): Promise<ScanScope[]> {
    const pending = projectScans.get(projectId);
    if (pending) return pending;
    const operation = (async () => {
      const scopes = await projectScopes(projectId, snapshotKeys);
      if (lifecycle.signal.aborted) return [];
      const scans = scopes.map(scope => scanner.refresh(scope));
      refreshCachedScopes(projectId);
      await Promise.all(scans);
      const retained = new Set(scanner.known(projectId).map(scopeKey));
      for (const scope of scopes) if (retained.has(scopeKey(scope))) readScope(scope);
      return scopes.filter(scope => retained.has(scopeKey(scope)));
    })().finally(() => { projectScans.delete(projectId); });
    projectScans.set(projectId, operation);
    return operation;
  }

  function readScope(scope: ScanScope): CommittedScopeSnapshot | undefined {
    const key = scopeKey(scope);
    const project = projectAt(scope.projectId);
    const selections = resolveSkillSelections(catalog, global, project, catalogState);
    cachedScopes.delete(key);
    const committed = readCommittedSnapshot(scope, structuredClone(selections), structuredClone(project));
    if (!committed) return undefined;
    const snapshot = scanSnapshotSchema.parse(committed.snapshot);
    if (scopeKey(snapshot.scope) !== key || snapshot.freshness === "invalidated") return undefined;
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
        scopeKey(row.conflict.scope) === key && row.bbName === row.conflict.effectiveName &&
        ((row.outcome === "canonical-selected" && row.bbName === skill.canonicalId) ||
          (row.outcome === "alias-selected" && row.bbName === skill.aliasName)) &&
        row.bbName !== null && allowedNames.has(row.bbName) && mapped;
      if (valid) return row;
      return { ...row, active: false, bbName: null, outcome: "unknown" as const, reason: "off-scan" as const,
        conflict: { ...row.conflict, effectiveName: null, outcome: "unknown" as const,
          reason: "Delivery is unavailable: pending discovery, unregistered variant, or missing scope mapping." } };
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
    cachedScopes.set(key, result);
    const instructions = projectInstructions(scope.projectId, result);
    if (!runtimeNote || (instructions !== null && instructions.length > 4096)) {
      for (const row of result.resolved) if (row.active) {
        Object.assign(row, { active: false, bbName: null, outcome: "blocked", reason: "off-conflict",
          conflict: { ...row.conflict, outcome: "blocked", effectiveName: null, reason: "Runtime instructions are missing or exceed the 4096-character budget." } });
      }
    }
    return result;
  }
  function projectInstructions(projectId: string, entry: CommittedScopeSnapshot): string | null {
    if (!runtimeNote || entry.snapshot.scope.projectId !== projectId || !entry.resolved.some(row => row.active)) return null;
    const { providerId, environmentId, hostId } = entry.snapshot.scope;
    return `${runtimeNote}\nMatt scope ${JSON.stringify({ providerId, environmentId, hostId, generation: entry.snapshot.generation })}\n${entry.addendum}`;
  }

  const resolved = (scope: Scope) => resolveSkills(catalog, global, projectFor(scope), seenSkills, catalogState);
  bb.agents.configure(ctx => {
    try {
      const scope = scanScopeSchema.parse({ projectId: ctx.project.id, providerId: ctx.provider.id,
        environmentId: ctx.environment.id, hostId: ctx.host.id });
      const entry = lifecycle.signal.aborted ? undefined : readScope(scope);
      const names = entry?.resolved.flatMap(row => row.active && row.bbName ? [row.bbName] : []) ?? [];
      const instructions = entry ? projectInstructions(scope.projectId, entry) : null;
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
  function refreshCachedScopes(projectId?: string) {
    const scopes = [...cachedScopes.values()].map(entry => entry.snapshot.scope)
      .filter(scope => projectId === undefined || scope.projectId === projectId);
    for (const scope of scopes) {
      try { readScope(scope); }
      catch (error) { bb.log.error(`Refreshing Matt scope: ${errorMessage(error)}`); }
    }
  }
  async function persistGlobal(next: GlobalState) {
    await bb.storage.kv.set("global", next);
    global = next;
    refreshCachedScopes();
    publish();
  }
  async function persistProject(projectId: string, next: ProjectState) {
    await bb.storage.kv.set(`project:${projectId}`, next);
    projects.set(projectId, next);
    refreshCachedScopes(projectId);
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
      if (refresh) await scanProject(projectId);
      return conflictResponse(projectId);
    },
    matt_pocock_resolve: ({ projectId, canonicalId, choice }) => serialize(async () => {
      if (!catalog.skills.some(skill => skill.canonicalId === canonicalId)) throw new Error(`Unknown skill: ${canonicalId}`);
      const scopes = await scanProject(projectId);
      const next = { ...projectAt(projectId), conflicts: { ...projectAt(projectId).conflicts, [canonicalId]: choice } };
      const blocked: string[] = [];
      const candidates = new Map(cachedScopes);
      if (choice === "both" || choice === "ours") {
        if (scopes.length === 0) throw new Error("No applicable provider scopes have completed discovery");
        for (const scope of scopes) {
          const selections = resolveSkillSelections(catalog, global, next, catalogState);
          const selected = selections.map(row => row.canonicalId === canonicalId ? { ...row, active: true } : row);
          const proposed = readCommittedSnapshot(scope, selected, next);
          const row = proposed && resolveConflictChoices({ catalog, selections: selected, project: next,
            snapshot: proposed.snapshot, bbVersion, probes }).find(item => item.canonicalId === canonicalId);
          if (!row || !row.bbName || !allowedNames.has(row.bbName) ||
            (choice === "both" ? row.outcome !== "alias-selected" : row.outcome !== "canonical-selected")) {
            blocked.push(`${JSON.stringify(scope)}: ${row?.conflict.reason ?? "Discovery is pending"}; a registered and mapped variant is required`);
          } else if (proposed) candidates.set(scopeKey(scope), proposed);
        }
      }
      if (choice === "both" || choice === "ours") for (const scope of scopes) {
        const entry = candidates.get(scopeKey(scope));
        const instructions = entry ? projectInstructions(projectId, entry) : null;
        if (!runtimeNote || (instructions !== null && instructions.length > 4096))
          blocked.push(`${JSON.stringify(scope)}: runtime instructions are missing or exceed the 4096-character budget`);
      }
      if (blocked.length) throw new Error(`Choice ${choice} blocked in scopes: ${blocked.join("; ")}`);
      await persistProject(projectId, next);
      return { ok: true as const };
    }),
    matt_pocock_record_probe: record => serialize(async () => {
      const probe = providerProbeSchema.parse(record);
      const next = [...probes.filter(item => !(item.requirement === probe.requirement && item.bbVersion === probe.bbVersion && item.providerId === probe.providerId)), probe];
      await bb.storage.kv.set("conflictProbes", next);
      probes = next;
      refreshCachedScopes(); publish();
      return { ok: true as const };
    }),
    matt_pocock_state: async ({ scope }) => {
      await writes;
      if (scope.kind === "project" && !options.readCommittedSnapshot && scanner.known(scope.projectId).length === 0) {
        void scanProject(scope.projectId).catch(error => bb.log.warn(`Opening Matt conflict discovery: ${errorMessage(error)}`));
      }
      // SDK list returns project DTOs directly, not a { projects } wrapper.
      const available = await bb.sdk.projects.list({ includePersonal: true });
      return {
        installedPluginVersion: version,
        deliveryScopes: scope.kind === "project" ? [...cachedScopes.values()].filter(entry => entry.snapshot.scope.projectId === scope.projectId)
          .map(entry => ({ snapshot: structuredClone(entry.snapshot), resolved: structuredClone([...entry.resolved]) })) : [],
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
  async function refreshProjects() {
    const projectIds = new Set([...projects.keys(), ...scanner.known().map(scope => scope.projectId)]);
    const snapshotKeys = await bb.storage.kv.list(snapshotPrefix);
    await Promise.all([...projectIds].map(async projectId => {
      if (lifecycle.signal.aborted) return;
      try { await scanProject(projectId, snapshotKeys); }
      catch (error) { if (!lifecycle.signal.aborted) bb.log.warn(`Refreshing Matt discovery: ${errorMessage(error)}`); }
    }));
  }
  if (!options.readCommittedSnapshot) {
    for (const key of await bb.storage.kv.list(invalidationPrefix)) {
      const parsed = z.number().int().positive().safeParse(await bb.storage.kv.get<unknown>(key));
      if (parsed.success) scanner.seedGeneration(parsed.data - 1);
    }
    for (const key of await bb.storage.kv.list(snapshotPrefix)) {
      const parsed = scanSnapshotSchema.safeParse(await bb.storage.kv.get<unknown>(key));
      if (parsed.success && key === `${snapshotPrefix}${scopeKey(parsed.data.scope)}`) {
        const invalidatedAfter = z.number().int().nonnegative().safeParse(await bb.storage.kv.get<unknown>(`${invalidationPrefix}${scopeKey(parsed.data.scope)}`));
        scanner.restore(invalidatedAfter.success && parsed.data.generation < invalidatedAfter.data
          ? { ...parsed.data, freshness: "invalidated" } : parsed.data);
        readScope(parsed.data.scope);
      }
    }
    void refreshProjects();
  }
  const conflictTimer = setInterval(() => { void refreshProjects(); }, options.conflictRefreshMs ?? mirrorConfig.conflicts.scanIntervalMs);
  conflictTimer.unref();
  const unsubscribe = bb.sdk.subscribe?.({ event: "system:changed", callback: event => {
    if (event.changes.some(change => change === "plugins-changed" || change === "provider-registrations-changed")) {
      scanner.invalidate(); refreshCachedScopes(); publish();
      for (const scope of scanner.known()) {
        const snapshot = scanner.peek(scope);
        if (!snapshot) continue;
        const key = scopeKey(scope);
        // Independent invalidation keys survive disposal even when queued snapshot writes are cancelled.
        const write = (invalidationWrites.get(key) ?? Promise.resolve()).catch(() => undefined)
          .then(() => bb.storage.kv.set(`${invalidationPrefix}${key}`, snapshot.generation + 1));
        invalidationWrites.set(key, write);
        void write.catch(error => bb.log.error(`Saving Matt discovery invalidation: ${errorMessage(error)}`));
      }
    }
  } });
  bb.onDispose(async () => {
    clearInterval(conflictTimer);
    unsubscribe?.(); scanner.dispose();
    if (timer !== null) clearTimeout(timer);
    lifecycle.abort(new Error("Matt Pocock backend disposed"));
    cachedScopes.clear();
    await Promise.allSettled(invalidationWrites.values());
  });
  bb.log.info(`loaded ${catalog.skills.length} Matt Pocock skills`);
}
