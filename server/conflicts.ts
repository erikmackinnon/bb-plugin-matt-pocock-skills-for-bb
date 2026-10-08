import { readdir, readFile, mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { mirrorConfig } from "../mirror.config.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { bbNameSchema, type Catalog } from "../shared/catalog.ts";
import { scopeKey, type ConflictSource, type ScanScope, type ScanSnapshot, type ProviderProbe } from "../shared/conflicts.ts";
import type { ProjectState, ResolvedSkill } from "../shared/state.ts";
import type { SkillSelection } from "./resolve.ts";

export const pluginId = "matt-pocock-skills-for-bb";
export interface SourceRoot {
  path: string;
  scope: ConflictSource["scope"];
  providerId: string | null;
  pluginId?: string;
  active?: boolean;
  recursive?: boolean;
}
export interface Discovery {
  sources: ConflictSource[];
  errors: string[];
  affectedUnknownNames: string[];
}
export type Discover = (scope: ScanScope) => Promise<Discovery>;
const source = (name: string, tier: ConflictSource["scope"], path: string | null,
  providerId: string | null = null, owner: string | null = null, active = true): ConflictSource => ({
  name, scope: tier, path, providerId, pluginId: owner, version: null, active,
  selection: "unknown", evidence: ["Advertised source; session selection is not published"],
});

export async function scanRoots(roots: readonly SourceRoot[], names: readonly string[]): Promise<Discovery> {
  const result: Discovery = { sources: [], errors: [], affectedUnknownNames: [] };
  for (const root of roots) {
    const visited = new Set<string>();
    async function visit(path: string) {
      if (visited.has(path)) return;
      visited.add(path);
      let entries;
      try { entries = await readdir(path, { withFileTypes: true }); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        result.errors.push(`Cannot scan ${path}: ${String(error)}`);
        result.affectedUnknownNames.push(...names);
        return;
      }
      if (entries.some(entry => entry.name === "SKILL.md")) {
        try {
          const text = await readFile(join(path, "SKILL.md"), "utf8");
          const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
          const metadata = z.object({ name: bbNameSchema }).parse(match ? parse(match[1]) : null);
          result.sources.push(source(metadata.name, root.scope, join(path, "SKILL.md"), root.providerId,
            root.pluginId ?? null, root.active ?? true));
        } catch (error) {
          result.errors.push(`Cannot read skill ${path}: ${String(error)}`);
          result.affectedUnknownNames.push(...names);
        }
        return;
      }
      for (const entry of entries) if (entry.isDirectory()) {
        if (root.recursive || path === root.path) await visit(join(path, entry.name));
      }
    }
    await visit(root.path);
  }
  return result;
}

// These roots are for fixture/host adapters. Server discovery uses the host-aware SDK list.
export function nativeRoots(input: { providerId: string; home: string; cwd: string;
  env?: Record<string, string | undefined>; declared?: readonly SourceRoot[] }): SourceRoot[] {
  const { providerId, home, cwd, env = {} } = input;
  if (input.declared) return [...input.declared];
  const user = providerId === "claude-code" ? [join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "skills")]
    : providerId === "codex" ? [join(env.CODEX_HOME ?? join(home, ".codex"), "skills"), join(home, ".agents/skills")]
    : providerId === "pi" ? [join(env.PI_CODING_AGENT_DIR ?? join(home, ".pi/agent"), "skills"), join(home, ".agents/skills")]
    : [];
  const relative = providerId === "claude-code" ? [".claude/skills"]
    : providerId === "codex" ? [".codex/skills", ".agents/skills"]
    : providerId === "pi" ? [".pi/skills", ".agents/skills"] : [];
  const roots: SourceRoot[] = user.map(path => ({ path, scope: "provider-user", providerId, recursive: true }));
  for (let current = resolve(cwd); ; current = dirname(current)) {
    roots.push(...relative.map(path => ({ path: join(current, path), scope: "provider-project" as const, providerId, recursive: true })));
    if (dirname(current) === current) break;
  }
  return roots;
}

