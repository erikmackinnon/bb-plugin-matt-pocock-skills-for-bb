import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Catalog, CanonicalId } from "../shared/catalog.ts";
import {
  catalogStateSchema, globalStateSchema, projectStateSchema, renameLedgerSchema,
  storedStateSchema, updateStatusSchema,
  type ArrivalPolicy, type CatalogState, type RenameLedger, type StoredState,
} from "../shared/state.ts";
import { canonicalIdSchema } from "../shared/catalog.ts";

export function advanceCatalogState({ previous, catalog, arrivalPolicy }: {
  previous: CatalogState | null;
  catalog: Catalog;
  arrivalPolicy: ArrivalPolicy;
}): CatalogState {
  const knownSkills = Object.fromEntries(Object.entries(previous?.knownSkills ?? {})
    .map(([id, skill]) => [id, { ...skill, present: false }]));
  const arrivalChoices = structuredClone(previous?.arrivalChoices ?? {});
  for (const skill of catalog.skills) {
    const known = previous && Object.hasOwn(previous.knownSkills, skill.canonicalId)
      ? previous.knownSkills[skill.canonicalId] : undefined;
    const experimental = skill.bucket === "in-progress";
    if (known && (known.bucket === "in-progress") !== experimental) {
      delete arrivalChoices[skill.canonicalId];
    }
    if (previous && !known && !experimental && arrivalPolicy.newStableSkills === "off") {
      arrivalChoices[skill.canonicalId] = {
        choice: "off", observedAt: catalog.upstream.commit,
        originBucket: skill.bucket === "productivity" ? "productivity" : "engineering",
      };
    }
    knownSkills[skill.canonicalId] = { bucket: skill.bucket, present: true };
  }
  return {
    observedCommit: catalog.upstream.commit,
    knownSkills: Object.fromEntries(Object.entries(knownSkills).sort(([a], [b]) => a.localeCompare(b))),
    arrivalChoices: Object.fromEntries(Object.entries(arrivalChoices).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function renameChains(ledger: RenameLedger): CanonicalId[][] {
  const edges = new Map<CanonicalId, CanonicalId>();
  const predecessors = new Map<CanonicalId, CanonicalId>();
  if (ledger.version === 0 && ledger.mappings.length) throw new Error("Rename mappings require a positive ledger version");
  for (const mapping of ledger.mappings) {
    if (!mapping.evidence.trim()) throw new Error(`Rename ${mapping.from} requires reviewed evidence`);
    if (edges.has(mapping.from)) throw new Error(`Duplicate rename source ${mapping.from}`);
    if (predecessors.has(mapping.to)) throw new Error(`Ambiguous rename convergence at ${mapping.to}`);
    edges.set(mapping.from, mapping.to);
    predecessors.set(mapping.to, mapping.from);
  }
  for (const source of edges.keys()) {
    const visited = new Set<CanonicalId>();
    let current = source;
    while (edges.has(current)) {
      if (visited.has(current)) throw new Error(`Rename cycle at ${current}`);
      visited.add(current);
      const next = edges.get(current);
      if (next === undefined) break;
      current = next;
    }
  }
  const chains: CanonicalId[][] = [];
  for (const source of [...edges.keys()].sort()) {
    if (predecessors.has(source)) continue;
    const chain = [source];
    let next = edges.get(source);
    while (next !== undefined) {
      chain.push(next);
      next = edges.get(next);
    }
    chains.push(chain);
  }
  return chains;
}

export async function loadRenameLedger(path: string | URL = new URL("../compat/renames.json", import.meta.url)): Promise<RenameLedger> {
  const ledger = renameLedgerSchema.parse(JSON.parse(await readFile(path, "utf8")));
  renameChains(ledger);
  return ledger;
}

function copyTerminal<T>(record: Record<CanonicalId, T>, chain: CanonicalId[]) {
  const terminal = chain.at(-1);
  if (terminal === undefined || Object.hasOwn(record, terminal)) return;
  for (const source of chain.slice(0, -1).reverse()) {
    if (Object.hasOwn(record, source)) {
      record[terminal] = structuredClone(record[source]);
      return;
    }
  }
}

export function migrateRenameState({ state, ledger, completedLedger = null }: {
  state: StoredState;
  ledger: RenameLedger;
  completedLedger?: RenameLedger | null;
}): StoredState {
  const fullChains = renameChains(ledger);
  if (completedLedger !== null) {
    renameChains(completedLedger);
    if (completedLedger.version > ledger.version) throw new Error("Rename ledger predates completed migration history");
    const established = new Map(ledger.mappings.map(mapping => [mapping.from, mapping]));
    for (const mapping of completedLedger.mappings) {
      if (!isDeepStrictEqual(established.get(mapping.from), mapping)) {
        throw new Error(`Established rename ${mapping.from} cannot be rewritten or removed`);
      }
    }
    if (completedLedger.version < state.renameMigrationVersion) {
      throw new Error("Rename migration history is older than its completion version");
    }
    if (completedLedger.version === ledger.version && completedLedger.mappings.length !== ledger.mappings.length) {
      throw new Error("New rename mappings require a new ledger version");
    }
  }
  const next = structuredClone(state);
  if (state.renameMigrationVersion >= ledger.version) return next;
  if (state.renameMigrationVersion > 0 && completedLedger === null) {
    throw new Error("Advancing a completed rename migration requires its reviewed ledger history");
  }
  const completedSources = new Set(completedLedger?.mappings.map(mapping => mapping.from) ?? []);
  // Traverse established edges but never reuse their retired source choices.
  const chains = fullChains.map(chain => chain.filter((id, index) => index === chain.length - 1 || !completedSources.has(id)));
  for (const chain of chains) {
    copyTerminal(next.global.skills, chain);
    for (const project of Object.values(next.projects)) {
      copyTerminal(project.skills, chain);
      copyTerminal(project.conflicts, chain);
    }
    copyTerminal(next.catalogState.arrivalChoices, chain);
    copyTerminal(next.catalogState.knownSkills, chain);
    for (const source of chain.slice(0, -1)) {
      if (Object.hasOwn(next.catalogState.knownSkills, source)) {
        next.catalogState.knownSkills[source].present = false;
      }
    }
    const terminal = chain.at(-1);
    if (terminal !== undefined && chain.some(id => next.seenSkills.includes(id))) {
      next.seenSkills.push(terminal);
    }
  }
  next.seenSkills = [...new Set(next.seenSkills)].sort();
  next.renameMigrationVersion = ledger.version;
  return next;
}

export interface MigrationStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
export type SerializeWrites = <T>(operation: () => Promise<T>) => Promise<T>;

export function migrateStoredState({ storage, catalog, ledger, serialize, commit }: {
  storage: MigrationStorage;
  catalog: Catalog;
  ledger: RenameLedger;
  serialize: SerializeWrites;
  commit: (state: StoredState) => void;
}): Promise<StoredState> {
  return serialize(async () => {
    renameChains(ledger);
    async function read<T>(key: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
      const value = await storage.get(key);
      return value === undefined || value === null ? structuredClone(fallback) : schema.parse(value);
    }
    const storedCatalog = await read("catalogState", catalogStateSchema.nullable(), null);
    const completedLedger = await read("renameMigrationLedger", renameLedgerSchema.nullable(), null);
    const global = await read("global", globalStateSchema, {
      enabled: true, skills: {}, arrivalPolicy: { newStableSkills: "bucket-default" },
    });
    const projects: StoredState["projects"] = {};
    for (const key of (await storage.list("project:")).sort()) {
      if (!key.startsWith("project:")) throw new Error(`Invalid project storage key ${key}`);
      Object.defineProperty(projects, key.slice("project:".length), {
        value: await read(key, projectStateSchema, { conflicts: {}, mode: "inherit", enabled: true, skills: {} }),
        enumerable: true, configurable: true, writable: true,
      });
    }
    const initialCatalog = advanceCatalogState({ previous: null, catalog, arrivalPolicy: global.arrivalPolicy });
    const state = storedStateSchema.parse({
      global, projects,
      seenSkills: await read("seenSkills", z.array(canonicalIdSchema), catalog.skills.map(skill => skill.canonicalId)),
      catalogState: storedCatalog ?? initialCatalog,
      renameMigrationVersion: await read("renameMigrationVersion", z.number().int().nonnegative(), 0),
      startHereDismissed: await read("startHereDismissed", z.boolean(), false),
      updateStatus: await read("updateStatus", updateStatusSchema.nullable(), null),
    });
    const next = migrateRenameState({ state, ledger, completedLedger });
    next.catalogState = advanceCatalogState({ previous: next.catalogState, catalog, arrivalPolicy: next.global.arrivalPolicy });
    const values: [string, unknown][] = [
      ["global", next.global],
      ...Object.entries(next.projects).map(([id, project]): [string, unknown] => [`project:${id}`, project]),
      ["seenSkills", next.seenSkills], ["catalogState", next.catalogState],
      ...(state.renameMigrationVersion < ledger.version ? [["renameMigrationLedger", ledger] satisfies [string, unknown]] : []),
      ["renameMigrationVersion", next.renameMigrationVersion],
    ];
    for (const [key, value] of values) {
      if (!isDeepStrictEqual(await storage.get(key), value)) await storage.set(key, value);
    }
    commit(structuredClone(next));
    return structuredClone(next);
  });
}
