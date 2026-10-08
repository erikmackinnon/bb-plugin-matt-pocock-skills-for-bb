import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { canonicalIdSchema, catalogSchema } from "./catalog.ts";
import { conflictChoiceSchema, scanSnapshotSchema, conflictsResponseSchema, providerProbeSchema } from "./conflicts.ts";
import { arrivalChoiceSchema, globalStateSchema, projectStateSchema, resolvedSkillSchema, scopeSchema, toggleSchema, updateStatusSchema } from "./state.ts";

export * from "./state.ts";
export * from "./conflicts.ts";
export { STATE_CHANGED } from "./events.ts";

const okSchema = z.strictObject({ ok: z.literal(true) });
export const stateResponseSchema = z.strictObject({
  installedPluginVersion: z.string().optional(),
  deliveryScopes: z.array(z.strictObject({ snapshot: scanSnapshotSchema, resolved: z.array(resolvedSkillSchema) })).optional(),
  catalog: catalogSchema, global: globalStateSchema, project: projectStateSchema.nullable(),
  resolved: z.array(resolvedSkillSchema),
  projects: z.array(z.strictObject({
    id: z.string(), name: z.string(), mode: z.enum(["inherit", "custom"]), enabled: z.boolean(),
  })),
  prerequisites: z.record(z.string(), z.boolean()), update: updateStatusSchema.nullable(), startHereDismissed: z.boolean(),
  newSkillIds: z.array(canonicalIdSchema).optional(), arrivalChoices: z.record(canonicalIdSchema, arrivalChoiceSchema).optional(),
});
export type StateResponse = z.infer<typeof stateResponseSchema>;

export const conflictRpcContract = defineRpcContract({
  matt_pocock_conflicts: {
    input: z.strictObject({ projectId: z.string(), refresh: z.boolean().default(false) }),
    output: conflictsResponseSchema,
  },
  matt_pocock_resolve: {
    input: z.strictObject({ projectId: z.string(), canonicalId: canonicalIdSchema, choice: conflictChoiceSchema }),
    output: okSchema,
  },
});

export const probeRpcContract = defineRpcContract({
  matt_pocock_record_probe: { input: providerProbeSchema, output: okSchema },
});

export const rpcContract = defineRpcContract({
  matt_pocock_state: {
    input: z.strictObject({ scope: scopeSchema }), output: stateResponseSchema,
  },
  matt_pocock_set_skills: {
    input: z.strictObject({
      scope: scopeSchema,
      changes: z.array(z.strictObject({ canonicalId: canonicalIdSchema, value: toggleSchema.nullable() })),
      cascade: z.boolean().default(false),
    }),
    output: z.strictObject({ resolved: z.array(resolvedSkillSchema) }),
  },
  matt_pocock_set_master: {
    input: z.strictObject({ scope: scopeSchema, enabled: z.boolean() }), output: okSchema,
  },
  matt_pocock_set_project_mode: {
    input: z.strictObject({ projectId: z.string(), mode: z.enum(["inherit", "custom"]) }), output: okSchema,
  },
  matt_pocock_set_arrival_policy: {
    input: z.strictObject({ value: z.enum(["bucket-default", "off"]) }), output: okSchema,
  },
  matt_pocock_dismiss_start_here: {
    input: z.strictObject({ dismissed: z.boolean() }), output: okSchema,
  },
  matt_pocock_mark_seen: { input: z.null(), output: okSchema },
  matt_pocock_check_updates: { input: z.null(), output: updateStatusSchema },
});