const pluginsSchema = z.object({ plugins: z.array(z.object({ id: z.string(), enabled: z.boolean(), rootDir: z.string(),
  version: z.string().nullable(), capabilities: z.array(z.object({ kind: z.string(), id: z.string() })) })) });
const skillsSchema = z.object({ skills: z.array(z.object({ name: z.string(), filePath: z.string(),
  pluginId: z.string().nullable(), provider: z.string().nullable(), scope: z.string() })) });
const commandsSchema = z.object({ commands: z.array(z.object({ name: z.string(), source: z.string() })) });
const tiers: Record<string, ConflictSource["scope"]> = {
  "bb-user": "bb-user", "bb-project": "project", "bb-builtin": "inherited", plugin: "bb-plugin",
  "shared-user": "shared-user", "shared-project": "shared-project",
  "provider-user": "provider-user", "provider-project": "provider-project",
};
export function sdkDiscovery(bb: BbPluginApi, names: readonly string[]): Discover {
  return async scope => {
    const result: Discovery = { sources: [], errors: [], affectedUnknownNames: [] };
    const [plugins, skills, commands] = await Promise.allSettled([
      Promise.resolve().then(() => bb.sdk.plugins.list()).then(value => pluginsSchema.parse(value).plugins),
      Promise.resolve().then(() => bb.sdk.skills.list({ projectId: scope.projectId, environmentId: scope.environmentId })).then(value => skillsSchema.parse(value)),
      Promise.resolve().then(() => bb.sdk.projects.commands({ projectId: scope.projectId, environmentId: scope.environmentId, provider: scope.providerId }))
        .then(value => commandsSchema.parse(value)),
    ]);
    for (const entry of [plugins, skills, commands]) if (entry.status === "rejected") {
      result.errors.push(String(entry.reason)); result.affectedUnknownNames.push(...names);
    }
    if (plugins.status === "fulfilled") for (const plugin of plugins.value) {
      if (plugin.id === pluginId) continue;
      for (const capability of plugin.capabilities) if (capability.kind === "skill" && bbNameSchema.safeParse(capability.id).success) {
        result.sources.push({ ...source(capability.id, "bb-plugin", plugin.rootDir, null, plugin.id, plugin.enabled), version: plugin.version });
      }
    }
    if (skills.status === "fulfilled") for (const skill of skills.value.skills) {
      if (skill.pluginId === pluginId || !bbNameSchema.safeParse(skill.name).success) continue;
      const tier = tiers[skill.scope];
      if (!tier) { result.affectedUnknownNames.push(...names); result.errors.push(`Unknown source tier ${skill.scope}`); continue; }
      const owner = plugins.status === "fulfilled" ? plugins.value.find(plugin => plugin.id === skill.pluginId) : undefined;
      result.sources.push(source(skill.name, skill.pluginId && tier.startsWith("provider-") ? "native-plugin" : tier,
        skill.filePath, skill.provider, skill.pluginId, owner?.enabled ?? true));
      if (tier.startsWith("provider-") && skill.provider === null) result.affectedUnknownNames.push(skill.name);
    }
    if (commands.status === "fulfilled") for (const command of commands.value.commands) {
      if (command.source === "command" && bbNameSchema.safeParse(command.name).success)
        result.sources.push({ ...source(command.name, "command", null, scope.providerId), evidence: ["Invocation ambiguity; command remains available"] });
    }
    return result;
  };
}

