import { z } from "zod";
import { bbNameSchema, canonicalIdSchema } from "./catalog.ts";

export const conflictChoiceSchema = z.enum(["unresolved", "theirs", "both", "ours"]);
export type ConflictChoice = z.infer<typeof conflictChoiceSchema>;
export const effectiveOutcomeSchema = z.enum(["canonical-selected", "alias-selected", "yielded", "blocked", "unknown"]);
export type EffectiveOutcome = z.infer<typeof effectiveOutcomeSchema>;
export const conflictSourceSchema = z.strictObject({
  name: bbNameSchema,
  // bb drops both plugin skills that share a name, and a bb user skill overrides a plugin skill.
  scope: z.enum(["bb-plugin", "bb-user"]),
  pluginId: z.string().nullable(), providerId: z.string().nullable(), path: z.string().nullable(),
  version: z.string().nullable(), active: z.boolean(),
  selection: z.enum(["selected", "omitted", "unknown"]), evidence: z.array(z.string()).readonly(),
});
export type ConflictSource = z.infer<typeof conflictSourceSchema>;
/** The one plugin scan shared by every project and provider. */
export const scanSnapshotSchema = z.strictObject({
  generation: z.number().int().nonnegative(), scannedAt: z.string(),
  freshness: z.enum(["fresh", "stale", "invalidated"]), complete: z.boolean(),
  affectedUnknownNames: z.array(bbNameSchema).readonly(), sources: z.array(conflictSourceSchema).readonly(), errors: z.array(z.string()).readonly(),
});
export type ScanSnapshot = z.infer<typeof scanSnapshotSchema>;
export const conflictStateSchema = z.strictObject({
  projectId: z.string(), canonicalId: canonicalIdSchema, requestedChoice: conflictChoiceSchema,
  outcome: effectiveOutcomeSchema, effectiveName: bbNameSchema.nullable(), reason: z.string(),
  sources: z.array(conflictSourceSchema).readonly(), snapshotGeneration: z.number().int().nonnegative().nullable(),
  internalDependencyFor: z.array(canonicalIdSchema).readonly(),
  oursBlockedReason: z.string().nullable().optional(),
});
export type ConflictState = z.infer<typeof conflictStateSchema>;

export const providerProbeSchema = z.strictObject({
  requirement: z.enum(["CMP-201", "CMP-202", "CMP-203", "CMP-204", "CMP-205", "CMP-206", "CMP-207", "CMP-208", "CMP-209", "CMP-210", "CMP-211"]),
  providerId: z.string(), providerVersion: z.string(), model: z.string(), reasoning: z.string(),
  bbVersion: z.string(), status: z.enum(["passed", "failed", "absent", "blocked", "untested"]),
  observedAt: z.string(), evidence: z.array(z.string()).min(1),
});
export type ProviderProbe = z.infer<typeof providerProbeSchema>;
export const conflictsResponseSchema = z.strictObject({
  snapshot: scanSnapshotSchema.nullable(), conflicts: z.array(conflictStateSchema),
});
