import type { z } from "zod";
import type { rpcContract, scopeSchema } from "../../shared/rpc";
import type { CatalogSkill, Bucket } from "../../shared/catalog";
import { resolveDefaultChoice } from "../../shared/defaults";

export type MattState = z.infer<typeof rpcContract.matt_pocock_state.output>;
export type Scope = z.infer<typeof scopeSchema>;
export type ResolvedSkill = MattState["resolved"][number];
export const BUCKET_LABELS: Record<Bucket, string> = {
  engineering: "Engineering",
  productivity: "Productivity",
  "in-progress": "In-progress",
};

export function matchesSkillSearch(skill: CatalogSkill, effectiveNames: readonly string[], query: string): boolean {
  return [skill.canonicalId, skill.aliasName, skill.displayName, skill.description, ...effectiveNames]
    .join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

export function planOptIn(state: MattState, ids: readonly string[]) {
  const closure = dependencies(state.catalog.skills, ids);
  const selected = new Set([...ids, ...closure]);
  const experimental = state.catalog.skills
    .filter((skill) => selected.has(skill.canonicalId) && skill.bucket === "in-progress")
    .map((skill) => skill.canonicalId);
  return {
    ids: [...ids], dependencies: closure, experimental,
    blockedExperimental: experimental.filter((id) => !state.resolved.find((skill) => skill.canonicalId === id)?.chosen),
  };
}

/** Traverse catalog edges with cycle protection; the server owns resolution. */
export function dependencies(skills: readonly CatalogSkill[], ids: readonly string[]): string[] {
  const byId = new Map(skills.map((skill) => [skill.canonicalId, skill]));
  const visited = new Set(ids);
  const result = new Set<string>();
  const visit = (id: string) => {
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (dependency.kind !== "hard" && dependency.kind !== "conditional-hard") continue;
      const target = dependency.canonicalId;
      if (visited.has(target) || !byId.has(target)) continue;
      visited.add(target);
      result.add(target);
      visit(target);
    }
  };
  ids.forEach(visit);
  return [...result];
}

/** All active dependents, including indirect users of a dependency. */
export function activeDependents(state: MattState, ids: string[]): string[] {
  const removed = new Set(ids);
  return state.resolved
    .filter(
      (skill) =>
        (skill.active || skill.chosen) &&
        !removed.has(skill.canonicalId) &&
        dependencies(state.catalog.skills, [skill.canonicalId]).some((id) =>
          removed.has(id),
        ),
    )
    .map((skill) => skill.canonicalId);
}

export function differsFromGlobal(
  state: MattState,
  skill: CatalogSkill,
): boolean {
  const override =
    state.project?.mode === "custom" && Object.hasOwn(state.project.skills, skill.canonicalId)
      ? state.project.skills[skill.canonicalId]
      : undefined;
  if (override === undefined) return false;
  const resolved = state.resolved.find((item) => item.canonicalId === skill.canonicalId);
  const globalChoice =
    (Object.hasOwn(state.global.skills, skill.canonicalId) ? state.global.skills[skill.canonicalId] : undefined) ??
    (resolved?.choiceSource === "arrival" ? "off" : skill.defaultEnabled ? "on" : "off");
  return override !== globalChoice;
}

export function newerRelease(
  latest: string | null,
  installed: string,
): boolean {
  if (!latest) return false;
  const parse = (version: string) =>
    /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  const next = parse(latest);
  const current = parse(installed);
  if (!next || !current) return false;
  for (let index = 0; index < 3; index++) {
    if (next[index] !== current[index]) return next[index]! > current[index]!;
  }
  return false;
}

export type TurnOffPlan = {
  ids: string[];
  kept: { id: string; users: string[] }[];
  dependents: string[];
};

/** Preview the non-cascade result from the chosen roots, not orphaned dependencies. */
export function planTurnOff(state: MattState, ids: string[]): TurnOffPlan {
  const active = new Set(
    state.resolved.filter((skill) => skill.active || skill.chosen).map((skill) => skill.canonicalId),
  );
  const requested = [...new Set(ids)].filter((id) => active.has(id));
  const removed = new Set(requested);
  const remainingRoots = state.resolved
    .filter(
      (skill) =>
        skill.active &&
        skill.reason !== "on-required" &&
        !removed.has(skill.canonicalId),
    )
    .map((skill) => skill.canonicalId);
  const remaining = new Set([
    ...remainingRoots,
    ...dependencies(state.catalog.skills, remainingRoots),
  ]);
  const kept = requested
    .filter((id) => remaining.has(id))
    .map((id) => ({
      id,
      users: state.catalog.skills
        .filter(
          (skill) =>
            skill.canonicalId !== id &&
            remaining.has(skill.canonicalId) &&
            dependencies(state.catalog.skills, [skill.canonicalId]).includes(id),
        )
        .map((skill) => skill.canonicalId),
    }));
  return {
    ids: requested,
    kept,
    dependents: activeDependents(state, requested),
  };
}

