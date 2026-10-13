import { mkdtemp, mkdir, readdir, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { mirrorConfig } from "../mirror.config.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { bbNameSchema, type Catalog } from "../shared/catalog.ts";
import type { ConflictSource, ScanSnapshot, ProviderProbe } from "../shared/conflicts.ts";
import type { ProjectState, ResolvedSkill } from "../shared/state.ts";
import type { SkillSelection } from "./resolve.ts";

export const pluginId = "matt-pocock-skills-for-bb";
export interface Discovery {
  sources: ConflictSource[];
  errors: string[];
  affectedUnknownNames: string[];
}
export type Discover = () => Promise<Discovery>;

// bb itself removes a Matt skill in two global cases: another plugin's same-name skill (bb drops
// both) and a bb user skill (it overrides plugin skills). Both are read once per scan, never per
// project, environment, or provider. Project .bb/skills and provider-native skills are not
// detected: the first is per workspace, and providers keep native copies alongside bb's.
// See compat/AUDIT.md.
const pluginsSchema = z.object({ plugins: z.array(z.object({ id: z.string(), enabled: z.boolean(), rootDir: z.string(),
  version: z.string().nullable(), capabilities: z.array(z.object({ kind: z.string(), id: z.string() })) })) });
export function bbSkillDiscovery(bb: BbPluginApi, names: readonly string[], warn: (message: string) => void = () => {}): Discover {
  return async () => {
    const result: Discovery = { sources: [], errors: [], affectedUnknownNames: [] };
    let plugins;
    try { plugins = pluginsSchema.parse(await bb.sdk.plugins.list()).plugins; }
    catch (error) { return { sources: [], errors: [String(error)], affectedUnknownNames: [...names] }; }
    for (const plugin of plugins) {
      if (plugin.id === pluginId) continue;
      for (const capability of plugin.capabilities) if (capability.kind === "skill" && bbNameSchema.safeParse(capability.id).success) {
        result.sources.push({ name: capability.id, scope: "bb-plugin", path: plugin.rootDir, providerId: null, pluginId: plugin.id,
          version: plugin.version, active: plugin.enabled, selection: "unknown", evidence: ["Advertised plugin skill; session selection is not published"] });
      }
    }
    let dataDir: string | undefined;
    try { dataDir = bb.server.experimental_dataDir; } catch { dataDir = undefined; }
    // An older bb without the API still gets plugin detection rather than holding every skill back.
    if (!dataDir) { warn("bb does not expose its data directory; bb user skills are not checked for same-name clashes"); return result; }
    const user = await userSkills(join(dataDir, "skills"));
    if ("error" in user) return { ...result, errors: [user.error], affectedUnknownNames: [...names] };
    result.sources.push(...user.sources);
    return result;
  };
}

/** One level of <dataDir>/skills/<folder>/SKILL.md; the frontmatter name wins over the folder name. */
export async function userSkills(root: string): Promise<{ sources: ConflictSource[] } | { error: string }> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { sources: [] };
    return { error: `Cannot read bb user skills at ${root}: ${String(error)}` };
  }
  const sources: ConflictSource[] = [];
  for (const entry of entries) if (!entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink())) {
    const path = join(root, entry.name, "SKILL.md");
    let text;
    try { text = await readFile(path, "utf8"); } catch { continue; }
    let declared: unknown;
    try { declared = parse(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? "")?.name; } catch { declared = undefined; }
    const name = [declared, entry.name].find(value => bbNameSchema.safeParse(value).success) as string | undefined;
    if (name) sources.push({ name, scope: "bb-user", path, providerId: null, pluginId: null, version: null, active: true,
      selection: "unknown", evidence: ["bb user skill; it overrides plugin skills with the same name"] });
  }
  return { sources };
}

export function resolveConflictChoices(input: { catalog: Catalog; selections: readonly SkillSelection[]; projectId: string; project: ProjectState;
  snapshot: ScanSnapshot; bbVersion: string; probes: readonly ProviderProbe[] }) {
  const { catalog, selections, projectId, project, snapshot, bbVersion, probes } = input;
  const applicable = snapshot.sources.filter(item => item.pluginId !== pluginId && item.active && item.selection !== "omitted");
  const unknown = (canonical: string, alias: string) => snapshot.freshness === "invalidated" ||
    (!snapshot.complete && (snapshot.affectedUnknownNames.length === 0 || snapshot.affectedUnknownNames.includes(canonical) || snapshot.affectedUnknownNames.includes(alias)));
  // Plugin ordering is bb's own resolver, so a passing probe on any provider covers this bb version.
  const orderingPassed = bbVersion !== "unknown" && probes.some(probe => probe.requirement === "CMP-204" && probe.status === "passed" &&
    probe.bbVersion === bbVersion);
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
        outcome = "blocked"; reason = !orderingPassed ? `CMP-204 ordering has not passed for bb ${bbVersion}`
          : "Keep Matt's canonical is unavailable with this source. Use its plugin settings or move your skill yourself";
      } else if (choice === "unresolved" && conflicts.length > 0) reason = "Same-name sources require a project choice; Matt yields by default";
      else { outcome = "canonical-selected"; name = definition.canonicalId; reason = "Canonical selected from a complete scope"; }
    }
    return { ...selection, active: name !== null, bbName: name, outcome,
      reason: selection.active && name === null ? outcome === "unknown" ? "off-scan" : "off-conflict" : selection.reason,
      conflict: { projectId, canonicalId: selection.canonicalId, requestedChoice: choice, outcome,
        effectiveName: name, reason, sources: snapshot.sources.filter(item => item.pluginId !== pluginId &&
          (item.name === definition.canonicalId || item.name === definition.aliasName)),
        snapshotGeneration: snapshot.generation, internalDependencyFor: [], ...(oursBlockedReason === undefined ? {} : { oursBlockedReason }) } };
  });
  return rows;
}

