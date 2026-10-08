import type { Catalog, CanonicalId } from "../shared/catalog.ts";
import { resolveDefaultChoice } from "../shared/defaults.ts";
import type { CatalogState, Choice, GlobalState, ProjectState, ResolvedSkill } from "../shared/state.ts";

export type { GlobalState, ProjectState, ResolvedSkill, Scope } from "../shared/state.ts";
type SkillChange = { canonicalId: CanonicalId; value: Choice | null };
export type SkillSelection = Pick<ResolvedSkill, "canonicalId" | "chosen" | "choiceSource" | "active" | "reason" | "neededBy" | "blockedBy">;

export function defaultGlobal(): GlobalState {
  return { enabled: true, skills: {}, arrivalPolicy: { newStableSkills: "bucket-default" } };
}

export function defaultProject(): ProjectState {
  return { mode: "inherit", enabled: true, skills: {}, conflicts: {} };
}

function choices(catalog: Catalog, global: GlobalState, project: ProjectState | null, catalogState: CatalogState | null) {
  return new Map(catalog.skills.map(skill => [skill.canonicalId, resolveDefaultChoice({
    skill, global, project,
    arrivalChoice: catalogState && Object.hasOwn(catalogState.arrivalChoices, skill.canonicalId)
      ? catalogState.arrivalChoices[skill.canonicalId] : null,
  })]));
}

function dependencyClosures(catalog: Catalog): Map<CanonicalId, Set<CanonicalId>> {
  const skills = new Map(catalog.skills.map(skill => [skill.canonicalId, skill]));
  const closures = new Map<CanonicalId, Set<CanonicalId>>();
  for (const skill of catalog.skills) {
    const visited = new Set<CanonicalId>();
    const pending = [skill.canonicalId];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined || visited.has(id)) continue;
      visited.add(id);
      const dependency = skills.get(id);
      if (dependency) pending.push(...dependency.dependsOn.flatMap(edge =>
        edge.kind === "hard" || edge.kind === "conditional-hard" ? [edge.canonicalId] : []));
    }
    closures.set(skill.canonicalId, visited);
  }
  return closures;
}

export function resolveSkillSelections(
  catalog: Catalog, global: GlobalState, project: ProjectState | null, catalogState: CatalogState | null = null,
): SkillSelection[] {
  const chosen = choices(catalog, global, project, catalogState);
  const closures = dependencyClosures(catalog);
  const skills = new Map(catalog.skills.map(skill => [skill.canonicalId, skill]));
  const enabled = project?.mode === "custom" ? project.enabled : global.enabled;
  const blockers = new Map<CanonicalId, CanonicalId[]>();
  const active = new Set<CanonicalId>();
  for (const [id, closure] of closures) {
    const blockedBy = [...closure].filter(dependencyId => {
      const dependency = skills.get(dependencyId);
      const choice = chosen.get(dependencyId);
      return !dependency || (dependency.bucket === "in-progress" &&
        (!choice || choice.choice !== "on" || (choice.choiceSource !== "global" && choice.choiceSource !== "project")));
    });
    blockers.set(id, blockedBy);
    if (enabled && chosen.get(id)?.choice === "on" && blockedBy.length === 0) {
      for (const dependencyId of closure) active.add(dependencyId);
    }
  }
  return catalog.skills.map(skill => {
    const id = skill.canonicalId;
    const choice = chosen.get(id);
    if (!choice) throw new Error(`Missing choice for ${id}`);
    const isExplicit = project === null ? choice.choiceSource === "global" : choice.choiceSource === "project";
    const blockedBy = enabled && choice.choice === "on" ? blockers.get(id) ?? [] : [];
    const neededBy = enabled && choice.choice === "off" && active.has(id)
      ? catalog.skills.filter(caller => caller.canonicalId !== id && active.has(caller.canonicalId) &&
        closures.get(caller.canonicalId)?.has(id)).map(caller => caller.canonicalId) : [];
    const reason: ResolvedSkill["reason"] = !enabled ? "off-master"
      : blockedBy.length > 0 ? "off-dependency"
      : neededBy.length > 0 ? "on-required"
      : choice.choice === "on" ? isExplicit ? "on-explicit" : "on-inherited"
      : isExplicit ? "off-explicit" : "off-inherited";
    return { canonicalId: id, chosen: choice.choice === "on", choiceSource: choice.choiceSource,
      active: active.has(id), reason, neededBy, blockedBy };
  });
}

export function resolveSkills(
  catalog: Catalog, global: GlobalState, project: ProjectState | null,
  _seenSkills: readonly CanonicalId[], catalogState: CatalogState | null = null,
): ResolvedSkill[] {
  return resolveSkillSelections(catalog, global, project, catalogState).map(selection => ({
    ...selection,
    bbName: null, outcome: "unknown", active: false,
    reason: selection.active ? "off-scan" : selection.reason,
    conflict: {
      scope: { projectId: "unscanned", providerId: "unscanned", environmentId: "unscanned", hostId: "unscanned" },
      canonicalId: selection.canonicalId,
      requestedChoice: project && Object.hasOwn(project.conflicts, selection.canonicalId)
        ? project.conflicts[selection.canonicalId] : "unresolved",
      outcome: "unknown", effectiveName: null,
      reason: "Delivery is resolved separately for each project, provider, environment and host.", sources: [],
      snapshotGeneration: null, internalDependencyFor: [],
    },
  }));
}

export function applySkillChanges(
  catalog: Catalog, global: GlobalState, project: ProjectState | null,
  _seenSkills: readonly CanonicalId[], changes: readonly SkillChange[], cascade: boolean,
  catalogState: CatalogState | null = null,
): Record<CanonicalId, Choice> {
  const ids = new Set(catalog.skills.map(skill => skill.canonicalId));
  for (const change of changes) {
    if (!ids.has(change.canonicalId)) throw new Error(`Unknown skill: ${change.canonicalId}`);
  }
  const next = { ...(project === null ? global.skills : project.skills) };
  for (const { canonicalId: id, value } of changes) {
    if (value === null) delete next[id];
    else Object.defineProperty(next, id, { value, writable: true, enumerable: true, configurable: true });
  }
  if (cascade) {
    const offIds = new Set(changes.filter(({ value }) => value === "off").map(({ canonicalId }) => canonicalId));
    if (offIds.size > 0) {
      const chosen = choices(catalog, global, project, catalogState);
      const closures = dependencyClosures(catalog);
      for (const [id, choice] of chosen) {
        if (choice.choice === "on" && [...offIds].some(offId => closures.get(id)?.has(offId))) offIds.add(id);
      }
      // Requested cascade OFF wins over simultaneous ON and reset edits.
      for (const id of offIds) Object.defineProperty(next, id, { value: "off", writable: true, enumerable: true, configurable: true });
    }
  }
  return next;
}
