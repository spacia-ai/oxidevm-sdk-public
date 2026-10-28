import { VMError } from "../errors.js";
import type { ManagedImageSnapshot } from "../managed-image.js";
import type { SnapshotInfo } from "../protocol.js";
import { isBackupError } from "./snapshot-archive/errors.js";
import { gunzipExact } from "./snapshot-archive/gzip.js";
import { MAX_STORED_OVERHEAD_BYTES } from "./snapshot-archive/manifest.js";
import { type ShippedExpectation, shippedError, type ShippedManifest, verifyShippedManifest } from "./snapshot-archive/shipped.js";
import { rebuildChunk, type ShippedImageRange } from "./snapshot-archive/shipped-transport.js";
import { sha256Hex } from "./snapshot-content.js";
import type { SnapshotImport } from "./snapshot-import.js";
import { SNAPSHOT_CHUNK_BYTES, USERSPACE_SNAPSHOT_SCHEMA, type ObjectRef } from "./snapshot-manifest.js";
import type { SnapshotStore } from "./snapshot-store.js";
import type {ShippedInstallIdentity} from "../protocol/shipped-source.js";

/** Chunk downloads in flight at once. */
const PARALLEL_FETCHES = 4;
/** Tries per chunk before the install gives up on it. */
const ATTEMPTS = 3;
const PROGRESS_INTERVAL_MILLISECONDS = 100;
/** One download (a manifest of at most 4 MiB or a 1 MiB chunk) may take this long. */
const FETCH_TIMEOUT_MILLISECONDS = 120_000;

/** How an install runs in the storage worker. */
export interface ShippedInstallRun {
  /** Runs `turn` as one turn of the storage queue, between other requests. */
  readonly enqueue: <T>(turn: () => Promise<T>) => Promise<T>;
  readonly signal: AbortSignal;
  readonly now: () => number;
  /** The body of `url`, refused when larger than `maxBytes`. */
  readonly fetchBytes: (url: URL, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
  /** Waits before retry `attempt` (2 or 3) of a chunk. */
  readonly backoff?: (attempt: number) => Promise<void>;
  readonly progress?: (completedBytes: number, totalBytes: number) => void;
  /** The file of the prepared image named by `sha256`, for starts that leave image files out. */
  readonly readImageFile?: (sha256: string, bytes: number, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
}

/**
 * Installs the shipped restore point `listing` of a profile (ADR 0014, Release 2): its manifest,
 * pinned by the profile's hash and signed by the trusted key, then its chunks, four at a time,
 * each decompressed to its size and checked against its hash before it is stored, and tried up to
 * three times. A chunk the store already holds is not fetched again, so a retried install
 * fetches only what is missing; a chunk that never verifies is never stored. The restore point
 * commits as kind "shipped" only when every chunk is stored; installing it again returns it.
 */
export async function installShipped(
  store: SnapshotStore,
  listing: ManagedImageSnapshot,
  expectation: Pick<ShippedExpectation, "trusted" | "image">,
  run: ShippedInstallRun,
  source?: ShippedInstallIdentity,
): Promise<SnapshotInfo> {
  const manifestBytes = await fetchOrUnavailable(run, listing.manifest.url, listing.manifest.bytes);
  if (manifestBytes.byteLength !== listing.manifest.bytes || (await sha256Hex(manifestBytes)) !== listing.manifest.sha256) {
    throw shippedError("damaged", "the shipped restore point is not the one its profile pins");
  }
  const shipped = await verifyShippedManifest(manifestBytes, { ...expectation, name: listing.name, nowUnixMs: run.now() });
  const existing = source === undefined
    ? (await run.enqueue(() => store.list())).find((info) => info.kind === "shipped" && info.label === shipped.snapshot.label && info.capturedAtUnixMs === shipped.snapshot.capturedAtUnixMs)
    : await run.enqueue(() => store.findShipped(source,shipped.snapshot));
  if (existing !== undefined) return existing;
  const compatible = await run.enqueue(() => store.compatibility(shipped.snapshot));
  if (compatible !== true) throw shippedError("incompatible", "the shipped restore point does not fit this VM");

  const transaction = await run.enqueue(() => store.beginImport(shipped.snapshot, "shipped", source === undefined ? {} : {preserveId:true,shippedSource:source}));
  try {
    await storeChunks(transaction, shipped.objects, listing, run,source===undefined?undefined:listing.bytes);
    if (shipped.transport !== undefined) await rebuildShippedPayloads(transaction, shipped, listing, run);
    throwIfCancelled(run.signal);
    const committed = await run.enqueue(() => transaction.commit());
    const listed = (await run.enqueue(() => store.list())).find((info) => info.ref.id === committed.id);
    if (listed === undefined) throw new VMError("STORAGE_NOT_FOUND", "the installed restore point was not found");
    return listed;
  } catch (error) {
    await transaction.abort();
    throw error;
  }
}

/**
 * Stores every object the restore point needs, four workers at a time. A worker that fails an
 * object moves on, so what can be stored is stored for a later retry; the first failure is
 * thrown once every worker has finished.
 */
async function storeChunks(
  transaction: SnapshotImport,
  objects: readonly ObjectRef[],
  listing: ManagedImageSnapshot,
  run: ShippedInstallRun,
  maximumVerifiedBytes?:number,
): Promise<void> {
  const report = throttled(run);
  let next = 0;
  let downloaded = 0;
  let verifiedBytes=0;
  let failure: Error | undefined;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < objects.length; index = next++) {
      const ref = objects[index];
      if (ref === undefined || !transaction.needs(ref) || run.signal.aborted) continue;
      try {
        if (await run.enqueue(() => transaction.adopt(ref))) continue;
        const content = await fetchVerified(ref, new URL(`chunks/${ref.sha256}.gz`, listing.manifest.url), run, (bytes) => {
          downloaded += bytes;
          report(downloaded, listing.bytes);
        });
        verifiedBytes+=content.storedBytes;
        if(maximumVerifiedBytes!==undefined&&verifiedBytes>maximumVerifiedBytes)throw shippedError("damaged","The prepared state exceeds its declared download bound");
        await run.enqueue(() => transaction.put(ref, content.data));
      } catch (error) {
        failure ??= error instanceof Error ? error : new VMError("STORAGE_ERROR", String(error));
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_FETCHES }, worker));
  if (failure !== undefined) throw failure;
}