/** `providerId` only shapes the addendum: ACP agents get an advisory user-only note. */
export function resolveConflicts(input: Parameters<typeof resolveConflictChoices>[0] & { providerId?: string }) {
  const { catalog, selections, snapshot, providerId } = input;
  const rows = resolveConflictChoices(input);
  const applicable = snapshot.sources.filter(item => item.pluginId !== pluginId && item.active && item.selection !== "omitted");
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
  if (providerId?.startsWith("acp-")) {
    const userOnly = rows.filter(row => row.active && definitions.get(row.canonicalId)?.userInvoked).map(row => row.bbName);
    if (userOnly.length) lines.push(`Advisory user-only intent (ACP does not enforce it): ${userOnly.join(", ")}. Load only on explicit user request or an explicit Matt workflow call.`);
  }
  return { snapshot, resolved: rows, addendum: lines.join("\n") };
}

/**
 * The one plugin scan every project and provider shares. A failed rescan keeps delivering the last
 * complete scan, adding any clashes it did see, so new threads keep their skills.
 */
export class PluginScan {
  private current: ScanSnapshot | undefined;
  private lastComplete: ScanSnapshot | undefined;
  private pending: Promise<ScanSnapshot | undefined> | null = null;
  private again = false;
  /** Bumped by invalidate(); a scan that started before the bump is obsolete. */
  private revision = 0;
  private retry: { attempt: number; timer: ReturnType<typeof setTimeout> | null } = { attempt: 0, timer: null };
  private stopped = false;
  private generation = 0;
  private discover: Discover;
  private names: readonly string[];
  private committed: (snapshot: ScanSnapshot) => void;
  private retryMs: { baseMs: number; maxMs: number };
  /**
   * `committed` runs for every committed scan. Each follows a stale or invalidated one, so even
   * identical sources can change delivery (for example, stale saved "ours" falls back to its alias).
   */
  constructor(discover: Discover, names: readonly string[], committed: (snapshot: ScanSnapshot) => void,
    retryMs: { baseMs: number; maxMs: number } = mirrorConfig.conflicts.retryMs) {
    this.discover = discover; this.names = names; this.committed = committed; this.retryMs = retryMs;
  }
  /** The snapshot delivery should use, or undefined before any scan. */
  read(): ScanSnapshot | undefined {
    const snapshot = this.current, held = this.lastComplete;
    if (!snapshot || !held || (snapshot.complete && snapshot.freshness !== "invalidated")) return snapshot ? structuredClone(snapshot) : undefined;
    const heldKeys = new Set(held.sources.map(item => JSON.stringify(item)));
    const sources = [...held.sources, ...snapshot.sources.filter(item => !heldKeys.has(JSON.stringify(item)))];
    return structuredClone({ ...snapshot, freshness: "stale", complete: true, affectedUnknownNames: [], sources });
  }
  /** Rescans now. A request during a scan reruns once, after it. */
  refresh(): Promise<ScanSnapshot | undefined> {
    if (this.pending) { this.again = true; return this.pending; }
    if (this.current?.freshness === "fresh") this.current = { ...this.current, freshness: "stale" };
    const revision = this.revision;
    this.pending = Promise.resolve().then(() => this.discover()).catch(error => ({
      sources: [], errors: [String(error)], affectedUnknownNames: [...this.names],
    })).then(discovery => {
      // Plugins changed mid-scan: drop this result; the queued rerun replaces it.
      if (this.stopped || revision !== this.revision) return this.read();
      const snapshot: ScanSnapshot = { generation: ++this.generation, scannedAt: new Date().toISOString(), freshness: "fresh",
        complete: discovery.errors.length === 0 && discovery.affectedUnknownNames.length === 0,
        affectedUnknownNames: [...new Set(discovery.affectedUnknownNames)], sources: structuredClone(discovery.sources), errors: [...discovery.errors] };
      this.current = snapshot;
      if (snapshot.complete) this.lastComplete = snapshot;
      this.scheduleRetry(!snapshot.complete);
      this.committed(structuredClone(snapshot));
      return structuredClone(snapshot);
    }).finally(() => {
      this.pending = null;
      if (this.again && !this.stopped) { this.again = false; void this.refresh(); }
    });
    return this.pending;
  }
  /** Marks the scan out of date, then rescans. */
  invalidate() {
    this.revision++;
    if (this.current) this.current = { ...this.current, freshness: "invalidated" };
    void this.refresh();
  }
  private scheduleRetry(failed: boolean) {
    if (this.retry.timer) clearTimeout(this.retry.timer);
    if (!failed) { this.retry = { attempt: 0, timer: null }; return; }
    const attempt = this.retry.attempt;
    const timer = setTimeout(() => { if (!this.stopped) void this.refresh(); }, Math.min(this.retryMs.baseMs * 2 ** attempt, this.retryMs.maxMs));
    timer.unref?.();
    this.retry = { attempt: attempt + 1, timer };
  }
  restore(snapshot: ScanSnapshot) {
    if (this.stopped) return;
    this.current = { ...structuredClone(snapshot), freshness: "stale" };
    if (snapshot.complete) this.lastComplete = this.current;
    this.generation = Math.max(this.generation, snapshot.generation);
  }
  dispose() {
    this.stopped = true;
    if (this.retry.timer) clearTimeout(this.retry.timer);
    this.current = undefined; this.lastComplete = undefined;
  }
}

export async function installedBbVersion(): Promise<string> {
  try { return (await promisify(execFile)("bb", ["--version"], { timeout: 5000 })).stdout.trim().replace(/^bb\s+/, ""); }
  catch { return "unknown"; }
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