export function resolveConflictChoices(input: { catalog: Catalog; selections: readonly SkillSelection[]; project: ProjectState;
  snapshot: ScanSnapshot; bbVersion: string; probes: readonly ProviderProbe[] }) {
  const { catalog, selections, project, snapshot, bbVersion, probes } = input;
  const applicable = snapshot.sources.filter(item => item.pluginId !== pluginId && item.active && item.selection !== "omitted" &&
    (item.providerId === null || item.providerId === snapshot.scope.providerId));
  const unknown = (canonical: string, alias: string) => snapshot.freshness === "invalidated" ||
    (!snapshot.complete && (snapshot.affectedUnknownNames.length === 0 || snapshot.affectedUnknownNames.includes(canonical) || snapshot.affectedUnknownNames.includes(alias)));
  const orderingPassed = bbVersion !== "unknown" && probes.some(probe => probe.requirement === "CMP-204" && probe.status === "passed" &&
    probe.bbVersion === bbVersion && probe.providerId === snapshot.scope.providerId);
  const definitions = new Map(catalog.skills.map(skill => [skill.canonicalId, skill]));
  const rows: ResolvedSkill[] = selections.map(selection => {
    const definition = definitions.get(selection.canonicalId);
    if (!definition) throw new Error(`Unknown selection ${selection.canonicalId}`);
    const choice = project.conflicts[selection.canonicalId] ?? "unresolved";
    const conflicts = applicable.filter(item => item.name === definition.canonicalId);
    const aliasTaken = applicable.some(item => item.name === definition.aliasName);
    const unsupported = conflicts.filter(item => item.scope !== "bb-plugin" || !item.pluginId || item.pluginId.localeCompare(pluginId) <= 0);
    const oursBlockedReason = unknown(definition.canonicalId, definition.aliasName) ? "Discovery is incomplete or invalidated for this name"
      : unsupported.length ? `Keep Matt's canonical is unavailable with ${unsupported.map(item => item.scope).join(", ")}. Use its plugin settings or move your skill yourself`
      : !orderingPassed ? undefined : null;
    let outcome: ResolvedSkill["outcome"] = selection.reason === "off-dependency" ? "blocked" : "yielded";
    let name: string | null = null;
    let reason: string = selection.reason;
    if (selection.active) {
      if (unknown(definition.canonicalId, definition.aliasName)) { outcome = "unknown"; reason = "Discovery is incomplete or invalidated for this name"; }
      else if (choice === "ours" && snapshot.freshness === "stale" && (!orderingPassed || unsupported.length > 0)) {
        outcome = aliasTaken ? "blocked" : "alias-selected";
        name = aliasTaken ? null : definition.aliasName;
        reason = aliasTaken ? "The Matt alias is taken" : "Using the free alias while canonical ownership is rechecked";
      } else if (choice === "theirs") reason = "Saved theirs yields both Matt variants";
      else if (choice === "both") {
        outcome = aliasTaken ? "blocked" : "alias-selected";
        name = aliasTaken ? null : definition.aliasName;
        reason = aliasTaken ? "The Matt alias is taken" : "Free alias selected; the canonical source remains available";
      } else if (choice === "ours" && (!orderingPassed || conflicts.some(item => item.scope !== "bb-plugin" || !item.pluginId || item.pluginId.localeCompare(pluginId) <= 0))) {
        outcome = "blocked"; reason = !orderingPassed ? `CMP-204 ordering has not passed for bb ${bbVersion} and ${snapshot.scope.providerId}`
          : "Keep Matt's canonical is unavailable with this source. Use its plugin settings or move your skill yourself";
      } else if (choice === "unresolved" && conflicts.length > 0) reason = "Same-name sources require a project choice; Matt yields by default";
      else { outcome = "canonical-selected"; name = definition.canonicalId; reason = "Canonical selected from a complete scope"; }
    }
    return { ...selection, active: name !== null, bbName: name, outcome,
      reason: selection.active && name === null ? outcome === "unknown" ? "off-scan" : "off-conflict" : selection.reason,
      conflict: { scope: snapshot.scope, canonicalId: selection.canonicalId, requestedChoice: choice, outcome,
        effectiveName: name, reason, sources: snapshot.sources.filter(item => item.pluginId !== pluginId && (item.providerId === null || item.providerId === snapshot.scope.providerId) &&
          (item.name === definition.canonicalId || item.name === definition.aliasName)),
        snapshotGeneration: snapshot.generation, internalDependencyFor: [], ...(oursBlockedReason === undefined ? {} : { oursBlockedReason }) } };
  });
  return rows;
}

