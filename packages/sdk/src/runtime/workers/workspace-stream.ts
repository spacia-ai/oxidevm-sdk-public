import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import type { WorkspaceSnapshotReuse } from "../protocol/workspace-publication.js";
import type { WorkspaceStoreBackend } from "./workspace-store.js";

const CHUNK_BYTES = 1024 * 1024;
const FRAME_BYTES = 64 * 1024;
const PAGE_ENTRIES = 1024;
const MAX_PAGES = 1024;
const METADATA_BYTES = 128 * 1024;

interface Chunk { readonly sha256: string; readonly bytes: number }
export interface WorkspaceStreamRef { readonly bytes: number; readonly pages: readonly Chunk[] }
export interface WorkspaceStreamInput {
  readonly bytes: number;
  readonly source: (signal: AbortSignal) => WorkspaceStreamProducer;
}
export interface WorkspaceStreamProducer {
  readonly frames: AsyncIterable<Uint8Array<ArrayBuffer>, void, unknown>;
  /** Cancel outstanding reads and await confirmed retirement, including after
   * EOF or a read failure. Repeated calls must retain the same outcome. */
  retire(): Promise<void>;
}
export interface WorkspaceStreams {
  readonly snapshot: WorkspaceStreamInput | WorkspaceSnapshotReuse;
  readonly delta: WorkspaceStreamInput;
  readonly dependencies?: { readonly inputsSha256: string; readonly tree: WorkspaceStreamInput };
}

/** Bytes already in memory as a stream input, in owned frames of at most 64 KiB. */
export function workspaceBytesInput(bytes: Uint8Array): WorkspaceStreamInput {
  return { bytes: bytes.byteLength, source: () => {
    const frames = (async function* () {
      for (let offset = 0; offset < bytes.byteLength; offset += FRAME_BYTES) yield await Promise.resolve(bytes.slice(offset, offset + FRAME_BYTES));
    })();
    return { frames, retire: async () => { await frames.return(undefined); } };
  } };
}

/** Own all attached producers before consuming any one stream. A later stream
 * may already have transferred queues even when an earlier stream fails. */
export async function openWorkspaceStreams(input: WorkspaceStreams, signal: AbortSignal): Promise<{
  readonly streams: WorkspaceStreams; retire(): Promise<void>;
}> {
  const producers: WorkspaceStreamProducer[] = [];
  const open = (input: WorkspaceStreamInput): WorkspaceStreamInput => {
    const source = input.source(signal);
    let retirement: Promise<void> | undefined;
    const producer = { frames: source.frames,
      retire: () => retirement ??= Promise.resolve().then(() => source.retire()) };
    producers.push(producer);
    return { bytes: input.bytes, source: () => producer };
  };
  const retire = async (): Promise<void> => {
    const results = await Promise.allSettled(producers.map(producer => producer.retire()));
    if (results.some(result => result.status === "rejected")) {
      throw new VMError("STORAGE_ERROR", "Workspace producer retirement failed; reopen the VM", {
        reason: "workspace-producer-retirement-failed", cleanupFailed: true,
      });
    }
  };
  try {
    return { streams: { snapshot: "reuse" in input.snapshot ? input.snapshot : open(input.snapshot), delta: open(input.delta),
      ...(input.dependencies === undefined ? {} : { dependencies: {
        inputsSha256: input.dependencies.inputsSha256, tree: open(input.dependencies.tree),
      } }) }, retire };
  } catch (error) { await retire(); throw error; }
}

/** Mechanism owned by WorkspaceStore. Data and index pages are immutable;
 * only the owning store may select them by committing active metadata. */
export async function stageWorkspaceStream(backend: WorkspaceStoreBackend, input: WorkspaceStreamInput, signal: AbortSignal, staging: WorkspaceStreamStaging): Promise<WorkspaceStreamRef> {
  integer(input.bytes, "workspace stream length", 0, CHUNK_BYTES * PAGE_ENTRIES * MAX_PAGES);
  active(signal);
  const pages: Chunk[] = [];
  let entries: Chunk[] = [];
  let received = 0;
  let used = 0;
  let buffer = new Uint8Array(Math.min(CHUNK_BYTES, input.bytes));
  const flushPage = async (): Promise<void> => {
    if (entries.length === 0) return;
    const page = new TextEncoder().encode(JSON.stringify(entries));
    pages.push(await storeChunk(backend, page, signal, staging));
    entries = [];
  };
  await consumeFrames(input, signal, async frame => {
    active(signal);
    if (!(frame instanceof Uint8Array) || !(frame.buffer instanceof ArrayBuffer)
      || frame.byteLength === 0 || frame.byteLength > FRAME_BYTES
      || frame.byteOffset !== 0 || frame.buffer.byteLength !== frame.byteLength) {
      throw new VMError("PROTOCOL_ERROR", "Workspace stream requires owned frames of 1–65536 bytes");
    }
    if (frame.byteLength > input.bytes - received) invalid("workspace stream exceeded its declared length");
    received += frame.byteLength;
    let offset = 0;
    while (offset < frame.byteLength) {
      const take = Math.min(buffer.length - used, frame.byteLength - offset);
      buffer.set(frame.subarray(offset, offset + take), used);
      offset += take; used += take;
      if (used === buffer.length) {
        entries.push(await storeChunk(backend, buffer, signal, staging));
        if (entries.length === PAGE_ENTRIES) await flushPage();
        const remaining = input.bytes - received + frame.byteLength - offset;
        buffer = new Uint8Array(Math.min(CHUNK_BYTES, remaining));
        used = 0;
      }
    }
  });
  active(signal);
  if (received !== input.bytes || used !== 0) invalid("workspace stream ended before its declared length");
  await flushPage();
  return { bytes: input.bytes, pages };
}