/**
 * Stores the payload chunks of a start that leaves its image files out: each is rebuilt from the
 * downloaded literal chunks and the prepared image's files, then checked against the hash its
 * signed manifest names. A chunk the store already holds is neither rebuilt nor downloaded.
 */
export async function rebuildShippedPayloads(
  transaction: Pick<SnapshotImport, "needs" | "adopt" | "put">,
  shipped: ShippedManifest,
  listing: ManagedImageSnapshot,
  run: ShippedInstallRun,
): Promise<void> {
  const transport = shipped.transport;
  if (transport === undefined || shipped.snapshot.schema !== USERSPACE_SNAPSHOT_SCHEMA) return;
  const readImageFile = run.readImageFile;
  if (readImageFile === undefined) throw shippedError("unavailable", "this browser cannot read the image files the shipped start leaves out");
  const report = throttled(run);
  let downloaded = 0;
  const literal = new Map<number, Uint8Array<ArrayBuffer>>();
  const literalChunk = async (index: number): Promise<Uint8Array<ArrayBuffer>> => {
    const cached = literal.get(index);
    if (cached !== undefined) return cached;
    const ref = transport.literal.chunks[index];
    if (ref === undefined) throw shippedError("damaged", "the shipped start reads past its literal stream");
    const content = (await fetchVerified(ref, new URL(`chunks/${ref.sha256}.gz`, listing.manifest.url), run, (bytes) => {
      downloaded += bytes; report(downloaded, listing.bytes);
    })).data;
    // Chunks are rebuilt in order, so the stream is read forward: keep the last two.
    literal.set(index, content); for (const key of literal.keys()) if (key < index - 1) literal.delete(key);
    return content;
  };
  const readLiteral = async (offset: number, length: number): Promise<Uint8Array> => {
    const output = new Uint8Array(length);
    for (let done = 0; done < length;) {
      const at = offset + done, chunk = await literalChunk(Math.floor(at / SNAPSHOT_CHUNK_BYTES)), from = at % SNAPSHOT_CHUNK_BYTES;
      const piece = chunk.subarray(from, Math.min(chunk.length, from + length - done));
      if (piece.length === 0) throw shippedError("damaged", "the shipped start's literal stream is short");
      output.set(piece, done); done += piece.length;
    }
    return output;
  };
  let image: { readonly sha256: string; readonly bytes: Uint8Array<ArrayBuffer> } | undefined;
  const readImage = async (range: ShippedImageRange, offset: number, length: number): Promise<Uint8Array> => {
    if (image?.sha256 !== range.sha256) {
      let bytes: Uint8Array<ArrayBuffer>;
      try { bytes = await readImageFile(range.sha256, range.bytes, run.signal); }
      catch { throw shippedError("unavailable", "an image file the shipped start leaves out could not be read"); }
      if (bytes.length !== range.bytes) throw shippedError("damaged", "an image file differs from the one the shipped start names");
      image = { sha256: range.sha256, bytes };
    }
    return image.bytes.subarray(offset, offset + length);
  };
  for (const chunk of shipped.snapshot.payloads.chunks) {
    throwIfCancelled(run.signal);
    if (!transaction.needs(chunk) || await run.enqueue(() => transaction.adopt(chunk))) continue;
    const bytes = await rebuildChunk(chunk, transport, readLiteral, readImage);
    if ((await sha256Hex(bytes)) !== chunk.sha256) throw shippedError("damaged", "a rebuilt shipped start chunk differs from its signed hash");
    await run.enqueue(() => transaction.put(chunk, bytes));
  }
}

