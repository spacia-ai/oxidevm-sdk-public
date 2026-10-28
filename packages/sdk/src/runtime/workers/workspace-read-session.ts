import { VMError } from "../errors.js";
import type { WorkspaceReadKind, WorkspaceReadSelection } from "../protocol/workspace-read.js";
import type { WorkspaceReadLease } from "./workspace-read.js";
import type { WorkspaceStreamProducer } from "./workspace-stream.js";

/** WorkspaceStore retains the selected generation. The storage worker serializes
 * pulls; one VM-issued storage window covers its bounded read buffers. */
export class WorkspaceReadSession {
  readonly #cancel = new AbortController();
  readonly #opening: Promise<WorkspaceReadLease | undefined>;
  readonly #sources = new Map<WorkspaceReadKind, { producer: WorkspaceStreamProducer; iterator: AsyncIterator<Uint8Array<ArrayBuffer>, void, unknown>; offset: number; bytes: number; done: boolean }>();
  #pending = false;
  readonly #retiredSources = new Set<WorkspaceReadKind>();
  #retirement: Promise<void> | undefined;

  constructor(open: (signal: AbortSignal) => Promise<WorkspaceReadLease | undefined> | WorkspaceReadLease, signal: AbortSignal) {
    const abort = () => this.#cancel.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    this.#opening = (async () => {
      try {
        return await open(this.#cancel.signal);
      } finally { signal.removeEventListener("abort", abort); }
    })();
    void this.#opening.catch(() => {});
  }

  async selection(): Promise<WorkspaceReadSelection<number> | undefined> {
    const lease = await this.#opening;
    if (lease === undefined) return undefined;
    return { generation: lease.generation,
      ...(lease.workspaceBaseSha256===undefined?{}:{workspaceBaseSha256:lease.workspaceBaseSha256}),
      ...(lease.snapshot === undefined ? {} : { snapshot: lease.snapshot.bytes }),
      ...(lease.delta === undefined ? {} : { delta: lease.delta.bytes }),
      ...(lease.dependencies === undefined ? {} : { dependencies: {
        generation: lease.dependencies.generation, inputsSha256: lease.dependencies.inputsSha256, tree: lease.dependencies.tree.bytes,
      } }) };
  }

  async read(kind: WorkspaceReadKind, offset: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const cancelled = () => this.#cancel.signal.aborted;
    if (this.#pending || this.#retirement !== undefined || cancelled()) throw new VMError("ABORTED", "Workspace read is busy or retired");
    if (this.#retiredSources.has(kind)) throw new VMError("PROTOCOL_ERROR", "Workspace read source is retired");
    this.#pending = true;
    const abort = () => this.#cancel.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const lease = await this.#opening;
      const input = kind === "dependencies" ? lease?.dependencies?.tree : lease?.[kind];
      if (input === undefined) throw new VMError("PROTOCOL_ERROR", "Workspace read source is absent");
      let source = this.#sources.get(kind);
      if (source === undefined) {
        const producer = input.source(this.#cancel.signal);
        source = { producer, iterator: producer.frames[Symbol.asyncIterator](), offset: 0, bytes: input.bytes, done: false };
        this.#sources.set(kind, source);
      }
      if (offset !== source.offset || source.done) throw new VMError("PROTOCOL_ERROR", "Stale workspace read offset");
      const next = await source.iterator.next();
      if (cancelled()) throw new VMError("ABORTED", "Workspace read cancelled");
      if (next.done === true) {
        if (source.offset !== source.bytes) throw new VMError("STORAGE_ERROR", "Workspace read ended early");
        await source.producer.retire();
        source.done = true;
        return undefined;
      }
      const bytes = next.value;
      if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0
        || bytes.byteLength !== bytes.buffer.byteLength || bytes.length < 1 || bytes.length > 65536 || bytes.length > source.bytes - source.offset) {
        throw new VMError("STORAGE_ERROR", "Invalid workspace read frame");
      }
      source.offset += bytes.length;
      return bytes;
    } finally { this.#pending = false; signal.removeEventListener("abort", abort); }
  }

  async retireSource(kind: WorkspaceReadKind): Promise<void> {
    const lease = await this.#opening;
    if ((kind === "dependencies" ? lease?.dependencies?.tree : lease?.[kind]) === undefined) throw new VMError("PROTOCOL_ERROR", "Workspace read source is absent");
    await this.#sources.get(kind)?.producer.retire();
    this.#retiredSources.add(kind);
  }

  retire(): Promise<void> {
    this.#cancel.abort();
    return this.#retirement ??= (async () => {
      let lease: WorkspaceReadLease | undefined;
      try { lease = await this.#opening; }
      catch (error) {
        if (error instanceof VMError && error.detail?.["cleanupFailed"] === true) throw error;
        return;
      }
      await lease?.retire();
    })();
  }
}