async function consumeFrames(input: WorkspaceStreamInput, signal: AbortSignal,
  consume: (frame: Uint8Array<ArrayBuffer>) => Promise<void>): Promise<void> {
  const producer = input.source(signal);
  let failure: { readonly error: unknown } | undefined;
  try {
    for await (const frame of producer.frames) {
      active(signal);
      await consume(frame);
    }
  } catch (error) {
    failure = { error: signal.aborted ? new VMError("ABORTED", "Workspace stream cancelled") : error };
  }
  // Iterator completion is not a retirement receipt. In particular, for-await
  // may suppress a return failure when processing a frame already threw.
  try { await producer.retire(); }
  catch {
    throw new VMError("STORAGE_ERROR", "Workspace producer retirement failed; reopen the VM", {
      reason: "workspace-producer-retirement-failed", cleanupFailed: true,
    });
  }
  if (failure !== undefined) throw failure.error;
}

/** Journal old references before replacing the active manifest. Recovery can
 * then reclaim them using the same bounded reachability scan as failed staging. */
export async function trackWorkspaceStream(backend: WorkspaceStoreBackend, ref: WorkspaceStreamRef, staging: WorkspaceStreamStaging): Promise<void> {
  for await (const entry of streamChunks(backend, ref, new AbortController().signal)) await staging.track(`chunks/${entry.sha256}`);
  for (const page of ref.pages) await staging.track(`chunks/${page.sha256}`);
}

export async function* readWorkspaceStream(backend: WorkspaceStoreBackend, ref: WorkspaceStreamRef, signal: AbortSignal): AsyncGenerator<Uint8Array<ArrayBuffer>, void, unknown> {
  for await (const entry of streamChunks(backend, ref, signal)) {
    const content = await readChunk(backend, entry, CHUNK_BYTES, signal);
    for (let offset = 0; offset < content.length; offset += FRAME_BYTES) {
      active(signal);
      yield content.slice(offset, offset + FRAME_BYTES);
    }
  }
}

async function* streamChunks(backend: WorkspaceStoreBackend, ref: WorkspaceStreamRef, signal: AbortSignal): AsyncGenerator<Chunk, void, unknown> {
  let remaining = ref.bytes;
  for (const [pageIndex, page] of ref.pages.entries()) {
    const bytes = await readChunk(backend, page, METADATA_BYTES, signal);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
    catch { return invalid("workspace stream index is not valid JSON"); }
    if (!Array.isArray(value) || value.length === 0
      || value.length !== Math.min(PAGE_ENTRIES, Math.ceil(remaining / CHUNK_BYTES))
      || (pageIndex < ref.pages.length - 1 && value.length !== PAGE_ENTRIES)) invalid("invalid workspace stream index length");
    const entries = value.map((item: unknown) => decodeChunk(item, CHUNK_BYTES));
    for (const entry of entries) {
      if (entry.bytes !== Math.min(remaining, CHUNK_BYTES)) invalid("workspace stream chunk length is inconsistent");
      remaining -= entry.bytes;
      yield entry;
    }
  }
  if (remaining !== 0) invalid("workspace stream is incomplete");
}