/** One chunk's content: fetched, decompressed to its size and checked, up to three times. */
async function fetchVerified(
  ref: ObjectRef,
  url: URL,
  run: ShippedInstallRun,
  fetched: (bytes: number) => void,
): Promise<{data:Uint8Array<ArrayBuffer>;storedBytes:number}> {
  let last: VMError | undefined;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    throwIfCancelled(run.signal);
    if (attempt > 1) await run.backoff?.(attempt);
    let stored: Uint8Array<ArrayBuffer>;
    try {
      stored = await run.fetchBytes(url, ref.bytes + MAX_STORED_OVERHEAD_BYTES, run.signal);
    } catch {
      last = shippedError("unavailable", "a shipped restore point chunk could not be downloaded");
      continue;
    }
    fetched(stored.byteLength);
    try {
      const content = await gunzipExact(stored, ref.bytes);
      if ((await sha256Hex(content)) === ref.sha256) return {data:content,storedBytes:stored.byteLength};
    } catch (error) {
      if (!isBackupError(error)) throw error;
    }
    last = shippedError("damaged", "a shipped restore point chunk does not hold what its name says");
  }
  throw last ?? shippedError("unavailable", "a shipped restore point chunk could not be downloaded");
}

/**
 * The body of `url` from the network, refused past `maxBytes` (read no further than one chunk
 * beyond it), when the response is not OK, or after two minutes; `signal` cancels it.
 */
export async function fetchBounded(url: URL, maxBytes: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS)]),
  });
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new VMError("STORAGE_ERROR", `a download returned ${String(response.status)}`);
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new VMError("STORAGE_ERROR", "a download is larger than expected");
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return body;
}

async function fetchOrUnavailable(run: ShippedInstallRun, url: URL, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  throwIfCancelled(run.signal);
  try {
    return await run.fetchBytes(url, maxBytes, run.signal);
  } catch {
    throw shippedError("unavailable", "the shipped restore point could not be downloaded");
  }
}

function throttled(run: ShippedInstallRun): (completedBytes: number, totalBytes: number) => void {
  let reportedAt = -Infinity;
  return (completedBytes, totalBytes) => {
    const now = run.now();
    if (completedBytes < totalBytes && now - reportedAt < PROGRESS_INTERVAL_MILLISECONDS) return;
    reportedAt = now;
    run.progress?.(Math.min(completedBytes, totalBytes), totalBytes);
  };
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new VMError("ABORTED", "the shipped restore point install was cancelled");
}
