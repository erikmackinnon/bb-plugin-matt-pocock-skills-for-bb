import { mirrorConfig } from "../mirror.config.ts";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, delimiter, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseDocument } from "yaml";
import { bbNameSchema, catalogSchema, type Catalog } from "../shared/catalog.ts";

/** Works from both the source entry and dist/server.js; never depends on cwd. */
export async function findPluginRoot(start = dirname(fileURLToPath(import.meta.url))): Promise<string> {
  let directory = start;
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (pkg.name === mirrorConfig.identity.packageName) return directory;
    } catch { /* Continue toward the root. */ }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Cannot locate matt-pocock-skills-for-bb package.json");
    directory = parent;
  }
}

export async function loadCatalog(path: string): Promise<Catalog> {
  return catalogSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

const ATTRIBUTION = mirrorConfig.upstream.attribution;
export async function loadRuntimeNote(path: string): Promise<string | null> {
  let note: string;
  try { note = (await readFile(path, "utf8")).trim(); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!note) return null;
  if (note.split(/\s+/u).length > 250) throw new Error("Matt Pocock runtime note exceeds 250 words");
  const contribution = `${ATTRIBUTION}\n${note}`;
  if (contribution.length > 4096) throw new Error("Matt Pocock runtime note exceeds the 4096-character instruction budget");
  return contribution;
}

const registrationSchema = z.object({
  name: bbNameSchema,
  description: z.string().min(1).max(1024).refine(value => value.trim().length > 0),
  "disable-model-invocation": z.boolean().optional(),
});

/** Match generated names to the actual manifest skill frontmatter, fail safely. */
export async function registeredSkillNames(root: string, catalog: Catalog): Promise<Set<string>> {
  let bundleRoot: string;
  try { bundleRoot = await realpath(join(root, mirrorConfig.paths.bundleRoot, "skills")); }
  catch { return new Set(); }
  const names = await Promise.all(catalog.skills.flatMap(skill => [skill.canonicalId, skill.aliasName].map(async candidate => {
    try {
      const path = await realpath(join(bundleRoot, skill.bucket, candidate, "SKILL.md"));
      const location = relative(bundleRoot, path);
      if (isAbsolute(location) || location === ".." || location.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) return null;
      const text = await readFile(path, "utf8");
      const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1];
      if (frontmatter === undefined) return null;
      const document = parseDocument(frontmatter, { uniqueKeys: true });
      if (document.errors.length) return null;
      const fields = registrationSchema.parse(document.toJS({ maxAliasCount: 0 }));
      return fields.name === candidate && fields.description === skill.description &&
        (fields["disable-model-invocation"] === true) === skill.userInvoked ? fields.name : null;
    } catch { return null; }
  })));
  return new Set(names.filter((name): name is string => name !== null));
}

/** Presence on the server's PATH. No shell, execution, or global settings writes. */
export async function detectPrerequisites({
  catalog, path = process.env.PATH ?? "", activeCanonicalIds, tracker, conditionalCommands = new Set<string>(),
}: {
  catalog: Catalog;
  path?: string;
  activeCanonicalIds?: ReadonlySet<string>;
  tracker?: keyof typeof mirrorConfig.prerequisites.trackerCommands;
  conditionalCommands?: ReadonlySet<string>;
}): Promise<Record<string, boolean>> {
  const active = activeCanonicalIds ?? new Set(catalog.skills.filter(skill => skill.defaultEnabled).map(skill => skill.canonicalId));
  const trackerCommand = tracker ? mirrorConfig.prerequisites.trackerCommands[tracker] : null;
  const tools = new Set<string>();
  for (const skill of catalog.skills) {
    if (!active.has(skill.canonicalId)) continue;
    for (const prerequisite of skill.prereqs) {
      if (prerequisite.kind !== "command") continue;
      const name = prerequisite.name;
      if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) continue;
      if (name === "gh" || name === "glab") {
        if (name === trackerCommand) tools.add(name);
      } else if (prerequisite.when === "always" || conditionalCommands.has(name)) tools.add(name);
    }
  }
  const entries = path.split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  return Object.fromEntries(await Promise.all([...tools].sort().map(async tool => {
    for (const entry of entries) for (const extension of extensions) {
      try {
        const candidate = join(entry, `${tool}${extension}`);
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) return [tool, true];
      }
      catch { /* Try the next PATH entry. */ }
    }
    return [tool, false];
  })));
}
