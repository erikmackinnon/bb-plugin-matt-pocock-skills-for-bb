import { mirrorConfig } from "../mirror.config.ts";
import { z } from "zod";
import { commitShaSchema, type Catalog } from "../shared/catalog.ts";
import type { updateStatusSchema } from "../shared/rpc.ts";

export type UpdateStatus = z.infer<typeof updateStatusSchema>;
export type Fetch = typeof fetch;
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function initialUpdate(): null {
  return null;
}

/** One shared ten-second budget, including pagination and the release request. */
export async function fetchUpdates(catalog: Catalog, version: string, fetcher: Fetch = fetch, signal?: AbortSignal): Promise<UpdateStatus> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error("GitHub update check timed out after 10s")), 10_000);
  const result: UpdateStatus = {
    bundledCommit: catalog.upstream.commit, bundledUpstreamVersion: catalog.upstream.version,
    installedPluginVersion: version, latestUpstreamCommit: null, upstreamAheadCount: null,
    latestPluginVersion: null, checkedAt: new Date().toISOString(), error: null,
  };
  const errors: string[] = [];
  async function abortable<T>(action: () => Promise<T>): Promise<T> {
    if (controller.signal.aborted) throw controller.signal.reason;
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try { return await Promise.race([action(), aborted]); }
    finally { controller.signal.removeEventListener("abort", onAbort); }
  }
  async function get(path: string, missingOk = false): Promise<unknown> {
    const response = await abortable(() => fetcher(`https://api.github.com${path}`, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json", "User-Agent": mirrorConfig.identity.pluginId, "X-GitHub-Api-Version": "2022-11-28" },
    }));
    if (missingOk && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
    return abortable(() => response.json());
  }
  try {
    await Promise.all([
      (async () => {
        try {
          const bundledCommit = commitShaSchema.parse(catalog.upstream.commit);
          let ahead = 0;
          for (let page = 1; page <= 100; page++) {
            const commits = z.array(z.object({ sha: commitShaSchema })).max(100).parse(await get(`/repos/${mirrorConfig.upstream.repo}/commits?sha=main&per_page=100&page=${page}`));
            if (page === 1) {
              const head = commits[0];
              if (!head) throw new Error("Upstream main history is empty; ahead count is unknown");
              result.latestUpstreamCommit = head.sha;
              if (head.sha === bundledCommit) { result.upstreamAheadCount = 0; return; }
            }
            const index = commits.findIndex(commit => commit.sha === bundledCommit);
            if (index >= 0) { result.upstreamAheadCount = ahead + index; return; }
            ahead += commits.length;
            if (commits.length < 100) break;
          }
          throw new Error("Bundled Matt Pocock commit was not found in upstream history; ahead count is unknown");
        } catch (error) { errors.push(errorMessage(error)); }
      })(),
      (async () => {
        try {
          // 404 means no visible release yet (none published, or the repo is
          // private). That's a normal state, not a failed check.
          const raw = await get(`/repos/${mirrorConfig.mirror.repo}/releases/latest`, true);
          if (raw === null) return;
          const release = z.object({ tag_name: z.string().min(1).max(256).refine(tag => tag.replace(/^v/u, "").trim().length > 0) }).parse(raw);
          result.latestPluginVersion = release.tag_name.replace(/^v/u, "");
        } catch (error) { errors.push(errorMessage(error)); }
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
  result.checkedAt = new Date().toISOString();
  result.error = errors.length ? errors.join("; ").slice(0, 2000) : null;
  return result;
}
