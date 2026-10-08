import { z } from "zod";
import { mirrorConfig } from "../mirror.config.ts";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { conflictChoiceSchema, type ConflictChoice } from "../shared/conflicts.ts";
import { canonicalIdSchema } from "../shared/catalog.ts";
import type { rpcContract, conflictRpcContract, StateResponse } from "../shared/rpc.ts";
import type { ResolvedSkill, Scope } from "./resolve.ts";
import { errorMessage } from "./updates.ts";

const commandSchema = z.enum(["status", "list", "enable", "disable", "inherit", "check-updates", "conflicts", "resolve"]);
type Command = z.infer<typeof commandSchema>;
const commandUsage = {
  conflicts: "bb matt-pocock-skills-for-bb conflicts [--project <id>] [--json]",
  resolve: "bb matt-pocock-skills-for-bb resolve <id> --choice theirs|both|ours [--project <id>] [--json]",
  status: "bb matt-pocock-skills-for-bb status [--json]",
  list: "bb matt-pocock-skills-for-bb list [--project <id>] [--json]",
  enable: "bb matt-pocock-skills-for-bb enable <id...> [--project <id>] [--json]",
  disable: "bb matt-pocock-skills-for-bb disable <id...> [--project <id>] [--cascade] [--json]",
  inherit: "bb matt-pocock-skills-for-bb inherit --project <id> [--json]",
  "check-updates": "bb matt-pocock-skills-for-bb check-updates [--json]",
} satisfies Record<Command, string>;
const summaries = {
  conflicts: "Refresh conflict sources and scoped outcomes", resolve: "Save a project conflict choice",
  status: "Show plugin and update status", list: "List Matt Pocock selections and project delivery",
  enable: "Choose skills to enable", disable: "Disable skills, optionally cascading to dependents",
  inherit: "Make a project use the global settings again", "check-updates": "Check upstream main and plugin releases",
} satisfies Record<Command, string>;
const usage = `Usage:\n${Object.values(commandUsage).map(line => `  ${line}`).join("\n")}`;
const updateCommand = "bb plugin update matt-pocock-skills-for-bb";
const onOff = (value: boolean) => value ? "on" : "off";

function parseArguments(command: Command, args: readonly string[], projectId?: string) {
  let scope: Scope = { kind: "global" };
  let cascade = false;
  let choice: ConflictChoice | undefined;
  const ids: string[] = [];
  const options = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      if (options.has(arg)) throw new Error(`Duplicate option ${arg}`);
      options.add(arg);
    }
    if (arg === "--json") continue;
    if (arg === "--project") {
      const projectId = args[++index];
      if (!projectId || projectId.startsWith("-") || projectId.trim() !== projectId || !projectId.trim()) {
        throw new Error("--project requires one nonblank project id");
      }
      scope = { kind: "project", projectId };
    } else if (arg === "--choice") {
      if (command !== "resolve") throw new Error("--choice is only valid with resolve");
      const parsed = conflictChoiceSchema.exclude(["unresolved"]).safeParse(args[++index]);
      if (!parsed.success) throw new Error("--choice requires theirs, both, or ours");
      choice = parsed.data;
    } else if (arg === "--cascade") cascade = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else ids.push(arg);
  }
  if (cascade && command !== "disable") throw new Error("--cascade is only valid with disable");
  if ((command === "status" || command === "check-updates") && scope.kind === "project") {
    throw new Error(`--project is not valid with ${command}`);
  }
  if (command === "inherit" && scope.kind !== "project") throw new Error(commandUsage.inherit);
  if (command === "conflicts" || command === "resolve") {
    if (scope.kind === "global" && projectId) scope = { kind: "project", projectId };
    if (scope.kind !== "project") throw new Error("Conflict commands require --project or a current bb project");
  }
  if (command === "resolve" && (!choice || ids.length !== 1)) throw new Error(commandUsage.resolve);
  if (command === "enable" || command === "disable" || command === "resolve") {
    if (ids.length === 0) throw new Error(commandUsage[command]);
    for (const id of ids) {
      if (!canonicalIdSchema.safeParse(id).success) throw new Error(`Invalid canonical skill id: ${id}`);
    }
    if (new Set(ids).size !== ids.length) throw new Error("Skill ids must not be repeated");
  } else if (ids.length !== 0) throw new Error(commandUsage[command]);
  return { scope, cascade, ids, choice };
}

