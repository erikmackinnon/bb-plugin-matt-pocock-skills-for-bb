import { z } from "zod";
import { mirrorConfig } from "../mirror.config.ts";

export const BUCKETS = mirrorConfig.selection.buckets;
export const bucketSchema = z.enum(BUCKETS);
export const stableBucketSchema = z.enum(["engineering", "productivity"]);
export const bbNameSchema = z.string().min(1).max(mirrorConfig.skillNames.maxLength).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$(?![\s\S])/);
export const canonicalIdSchema = bbNameSchema;
export const relativePathSchema = z.string().min(1).refine((path) =>
  !path.includes("\\") && !path.includes("\0") && !/^[A-Za-z]:/.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "Expected a normalized relative POSIX path",
);
export const sha256Schema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
export const commitShaSchema = z.string().length(40).regex(/^[a-f0-9]{40}$/);
export type CanonicalId = z.infer<typeof canonicalIdSchema>;
export type BbName = z.infer<typeof bbNameSchema>;
export type RelativePath = z.infer<typeof relativePathSchema>;
export type Sha256 = z.infer<typeof sha256Schema>;
export type CommitSha = z.infer<typeof commitShaSchema>;
export type Bucket = z.infer<typeof bucketSchema>;
export type StableBucket = z.infer<typeof stableBucketSchema>;

export const sourceAnchorSchema = z.strictObject({
  path: relativePathSchema, line: z.number().int().positive(), text: z.string(),
});
export type SourceAnchor = z.infer<typeof sourceAnchorSchema>;
export const skillDependencySchema = z.union([
  z.strictObject({
    kind: z.enum(["hard", "conditional-hard"]),
    canonicalId: canonicalIdSchema, evidence: z.array(sourceAnchorSchema).readonly(),
  }),
  z.strictObject({
    kind: z.enum(["recommendation", "presence-check"]),
    canonicalId: canonicalIdSchema, evidence: z.array(sourceAnchorSchema).readonly(),
  }),
  z.strictObject({
    kind: z.literal("dynamic"), source: z.enum(["ticket-notes", "receiving-agent-advice"]),
    evidence: z.array(sourceAnchorSchema).readonly(),
  }),
]);
export type SkillDependency = z.infer<typeof skillDependencySchema>;
const prerequisiteWhenSchema = z.enum(["always", "conditional"]);
export const prerequisiteSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("command"), name: z.string(), when: prerequisiteWhenSchema }),
  z.strictObject({
    kind: z.literal("capability"),
    name: z.enum(["skill-loading", "delegation", "browser", "human-terminal"]),
    when: prerequisiteWhenSchema,
  }),
  z.strictObject({ kind: z.literal("project-file"), path: z.string(), when: prerequisiteWhenSchema }),
]);
export type Prerequisite = z.infer<typeof prerequisiteSchema>;