export function resolveConflicts(input: Parameters<typeof resolveConflictChoices>[0]) {
  const { catalog, selections, snapshot } = input;
  const rows = resolveConflictChoices(input);
  const applicable = snapshot.sources.filter(item => item.pluginId !== pluginId && item.active && item.selection !== "omitted" &&
    (item.providerId === null || item.providerId === snapshot.scope.providerId));
  const unknown = (canonical: string, alias: string) => snapshot.freshness === "invalidated" ||
    (!snapshot.complete && (snapshot.affectedUnknownNames.length === 0 || snapshot.affectedUnknownNames.includes(canonical) || snapshot.affectedUnknownNames.includes(alias)));
  const definitions = new Map(catalog.skills.map(skill => [skill.canonicalId, skill]));
  const byId = new Map(rows.map(row => [row.canonicalId, row]));
  // Trial dependency aliases let cycles close. Pruning below removes aliases with no surviving caller.
  for (const row of rows) {
    if (row.outcome !== "yielded" || !selections.find(item => item.canonicalId === row.canonicalId)?.active) continue;
    const skill = definitions.get(row.canonicalId);
    if (!skill || applicable.some(item => item.name === skill.aliasName) || unknown(skill.canonicalId, skill.aliasName)) continue;
    const required = catalog.skills.some(caller => selections.some(item => item.canonicalId === caller.canonicalId && item.active) &&
      caller.dependsOn.some(edge => (edge.kind === "hard" || edge.kind === "conditional-hard") && edge.canonicalId === row.canonicalId));
    if (required) {
      row.active = true; row.bbName = skill.aliasName; row.outcome = "alias-selected";
      row.reason = selections.find(item => item.canonicalId === row.canonicalId)?.reason ?? row.reason;
      row.conflict = { ...row.conflict, outcome: row.outcome, effectiveName: row.bbName, reason: "Internal dependency alias" };
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!row.active) continue;
      const blockedBy = definitions.get(row.canonicalId)?.dependsOn.flatMap(edge =>
        (edge.kind === "hard" || edge.kind === "conditional-hard") && !byId.get(edge.canonicalId)?.active ? [edge.canonicalId] : []) ?? [];
      if (blockedBy.length) {
        row.active = false; row.bbName = null; row.outcome = "blocked"; row.reason = "off-dependency"; row.blockedBy = blockedBy;
        row.conflict = { ...row.conflict, outcome: "blocked", effectiveName: null, reason: `Unavailable dependencies: ${blockedBy.join(", ")}` };
        changed = true;
      }
    }
    const reachable = new Set(rows.filter(row => row.active && row.conflict.reason !== "Internal dependency alias" && row.chosen).map(row => row.canonicalId));
    const pending = [...reachable];
    while (pending.length) {
      const id = pending.pop();
      if (!id) break;
      for (const edge of definitions.get(id)?.dependsOn ?? []) if ((edge.kind === "hard" || edge.kind === "conditional-hard") &&
        byId.get(edge.canonicalId)?.active && !reachable.has(edge.canonicalId)) { reachable.add(edge.canonicalId); pending.push(edge.canonicalId); }
    }
    for (const row of rows) if (row.active && (row.conflict.reason === "Internal dependency alias" || !row.chosen) && !reachable.has(row.canonicalId)) {
      row.active = false; row.bbName = null; row.outcome = "yielded";
      row.conflict = { ...row.conflict, outcome: "yielded", effectiveName: null, reason: "No active Matt caller needs this alias" };
      changed = true;
    }
  }
  for (const row of rows) if (row.active && row.conflict.reason === "Internal dependency alias") {
    const callers = rows.filter(caller => caller.active && definitions.get(caller.canonicalId)?.dependsOn.some(edge =>
      (edge.kind === "hard" || edge.kind === "conditional-hard") && edge.canonicalId === row.canonicalId)).map(caller => caller.canonicalId);
    row.conflict.internalDependencyFor = callers;
  }
  const lines = ["Matt routing reads the selected Matt SKILL.md and stops before execution."];
  for (const row of rows) if (row.active && row.outcome === "alias-selected") {
    lines.push(`when Matt's skills reference ${row.canonicalId}, load ${row.bbName}`);
    if (row.conflict.internalDependencyFor.length) lines.push(`Matt's ${row.canonicalId} runs as ${row.bbName} for ${row.conflict.internalDependencyFor.join(", ")}. Internal plumbing; do not recommend it as an ordinary route.`);
  }
  const yielded = rows.filter(row => !row.active).map(row => row.canonicalId);
  if (yielded.length) lines.push(`Unavailable Matt routes: ${yielded.join(", ")}. ask-matt skips these routes and recommends effective alias invocations.`);
  if (snapshot.scope.providerId.startsWith("acp-")) {
    const userOnly = rows.filter(row => row.active && definitions.get(row.canonicalId)?.userInvoked).map(row => row.bbName);
    if (userOnly.length) lines.push(`Advisory user-only intent (ACP does not enforce it): ${userOnly.join(", ")}. Load only on explicit user request or an explicit Matt workflow call.`);
  }
  return { snapshot, resolved: rows, addendum: lines.join("\n") };
}