function selectionFor(state: StateResponse, scope: Scope, skill: ResolvedSkill) {
  const enabled = state.project?.mode === "custom" ? state.project.enabled : state.global.enabled;
  const explicit = scope.kind === "global" ? skill.choiceSource === "global" : skill.choiceSource === "project";
  const reason = !enabled ? "off-master"
    : skill.blockedBy.length > 0 ? "off-dependency"
    : skill.neededBy.length > 0 ? "on-required"
    : skill.chosen ? explicit ? "on-explicit" : "on-inherited"
    : explicit ? "off-explicit" : "off-inherited";
  return {
    chosen: skill.chosen, choiceSource: skill.choiceSource,
    active: enabled && skill.blockedBy.length === 0 && (skill.chosen || skill.neededBy.length > 0),
    reason, neededBy: skill.neededBy, blockedBy: skill.blockedBy,
  };
}

function listRows(state: StateResponse, scope: Scope) {
  const byId = new Map(state.catalog.skills.map(skill => [skill.canonicalId, skill]));
  return state.resolved.map(skill => {
    const catalogSkill = byId.get(skill.canonicalId);
    if (!catalogSkill) throw new Error(`Resolved skill is missing from the catalog: ${skill.canonicalId}`);
    const selection = selectionFor(state, scope, skill);
    const deliveries = scope.kind === "global" ? [] : (state.deliveryScopes ?? []).flatMap(deliveryScope => {
      const delivery = deliveryScope.resolved.find(row => row.canonicalId === skill.canonicalId);
      return delivery ? [{
        scope: deliveryScope.snapshot.scope, providerId: deliveryScope.snapshot.scope.providerId,
        bbName: delivery.bbName, outcome: delivery.outcome, active: delivery.active,
        requestedChoice: delivery.conflict.requestedChoice, reason: delivery.reason,
        conflictReason: delivery.conflict.reason,
      }] : [];
    });
    return {
      ...skill,
      ...(scope.kind === "global" ? { active: selection.active, reason: selection.reason } : {}),
      aliasName: catalogSkill.aliasName, bucket: catalogSkill.bucket,
      defaultEnabled: catalogSkill.defaultEnabled, userInvoked: catalogSkill.userInvoked,
      outputKind: scope.kind === "global" ? "global-selection" : "project-selection-and-delivery",
      selectionScope: scope, selection, deliveries,
    };
  });
}

function listText(state: StateResponse, scope: Scope) {
  const heading = scope.kind === "global"
    ? "Global selection. Bucket defaults and saved choices; project delivery is evaluated per provider."
    : `Project ${scope.projectId}. Selection changes apply to new sessions; delivery is shown per provider.`;
  const rows = listRows(state, scope).map(skill => {
    const selection = skill.selection;
    const lines = [
      `${skill.canonicalId}: alias=${skill.aliasName}; bucket=${skill.bucket}; default=${onOff(skill.defaultEnabled)}; user-only intent=${skill.userInvoked ? "yes" : "no"}`,
      `  Selection: chosen=${onOff(selection.chosen)}; active=${onOff(selection.active)}; source=${selection.choiceSource}; reason=${selection.reason}; required by=${selection.neededBy.join(", ") || "none"}; blocked by=${selection.blockedBy.join(", ") || "none"}`,
    ];
    if (scope.kind === "project") {
      if (skill.deliveries.length === 0) {
        lines.push(`  Delivery: provider=unknown; scan pending; name=${skill.bbName ?? "none"}; active=${onOff(skill.active)}; outcome=${skill.outcome}; requested=${skill.conflict.requestedChoice}; reason=${skill.reason}; ${skill.conflict.reason}`);
      }
      for (const delivery of skill.deliveries) {
        const context = delivery.scope;
        lines.push(`  Delivery: project=${context.projectId}; provider=${delivery.providerId}; environment=${context.environmentId}; host=${context.hostId}; name=${delivery.bbName ?? "none"}; active=${onOff(delivery.active)}; outcome=${delivery.outcome}; requested=${delivery.requestedChoice}; reason=${delivery.reason}; ${delivery.conflictReason}`);
      }
    }
    return lines.join("\n");
  });
  return [heading, ...rows].join("\n");
}

