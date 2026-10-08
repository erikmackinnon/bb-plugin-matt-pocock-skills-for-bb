import type { CatalogSkill } from "./catalog.ts";
import type { ArrivalChoice, Choice, GlobalState, ProjectState, ResolvedSkill } from "./state.ts";

export interface DefaultChoiceInput {
  skill: Pick<CatalogSkill, "canonicalId" | "bucket">;
  global: GlobalState;
  project: ProjectState | null;
  arrivalChoice: ArrivalChoice | null;
}

export interface DefaultChoiceResult {
  choice: Choice;
  choiceSource: ResolvedSkill["choiceSource"];
}

export type DefaultChoiceResolver = (input: DefaultChoiceInput) => DefaultChoiceResult;

export const resolveDefaultChoice: DefaultChoiceResolver = ({ skill, global, project, arrivalChoice }) => {
  if (project?.mode === "custom" && Object.hasOwn(project.skills, skill.canonicalId)) {
    return { choice: project.skills[skill.canonicalId], choiceSource: "project" };
  }
  if (Object.hasOwn(global.skills, skill.canonicalId)) {
    return { choice: global.skills[skill.canonicalId], choiceSource: "global" };
  }
  if (skill.bucket !== "in-progress" && arrivalChoice !== null) {
    return { choice: arrivalChoice.choice, choiceSource: "arrival" };
  }
  return { choice: skill.bucket === "in-progress" ? "off" : "on", choiceSource: "bucket" };
};
