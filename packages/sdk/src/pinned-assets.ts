import type { BootProgress } from "./contracts.js";
import { VMError } from "./runtime/errors.js";
import { sha256Hex } from "./runtime/workers/snapshot-content.js";

/** Bounded, pinned bytes. An immutable Blob URL keeps verification and execution together. */
export async function fetchPinnedBytes(url: URL, digest: string, asset: "engine" | "image" | "compiler", signal?: AbortSignal, progress?: (progress: BootProgress) => void, expectedBytes?: number): Promise<Uint8Array<ArrayBuffer>> {
  abortIfRequested(signal);
  const code = asset === "image" ? "PROTOCOL_ERROR" : "CORE_LOAD_FAILED";
  try {
    const cache = typeof caches === "object" ? await caches.open("oxidevm-sdk-pinned-assets-v1").catch(() => undefined) : undefined;
    const key = new URL(url); key.searchParams.set("oxidevm-sha256", digest);
    let cachedFailure: { readonly error: unknown } | undefined;
    const cached = await cache?.match(key).catch(() => undefined);
    if (cached !== undefined) {
      try { return await readPinnedResponse(cached, digest, asset, signal, undefined, expectedBytes); }
      catch (error) {
        abortIfRequested(signal);
        cachedFailure = { error };
        await cache?.delete(key).catch(() => false);
        if (error instanceof VMError && error.code === "ABORTED") throw error;
      }
    }
    const response = await fetch(url, signal === undefined ? {} : { signal }).catch((error: unknown) => {
      if (error instanceof TypeError && cachedFailure !== undefined) throw cachedFailure.error;
      throw error;
    });
    const bytes = await readPinnedResponse(response, digest, asset, signal, progress, expectedBytes);
    await cache?.put(key, new Response(bytes)).catch(() => undefined);
    return bytes;
  } catch (error) {
    abortIfRequested(signal);
    if (error instanceof VMError) throw error;
    throw new VMError(code, `${asset} asset could not be downloaded`);
  }
}
async function readPinnedResponse(response: Response, digest: string, asset: "engine" | "image" | "compiler", signal?: AbortSignal,
  progress?: (progress: BootProgress) => void, expectedBytes?: number): Promise<Uint8Array<ArrayBuffer>> {
  const code = asset === "image" ? "PROTOCOL_ERROR" : "CORE_LOAD_FAILED";
  if (!response.ok || response.body === null) throw new VMError(code, `${asset} asset download failed`, { status: response.status });
  const length = response.headers.get("content-length"), total = length === null ? null : Number(length);
  const maximum = expectedBytes ?? 64 * 1024 ** 2;
  if (total !== null && (!Number.isSafeInteger(total) || total < 0 || total > maximum)) throw new VMError(code, `${asset} asset size is invalid`);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      abortIfRequested(signal);
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new VMError(code, `${asset} asset exceeds its bound`); }
      chunks.push(next.value); if (asset !== "compiler") progress?.({ phase: "download", asset, completedBytes: size, totalBytes: total });
    }
  } finally { reader.releaseLock(); }
  if (expectedBytes !== undefined && size !== expectedBytes) throw new VMError(code, `${asset} asset byte count is incompatible with this SDK`);
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (await sha256Hex(bytes) !== digest) throw new VMError(code, `${asset} asset SHA-256 does not match its pinned identity`);
  abortIfRequested(signal);
  return bytes;
}
export function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new VMError("ABORTED", "operation cancelled");
}