export async function recoverWorkspaceStaging(backend: WorkspaceStoreBackend, refs: readonly WorkspaceStreamRef[]): Promise<void> {
  for await (const path of backend.list("staging/")) {
    if (!/^staging\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(0|[1-9][0-9]{0,6})$/u.test(path)) invalid("workspace staging identity is invalid");
    const bytes = await backend.read(path, METADATA_BYTES);
    if (bytes === undefined) invalid("workspace staging index is missing");
    // Creating an OPFS file precedes its atomic writable close. No object can
    // be written until this first journal entry has committed.
    if (bytes.length === 0) { await backend.remove(path); continue; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { return invalid("workspace staging index is not valid JSON"); }
    if (!Array.isArray(value) || value.length === 0 || value.length > PAGE_ENTRIES) invalid("workspace staging index is corrupt");
    const candidates = new Set<string>();
    for (const item of value) {
      if (typeof item !== "string" || !/^chunks\/[a-f0-9]{64}$/u.test(item)) invalid("workspace staging path is invalid");
      candidates.add(item);
    }
    // ponytail: scan committed indexes per staging page to keep memory bounded
    // at 1024 candidates; add a persistent reachability index only if profiling warrants it.
    for (const ref of refs) {
      for (const page of ref.pages) candidates.delete(`chunks/${page.sha256}`);
      for await (const chunk of streamChunks(backend, ref, new AbortController().signal)) candidates.delete(`chunks/${chunk.sha256}`);
    }
    for (const candidate of candidates) await backend.remove(candidate);
    await backend.remove(path);
  }
}

export function decodeWorkspaceStream(value: unknown): WorkspaceStreamRef {
  const input = record(value, "workspace stream");
  exactKeys(input, ["bytes", "pages"]);
  const bytes = integer(input["bytes"], "workspace stream bytes", 0, CHUNK_BYTES * PAGE_ENTRIES * MAX_PAGES);
  const pages = input["pages"];
  if (!Array.isArray(pages) || pages.length !== Math.ceil(bytes / (CHUNK_BYTES * PAGE_ENTRIES))) invalid("workspace stream page count is inconsistent");
  return { bytes, pages: pages.map((page: unknown) => decodeChunk(page, METADATA_BYTES)) };
}

function decodeChunk(value: unknown, maximum: number): Chunk {
  const input = record(value, "workspace chunk");
  exactKeys(input, ["sha256", "bytes"]);
  const sha256 = string(input["sha256"], "workspace chunk hash");
  if (!/^[0-9a-f]{64}$/u.test(sha256)) invalid("invalid workspace chunk hash");
  return { sha256, bytes: integer(input["bytes"], "workspace chunk bytes", 1, maximum) };
}

async function storeChunk(backend: WorkspaceStoreBackend, bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal, staging: WorkspaceStreamStaging): Promise<Chunk> {
  active(signal);
  const sha256 = await hash(bytes);
  const path = `chunks/${sha256}`;
  const existing = await backend.read(path, CHUNK_BYTES, signal);
  active(signal);
  if (existing !== undefined) {
    if (existing.length !== bytes.length || await hash(existing) !== sha256) invalid("existing workspace chunk is corrupt");
  } else { await staging.track(path); await backend.write(path, bytes); }
  active(signal);
  return { sha256, bytes: bytes.length };
}

async function readChunk(backend: WorkspaceStoreBackend, chunk: Chunk, maximum: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  active(signal);
  const bytes = await backend.read(`chunks/${chunk.sha256}`, maximum, signal);
  active(signal);
  if (bytes === undefined || bytes.length !== chunk.bytes || await hash(bytes) !== chunk.sha256) invalid("workspace chunk is missing or corrupt");
  return bytes;
}

async function hash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function active(signal: AbortSignal): void { if (signal.aborted) throw new VMError("ABORTED", "Workspace stream cancelled"); }
function invalid(message: string): never { throw new VMError("STORAGE_ERROR", message); }

/** Only newly created objects are eligible for failed-staging cleanup. Spill
 * their identities in bounded pages instead of retaining a whole tree in RAM. */
export class WorkspaceStreamStaging {
  readonly #root = `staging/${crypto.randomUUID()}`;
  readonly #backend: WorkspaceStoreBackend;
  #page = 0;
  #paths: string[] = [];

  constructor(backend: WorkspaceStoreBackend) { this.#backend = backend; }

  async track(path: string): Promise<void> {
    this.#paths.push(path);
    // The chunk writer must not run until even a partial ownership page is
    // durable. A crash may leave this intent, but never an unowned new object.
    await this.#backend.write(`${this.#root}/${this.#page}`, new TextEncoder().encode(JSON.stringify(this.#paths)));
    if (this.#paths.length === PAGE_ENTRIES) {
      this.#page += 1;
      this.#paths = [];
    }
  }

  async retire(removeObjects: boolean): Promise<void> {
    for (let index = 0; index < this.#page + (this.#paths.length === 0 ? 0 : 1); index++) {
      const path = `${this.#root}/${index}`;
      if (removeObjects) {
        // The live owner also knows paths whose journal write failed before any object write.
        const bytes = index === this.#page ? undefined : await this.#backend.read(path, METADATA_BYTES);
        if (index !== this.#page && bytes === undefined) invalid("workspace staging index is missing");
        const value: unknown = bytes === undefined ? this.#paths
          : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!Array.isArray(value) || value.length !== (index === this.#page ? this.#paths.length : PAGE_ENTRIES)) invalid("workspace staging index is corrupt");
        for (const item of value) {
          if (typeof item !== "string" || !/^chunks\/[a-f0-9]{64}$/u.test(item)) invalid("workspace staging path is invalid");
          await this.#backend.remove(item);
        }
      }
      await this.#backend.remove(path);
    }
    this.#paths = [];
    this.#page = 0;
  }
}