export function registerCli(bb: BbPluginApi, handlers: PluginRpcHandlers<typeof rpcContract & typeof conflictRpcContract>) {
  bb.cli.register({
    name: mirrorConfig.identity.cliName, summary: "Manage Matt Pocock skills globally or per project",
    commands: commandSchema.options.map(name => ({ name, summary: summaries[name], usage: commandUsage[name] })),
    async run(argv, context) {
      const json = argv.includes("--json");
      const reply = (value: unknown, text: string) => ({ exitCode: 0, stdout: json ? JSON.stringify(value) : text });
      try {
        const [name, ...args] = argv;
        if (name === undefined || name === "help" || name === "--help") {
          if (args.some(arg => arg !== "--json") || args.length > 1) throw new Error(usage);
          return reply({ usage }, usage);
        }
        const parsedCommand = commandSchema.safeParse(name);
        if (!parsedCommand.success) throw new Error(`Unknown command ${name}\n${usage}`);
        const command = parsedCommand.data;
        const { scope, cascade, ids, choice } = parseArguments(command, args, context?.projectId);
        switch (command) {
          case "conflicts":
          case "resolve": {
            if (scope.kind !== "project") throw new Error("A project is required");
            if (command === "resolve") {
              if (!choice) throw new Error(commandUsage.resolve);
              await handlers.matt_pocock_resolve({ projectId: scope.projectId, canonicalId: ids[0], choice });
            }
            const result = await handlers.matt_pocock_conflicts({ projectId: scope.projectId, refresh: command === "conflicts" });
            return reply(result, [
              `Project ${scope.projectId}. Changes apply to new sessions; menu entries are static advertisements.`,
              ...(result.snapshots.length === 0 ? ["Discovery pending"] : []),
              ...result.snapshots.map(snapshot => `Scope ${JSON.stringify(snapshot.scope)}: ${snapshot.freshness}; complete=${snapshot.complete}; scanned=${snapshot.scannedAt}; errors=${snapshot.errors.join("; ") || "none"}`),
              ...result.conflicts.map(row => `${row.canonicalId}: scope=${JSON.stringify(row.scope)}; requested=${row.requestedChoice}; outcome=${row.outcome}; name=${row.effectiveName ?? "none"}; ${row.reason}; sources=${JSON.stringify(row.sources)}; internal callers=${row.internalDependencyFor.join(", ") || "none"}`),
            ].join("\n"));
          }
          case "status": {
            const state = await handlers.matt_pocock_state({ scope });
            const active = state.resolved.filter(skill => selectionFor(state, scope, skill).active).length;
            return reply(state, [
              `Installed bb plugin version: ${state.installedPluginVersion ?? state.update?.installedPluginVersion ?? "unknown"}`,
              `Bundled Matt Pocock skills ${state.catalog.upstream.version}`,
              "Matt's plugin manifest version at this commit",
              `Bundled SHA: ${state.catalog.upstream.commit}`,
              `Upstream committed date: ${state.catalog.upstream.committedAt}`,
              `Global selection: master=${onOff(state.global.enabled)}; active=${active}/${state.resolved.length}; project delivery is evaluated per provider`,
              `Latest bb plugin version: ${state.update?.latestPluginVersion ?? "unknown"}`,
              `Latest upstream main SHA: ${state.update?.latestUpstreamCommit ?? "unknown"}`,
              `Upstream main commits listed before the bundled SHA: ${state.update?.upstreamAheadCount ?? "unknown"}`,
              "The main-history list count does not establish ancestry.",
              ...(state.update?.error ? [`Update error: ${state.update.error}`] : []),
              `Update command: ${updateCommand}`,
            ].join("\n"));
          }
          case "list": {
            const state = await handlers.matt_pocock_state({ scope });
            return reply(listRows(state, scope), listText(state, scope));
          }
          case "enable":
          case "disable": {
            const value = command === "enable" ? "on" : "off";
            const result = await handlers.matt_pocock_set_skills({ scope, changes: ids.map(canonicalId => ({ canonicalId, value })), cascade });
            const label = scope.kind === "global" ? "Global" : `Project ${scope.projectId}`;
            return reply(result, `${label} selection saved: ${ids.join(", ")}=${value}${cascade ? "; cascade applied to chosen dependents" : ""}. Changes apply to new sessions.\n${result.resolved.map(skill => `${skill.canonicalId}: chosen=${onOff(skill.chosen)}; required by=${skill.neededBy.join(", ") || "none"}; blocked by=${skill.blockedBy.join(", ") || "none"}`).join("\n")}`);
          }
          case "inherit": {
            if (scope.kind !== "project") throw new Error(commandUsage.inherit);
            await handlers.matt_pocock_set_project_mode({ projectId: scope.projectId, mode: "inherit" });
            return reply({ ok: true }, `Project ${scope.projectId} now uses the global Matt Pocock settings. Changes apply to new sessions.`);
          }
          case "check-updates": {
            const result = await handlers.matt_pocock_check_updates(null);
            return reply(result, [
              `Latest Matt Pocock main commit: ${result.latestUpstreamCommit ?? "unknown"}`,
              `Upstream main commits listed before the bundled SHA: ${result.upstreamAheadCount ?? "unknown"}`,
              "The main-history list count does not establish ancestry.",
              `Latest bb plugin version: ${result.latestPluginVersion ?? "unknown"}`,
              ...(result.error ? [`Update error: ${result.error}`] : []),
              `Update command: ${updateCommand}`,
            ].join("\n"));
          }
        }
      } catch (error) {
        const message = errorMessage(error);
        return json ? { exitCode: 1, stdout: JSON.stringify({ error: message }) } : { exitCode: 1, stderr: message };
      }
    },
  });
}