export const catalogSkillSchema = z.strictObject({
  canonicalId: canonicalIdSchema,
  aliasName: bbNameSchema,
  bucket: bucketSchema,
  defaultEnabled: z.boolean(),
  sourcePath: relativePathSchema,
  displayName: z.string(),
  description: z.string().max(1024).refine((text) => text.trim().length > 0, "Description must be nonblank"),
  userInvoked: z.boolean(),
  prereqs: z.array(prerequisiteSchema).readonly(),
  dependsOn: z.array(skillDependencySchema).readonly(),
  requiredBy: z.array(canonicalIdSchema).readonly(),
  hasScripts: z.boolean(),
  upstreamHash: sha256Schema,
  compatRules: z.strictObject({ canonical: z.array(z.string()).readonly(), alias: z.array(z.string()).readonly() }),
}).superRefine((skill, ctx) => {
  if (skill.aliasName !== `${mirrorConfig.skillNames.aliasPrefix}${skill.canonicalId}`) {
    ctx.addIssue({ code: "custom", path: ["aliasName"], message: "Alias must use the canonical ID with the matt-pocock- prefix" });
  }
  if (skill.sourcePath !== `skills/${skill.bucket}/${skill.canonicalId}`) {
    ctx.addIssue({ code: "custom", path: ["sourcePath"], message: "Source path must match the bucket and canonical ID" });
  }
  if (skill.defaultEnabled !== mirrorConfig.defaults.buckets[skill.bucket]) {
    ctx.addIssue({ code: "custom", path: ["defaultEnabled"], message: "Default must match the bucket policy" });
  }
  if (mirrorConfig.selection.excludeSkills.some((path) => path === skill.sourcePath)) {
    ctx.addIssue({ code: "custom", path: ["sourcePath"], message: "Excluded skill source path" });
  }
});
export type CatalogSkill = z.infer<typeof catalogSkillSchema>;
export const upstreamIdentitySchema = z.strictObject({
  repo: z.literal(mirrorConfig.upstream.repo), ref: z.literal(mirrorConfig.upstream.ref), commit: commitShaSchema,
  version: z.string(), committedAt: z.string(), license: z.literal(mirrorConfig.upstream.license), author: z.string(),
});
export type UpstreamIdentity = z.infer<typeof upstreamIdentitySchema>;
export const catalogSchema = z.strictObject({
  schemaVersion: z.literal(1), upstream: upstreamIdentitySchema, skills: z.array(catalogSkillSchema).max(Math.floor(mirrorConfig.skillNames.maxCandidates / 2)).readonly(),
}).superRefine((catalog, ctx) => {
  const canonicalIds = new Set(catalog.skills.map((skill) => skill.canonicalId));
  const candidates = new Set<string>();
  for (const [index, skill] of catalog.skills.entries()) {
    for (const key of ["canonicalId", "aliasName"] as const) {
      if (candidates.has(skill[key])) {
        ctx.addIssue({ code: "custom", path: ["skills", index, key], message: "Duplicate skill name candidate" });
      }
      candidates.add(skill[key]);
    }
    for (const [edgeIndex, edge] of skill.dependsOn.entries()) {
      if (edge.kind !== "dynamic" && !canonicalIds.has(edge.canonicalId)) {
        ctx.addIssue({ code: "custom", path: ["skills", index, "dependsOn", edgeIndex, "canonicalId"], message: "Unknown dependency" });
      }
    }
    for (const [edgeIndex, id] of skill.requiredBy.entries()) {
      if (!canonicalIds.has(id)) {
        ctx.addIssue({ code: "custom", path: ["skills", index, "requiredBy", edgeIndex], message: "Unknown dependent" });
      }
    }
  }
});
export type Catalog = z.infer<typeof catalogSchema>;

const permissionModeSchema = z.number().int().min(0).max(0o7777);
const sourcePathSchema = relativePathSchema.refine((path) =>
  /^skills\/(engineering|productivity|in-progress)\/[a-z0-9]+(?:-[a-z0-9]+)*$(?![\s\S])/.test(path) &&
  !mirrorConfig.selection.excludeSkills.some((excluded) => excluded === path),
  "Expected an included skill source path",
);
export const mirrorLockSchema = z.strictObject({
  schemaVersion: z.literal(1), upstreamCommit: commitShaSchema, upstreamVersion: z.string(),
  files: z.record(relativePathSchema, sha256Schema).readonly(),
  fileModes: z.record(relativePathSchema, permissionModeSchema).readonly(),
  directoryModes: z.record(relativePathSchema, permissionModeSchema).readonly(),
  skills: z.record(canonicalIdSchema, z.strictObject({ sourcePath: sourcePathSchema, upstreamHash: sha256Schema })).readonly(),
}).superRefine((lock, ctx) => {
  const roots: string[] = [];
  for (const [id, skill] of Object.entries(lock.skills)) {
    if (skill.sourcePath.split("/").at(-1) !== id) {
      ctx.addIssue({ code: "custom", path: ["skills", id, "sourcePath"], message: "Source path must match the canonical ID" });
    }
    roots.push(skill.sourcePath);
    roots.push(`${skill.sourcePath.slice(0, skill.sourcePath.lastIndexOf("/") + 1)}${mirrorConfig.skillNames.aliasPrefix}${id}`);
  }
  for (const key of ["files", "fileModes", "directoryModes"] as const) {
    for (const path of Object.keys(lock[key])) {
      const insideSkill = roots.some((root) => path.startsWith(`${root}/`));
      const ancestorDirectory = key === "directoryModes" && roots.some((root) => root === path || root.startsWith(`${path}/`));
      const supportFile = key !== "directoryModes" && mirrorConfig.selection.supportFiles.some((file) => file === path);
      if (!insideSkill && !ancestorDirectory && !supportFile) {
        ctx.addIssue({ code: "custom", path: [key, path], message: "Path is outside the included skill folders and support allowlist" });
      }
    }
  }
});
export type MirrorLock = z.infer<typeof mirrorLockSchema>;