export class ConflictScanner {
  private snapshots = new Map<string, ScanSnapshot>();
  private pending = new Map<string, Promise<ScanSnapshot>>();
  private scopes = new Map<string, ScanScope>();
  private revisions = new Map<string, number>();
  private stopped = false;
  private generation = 0;
  private discover: Discover;
  private names: readonly string[];
  private freshnessMs: number;
  private committed: (scope: ScanScope, changed: boolean) => void;
  constructor(discover: Discover, names: readonly string[], committed: (scope: ScanScope, changed: boolean) => void, freshnessMs: number = mirrorConfig.conflicts.freshnessMs) {
    this.discover = discover; this.names = names; this.committed = committed; this.freshnessMs = freshnessMs;
  }
  peek(scope: ScanScope): ScanSnapshot | undefined {
    const snapshot = this.snapshots.get(scopeKey(scope));
    return snapshot ? structuredClone(snapshot) : undefined;
  }
  read(scope: ScanScope): ScanSnapshot | undefined {
    if (this.stopped) return undefined;
    this.scopes.set(scopeKey(scope), structuredClone(scope));
    if (!this.snapshots.has(scopeKey(scope)) && !this.stopped) void this.refresh(scope);
    const key = scopeKey(scope);
    const snapshot = this.snapshots.get(key);
    if (snapshot && snapshot.freshness === "fresh" && Date.now() - Date.parse(snapshot.scannedAt) >= this.freshnessMs) {
      this.snapshots.set(key, { ...snapshot, freshness: "stale" });
      if (!this.stopped) void this.refresh(scope);
    }
    return this.peek(scope);
  }
  known(projectId?: string): ScanScope[] { return [...this.scopes.values()].filter(scope => projectId === undefined || scope.projectId === projectId); }
  async refresh(scope: ScanScope): Promise<ScanSnapshot> {
    const key = scopeKey(scope);
    this.scopes.set(key, structuredClone(scope));
    const pending = this.pending.get(key);
    if (pending) return pending;
    const previous = this.snapshots.get(key);
    if (previous?.freshness === "fresh") this.snapshots.set(key, { ...previous, freshness: "stale" });
    const revision = this.revisions.get(key) ?? 0;
    const operation = Promise.resolve().then(() => this.discover(scope)).catch(error => ({
      sources: [], errors: [String(error)], affectedUnknownNames: [...this.names],
    })).then(discovery => {
      const snapshot: ScanSnapshot = { scope: structuredClone(scope), generation: ++this.generation,
        scannedAt: new Date().toISOString(), freshness: "fresh", complete: discovery.errors.length === 0 && discovery.affectedUnknownNames.length === 0,
        affectedUnknownNames: [...new Set(discovery.affectedUnknownNames)], sources: structuredClone(discovery.sources), errors: [...discovery.errors] };
      if (!this.stopped && revision === (this.revisions.get(key) ?? 0)) {
        const previous = this.snapshots.get(key);
        const evidence = (value: ScanSnapshot) => [value.sources, value.complete, value.affectedUnknownNames, value.errors];
        const changed = !previous || !isDeepStrictEqual(evidence(previous), evidence(snapshot));
        this.snapshots.set(key, snapshot); this.committed(scope, changed);
      }
      return structuredClone(snapshot);
    }).finally(() => {
      this.pending.delete(key);
      if (!this.stopped && this.scopes.has(key) && revision !== (this.revisions.get(key) ?? 0)) void this.refresh(scope);
    });
    this.pending.set(key, operation);
    return operation;
  }
  seedGeneration(generation: number) { this.generation = Math.max(this.generation, generation); }
  restore(snapshot: ScanSnapshot) {
    if (this.stopped) return;
    const key = scopeKey(snapshot.scope);
    this.scopes.set(key, structuredClone(snapshot.scope));
    this.snapshots.set(key, { ...structuredClone(snapshot), freshness: snapshot.freshness === "invalidated" ? "invalidated" : "stale" });
    this.generation = Math.max(this.generation, snapshot.generation);
  }
  retain(projectId: string, applicable: ReadonlySet<string>) {
    for (const scope of this.known(projectId)) {
      const key = scopeKey(scope);
      if (applicable.has(key)) continue;
      this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
      this.snapshots.delete(key); this.scopes.delete(key);
    }
  }
  invalidate() {
    for (const scope of this.known()) {
      const key = scopeKey(scope);
      this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
      const snapshot = this.snapshots.get(key);
      if (snapshot) this.snapshots.set(key, { ...snapshot, freshness: "invalidated" });
      void this.refresh(scope);
    }
  }
  dispose() { this.stopped = true; this.snapshots.clear(); this.scopes.clear(); }
}

