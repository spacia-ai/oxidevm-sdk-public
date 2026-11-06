import type { BootProgress } from "./contracts.js";
import { fetchPinnedBytes } from "./pinned-assets.js";

/** The downloads of one engine load; see `engineLoad`. */
export type EngineLoad = ReturnType<typeof engineLoad>;

/**
 * One engine load: its pinned files download at once, under one cancellation that follows `signal`. `report` hears one
 * `asset: "engine"` count for the whole load, the bytes received against every file's pinned size, with a file
 * verified from the cache counted as complete, so the share it reports never goes backwards or past 100%. The count
 * starts once every file of the load has been requested, so its total never changes: after `seal`, and after every
 * `naming` has named its files. It stays silent for a load the cache serves entirely, as a cached file alone does.
 */
export function engineLoad(signal?: AbortSignal, report?: (progress: BootProgress) => void) {
  const cancelled = new AbortController(), downloads = signal === undefined ? cancelled.signal : AbortSignal.any([signal, cancelled.signal]);
  const files: { received: number; readonly bytes: number }[] = [], settled: Promise<unknown>[] = [];
  // File lists not yet requested in full: the caller's own until `seal`, and one per `naming`.
  let unnamed = 1, downloading = false, reported = -1;
  const update = (): void => {
    if (report === undefined || unnamed > 0 || !downloading || downloads.aborted) return;
    let completedBytes = 0, totalBytes = 0;
    for (const file of files) { completedBytes += file.received; totalBytes += file.bytes; }
    if (completedBytes <= reported) return;
    reported = completedBytes;
    report({ phase: "download", asset: "engine", completedBytes, totalBytes });
  };
  const named = (): void => { unnamed -= 1; update(); };
  return {
    /** Fetches one pinned file and verifies its size and SHA-256 (`fetchPinnedBytes`). */
    fetch(url: URL, sha256: string, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
      const file = { received: 0, bytes };
      files.push(file);
      const verified = fetchPinnedBytes(url, sha256, "engine", downloads, report === undefined ? undefined : progress => {
        if (progress.phase !== "download") return;
        file.received = progress.completedBytes; downloading = true; update();
      }, bytes).then(value => { file.received = bytes; update(); return value; });
      settled.push(verified.catch(() => undefined));
      return verified;
    },
    /** For a file that names more files of the load (a manifest): call the result, once, when they are requested. */
    naming(): () => void { unnamed += 1; return named; },
    /** The caller has requested every file it names itself. Call it once. */
    seal: named,
    /** Stops every download of the load, after a failure, and waits until each has settled. */
    async cancel(): Promise<void> {
      cancelled.abort();
      await Promise.all(settled);
    },
  };
}

/**
 * The values of `steps` in order once all have succeeded. Otherwise the first failure in their order, as soon as every
 * earlier step has succeeded, whichever step failed first in time.
 */
export async function inOrder<T>(steps: readonly Promise<T>[]): Promise<T[]> {
  const outcomes = steps.map(step => step.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })));
  const values: T[] = [];
  for (const outcome of outcomes) {
    const result = await outcome;
    if (!result.ok) throw result.error;
    values.push(result.value);
  }
  return values;
}