export function turnOffCopy(plan: TurnOffPlan) {
  const kept = plan.kept.length;
  const total = plan.ids.length;
  const users = [...new Set(plan.kept.flatMap(item => item.users))];
  const userNames = users.length < 2 ? users.join("") : `${users.slice(0, -1).join(", ")} and ${users.at(-1)}`;
  return {
    title: "Some of these skills are used by others",
    body: total === 1 ? `${plan.ids[0]} is used by ${userNames}, which ${users.length === 1 ? "is" : "are"} on.`
      : `${kept} of the ${total} skills you're turning off are used by skills that are still on. Turning them off would break those skills.`,
    keep: total === kept ? "Save off; keep on while needed" : `Turn off ${total - kept}; keep ${kept} that others need`,
    cascade: `Turn off ${total === 1 ? plan.ids[0] : `these ${total}`} and the ${plan.dependents.length} ${plan.dependents.length === 1 ? "skill" : "skills"} that use ${total === 1 ? "it" : "them"}`,
  };
}

export function secondaryName(skill: CatalogSkill): string | null {
  const normalized = (value: string) =>
    value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return normalized(skill.displayName) === normalized(skill.canonicalId)
    ? null
    : skill.displayName;
}

export function keptOnText(users: readonly string[]): string {
  const first = users[0];
  if (!first) return "Kept on, used by active skills";
  return `Kept on, used by ${first}${users.length > 1 ? ` and ${users.length - 1} more` : ""}`;
}

export type ProjectChoice = "inherit" | "on" | "off";
export function projectChoice(project: MattState["project"]): ProjectChoice {
  return project?.mode === "custom"
    ? project.enabled
      ? "on"
      : "off"
    : "inherit";
}

export function projectSuffix(
  project: MattState["projects"][number],
): string {
  // Always show the effective state; mark projects that just follow the default.
  const state = project.enabled ? "on" : "off";
  return project.mode === "inherit" ? `${state} (default)` : state;
}

export function activitySummary(
  state: Pick<MattState, "global" | "projects">,
): string {
  const enabled = state.global.enabled;
  const base = enabled ? "On by default" : "Off by default";
  const exceptions = state.projects.filter(
    (project) => project.mode === "custom" && project.enabled !== enabled,
  );
  if (exceptions.length === 0) return base;
  if (enabled)
    return `${base} · off in ${exceptions.length} ${exceptions.length === 1 ? "project" : "projects"}`;
  return `${base} · on in ${exceptions.length === 1 ? exceptions[0]?.name : `${exceptions.length} projects`}`;
}

/** With the default switched off, preview its configured skill set for editing. */
export function defaultSkillSet(state: MattState): MattState {
  return configuredSkillSet({ ...state, project: null });
}

/** Preview switching a following project On, including any saved overrides. */
export function projectOnSkillSet(state: MattState): MattState {
  return configuredSkillSet({
    ...state,
    project: {
      mode: "custom",
      enabled: true,
      skills: state.project?.skills ?? {},
      conflicts: state.project?.conflicts ?? {},
    },
  });
}

export function configuredSkillSet(state: MattState): MattState {
  const byId = new Map(state.catalog.skills.map((skill) => [skill.canonicalId, skill]));
  const choices = new Map(
    state.catalog.skills.map((skill) => {
      const choice = resolveDefaultChoice({
        skill, global: state.global, project: state.project,
        arrivalChoice: state.arrivalChoices && Object.hasOwn(state.arrivalChoices, skill.canonicalId)
          ? state.arrivalChoices[skill.canonicalId] : null,
      });
      if (choice.choiceSource === "bucket" && skill.bucket !== "in-progress" &&
        state.resolved.find((item) => item.canonicalId === skill.canonicalId)?.choiceSource === "arrival") {
        return [skill.canonicalId, "off"];
      }
      return [skill.canonicalId, choice.choice];
    }),
  );
  const chosen = state.catalog.skills
    .filter((skill) => choices.get(skill.canonicalId) === "on")
    .map((skill) => skill.canonicalId);
  const active = new Set<string>();
  const blocked = new Map<string, string[]>();
  for (const id of chosen) {
    const closure = dependencies(state.catalog.skills, [id]);
    const unavailable = closure.filter((dependency) =>
      byId.get(dependency)?.bucket === "in-progress" && choices.get(dependency) !== "on",
    );
    if (unavailable.length > 0) blocked.set(id, unavailable);
    else [id, ...closure].forEach((dependency) => active.add(dependency));
  }
  return {
    ...state,
    resolved: state.resolved.map((skill) => {
      const on = choices.get(skill.canonicalId) === "on";
      const required = !on && active.has(skill.canonicalId);
      const explicit =
        state.project === null
          ? Object.hasOwn(state.global.skills, skill.canonicalId)
          : state.project.mode === "custom" &&
            Object.hasOwn(state.project.skills, skill.canonicalId);
      return {
        ...skill,
        chosen: on,
        active: active.has(skill.canonicalId),
        blockedBy: blocked.get(skill.canonicalId) ?? [],
        reason: blocked.has(skill.canonicalId)
          ? "off-dependency"
          : required
          ? "on-required"
          : on
            ? explicit
              ? "on-explicit"
              : "on-inherited"
            : explicit
              ? "off-explicit"
              : "off-inherited",
        neededBy: required
          ? state.catalog.skills
              .filter(
                (user) =>
                  user.canonicalId !== skill.canonicalId &&
                  active.has(user.canonicalId) &&
                  dependencies(state.catalog.skills, [user.canonicalId]).includes(
                    skill.canonicalId,
                  ),
              )
              .map((user) => user.canonicalId)
          : [],
      };
    }),
  };
}