export async function installedBbVersion(): Promise<string> {
  try { return (await promisify(execFile)("bb", ["--version"], { timeout: 5000 })).stdout.trim().replace(/^bb\s+/, ""); }
  catch { return "unknown"; }
}

export async function applicableScopes(bb: BbPluginApi, projectId: string): Promise<ScanScope[]> {
  const environments = await bb.sdk.environments.list({ projectId });
  const scopes: ScanScope[] = [];
  for (const environment of environments) {
    if (!environment.hostId) continue;
    const providers = await bb.sdk.providers.list({ environmentId: environment.id });
    scopes.push(...providers.map(provider => ({ projectId, environmentId: environment.id, hostId: environment.hostId, providerId: provider.id })));
  }
  return scopes;
}

export async function createProviderProbeFixture() {
  const root = await mkdtemp(join(tmpdir(), "matt-provider-probe-"));
  const home = join(root, "home"), project = join(root, "project"), injected = join(root, "injected");
  const records = join(root, "records"), temporary = join(root, "tmp");
  for (const directory of [home, project, injected, records, temporary]) await mkdir(directory, { recursive: true });
  async function marker(base: string, name: string, label: string, userOnly = false) {
    const path = join(base, name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Read the disposable probe marker.\n${userOnly ? "disable-model-invocation: true\n" : ""}---\nReturn ${label}. Do not execute a workflow.\n`);
    if (userOnly) {
      await mkdir(join(path, "agents"));
      await writeFile(join(path, "agents/openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
    }
  }
  for (const base of [join(home, ".claude/skills"), join(home, ".codex/skills"), join(home, ".agents/skills")]) {
    await marker(base, "probe-collision", "NATIVE");
    await marker(base, "probe-keep", "KEEP");
  }
  await marker(injected, "probe-collision", "BB");
  await marker(injected, "probe-user-only", "USER_ONLY", true);
  const claudePlugin = join(root, "claude-plugin");
  await mkdir(join(claudePlugin, ".claude-plugin"), { recursive: true });
  await writeFile(join(claudePlugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "bb-global-skills", skills: "./skills" }));
  await symlink(injected, join(claudePlugin, "skills"), "dir");
  return { root, home, project, injected, records, claudePlugin,
    childEnv: { HOME: home, CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"), TMPDIR: temporary } };
}
