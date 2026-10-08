import { z } from "zod";
import { bbNameSchema, bucketSchema, canonicalIdSchema, commitShaSchema, stableBucketSchema } from "./catalog.ts";
import { conflictChoiceSchema, conflictStateSchema, effectiveOutcomeSchema } from "./conflicts.ts";

export const toggleSchema = z.enum(["on", "off"]);
export type Choice = z.infer<typeof toggleSchema>;
export const arrivalPolicySchema = z.strictObject({ newStableSkills: z.enum(["bucket-default", "off"]) });
export type ArrivalPolicy = z.infer<typeof arrivalPolicySchema>;
export const globalStateSchema = z.strictObject({
  enabled: z.boolean(), skills: z.record(canonicalIdSchema, toggleSchema), arrivalPolicy: arrivalPolicySchema,
});
export type GlobalState = z.infer<typeof globalStateSchema>;
export const projectStateSchema = z.strictObject({
  conflicts: z.record(canonicalIdSchema, conflictChoiceSchema), mode: z.enum(["inherit", "custom"]),
  enabled: z.boolean(), skills: z.record(canonicalIdSchema, toggleSchema),
});
export type ProjectState = z.infer<typeof projectStateSchema>;
export const arrivalChoiceSchema = z.strictObject({
  choice: z.literal("off"), observedAt: commitShaSchema, originBucket: stableBucketSchema,
});
export type ArrivalChoice = z.infer<typeof arrivalChoiceSchema>;
export const knownSkillSchema = z.strictObject({ bucket: bucketSchema, present: z.boolean() });
export type KnownSkill = z.infer<typeof knownSkillSchema>;
export const catalogStateSchema = z.strictObject({
  observedCommit: commitShaSchema, knownSkills: z.record(canonicalIdSchema, knownSkillSchema),
  arrivalChoices: z.record(canonicalIdSchema, arrivalChoiceSchema),
});
export type CatalogState = z.infer<typeof catalogStateSchema>;
export const updateStatusSchema = z.strictObject({
  bundledCommit: commitShaSchema, bundledUpstreamVersion: z.string(), installedPluginVersion: z.string(),
  latestPluginVersion: z.string().nullable(), latestUpstreamCommit: commitShaSchema.nullable(),
  upstreamAheadCount: z.number().int().nonnegative().nullable(), checkedAt: z.string(), error: z.string().nullable(),
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;
export const storedStateSchema = z.strictObject({
  global: globalStateSchema, projects: z.record(z.string(), projectStateSchema),
  seenSkills: z.array(canonicalIdSchema), catalogState: catalogStateSchema,
  renameMigrationVersion: z.number().int().nonnegative(), startHereDismissed: z.boolean(),
  updateStatus: updateStatusSchema.nullable(),
});
export type StoredState = z.infer<typeof storedStateSchema>;
export const renameLedgerSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  mappings: z.array(z.strictObject({ from: canonicalIdSchema, to: canonicalIdSchema, evidence: z.string() })).readonly(),
});
export type RenameLedger = z.infer<typeof renameLedgerSchema>;
export const resolvedReasonSchema = z.enum([
  "on-explicit", "on-inherited", "on-required", "off-explicit", "off-inherited", "off-master",
  "off-dependency", "off-conflict", "off-scan",
]);
export const choiceSourceSchema = z.enum(["project", "global", "arrival", "bucket"]);
export const resolvedSkillSchema = z.strictObject({
  canonicalId: canonicalIdSchema, bbName: bbNameSchema.nullable(), outcome: effectiveOutcomeSchema,
  conflict: conflictStateSchema, chosen: z.boolean(), choiceSource: choiceSourceSchema,
  active: z.boolean(), reason: resolvedReasonSchema, neededBy: z.array(canonicalIdSchema).readonly(), blockedBy: z.array(canonicalIdSchema).readonly(),
});
export type ResolvedSkill = z.infer<typeof resolvedSkillSchema>;
export const scopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), projectId: z.string() }),
]);
export type Scope = z.infer<typeof scopeSchema>;
