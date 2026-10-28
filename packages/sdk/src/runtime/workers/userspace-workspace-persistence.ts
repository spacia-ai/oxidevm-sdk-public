import { deserializeError, VMError } from "../errors.js";
import { decodeUserspaceWorkspaceCapture } from "../userspace-persistence-abi.js";
import { boundedByProgress, SYNCHRONIZATION_STEP_MS } from "./control/workspace-sync.js";
import { callUserspaceU32 as call, callUserspaceU64 as call64 } from "./userspace-exports.js";
import { callNativeFiles, readFileRecord } from "./userspace-files.js";
import type { UserspaceStorageClient } from "./userspace-storage-channel.js";
import { workspaceBytesInput, type WorkspaceStreamInput } from "./workspace-stream.js";

interface Runtime { readonly instance: WebAssembly.Instance; readonly memory: WebAssembly.Memory }

/** Rust owns workspace policy and captured revisions. Storage owns generation
 * leases and durable publication; this adapter only transports bounded frames. */
export class UserspaceWorkspacePersistence {
  readonly #runtime: Runtime;
  readonly #storage: UserspaceStorageClient;
  readonly #base: string;
  readonly #wake: () => void;
  readonly #generation: number;
  #draining: Promise<void> = Promise.resolve();
  #failure: VMError | undefined;
  #publishedGeneration = 0;

  constructor(runtime: Runtime, storage: UserspaceStorageClient, base: string, wake: () => void, readonly prepareStorage: () => Promise<boolean> = () => Promise.resolve(false)) {
    this.#runtime = runtime; this.#storage = storage; this.#base = base; this.#wake = wake;
    this.#generation = storage.workspaceTransfers.begin();
    this.#ok("workspace_capture_reset");
  }

  async initialize(signal = new AbortController().signal): Promise<void> {
    this.#active(signal);
    const read = await this.#storage.workspaceTransfers.read(this.#base, signal);
    const retire = read.retire;
    let id = 0n;
    try {
      this.#active(signal);
      if (read.selection !== undefined) {
        this.#publishedGeneration = read.selection.generation;
        id = call64(this.#runtime.instance, "oxidevm_userspace_workspace_import_begin");
        if (id === 0n) throw new VMError("STORAGE_ERROR", "Native workspace restoration could not start");
        if (read.selection.snapshot !== undefined) await this.#restore(id, 0, read.selection.snapshot, signal);
        if (read.selection.delta !== undefined) await this.#restore(id, 1, read.selection.delta, signal);
      }
      // ADR 0012 dependency generations remain opaque storage objects in Userspace.
      await retire();
      this.#active(signal);
      if (id !== 0n) this.#ok("workspace_import_complete", id);
    } catch (error) {
      let cleanupFailed = false;
      if (id !== 0n) cleanupFailed = call(this.#runtime.instance, "oxidevm_userspace_workspace_transfer_abort", id) !== 0;
      try { await retire(); } catch { cleanupFailed = true; }
      if (cleanupFailed) throw this.#fence("Workspace restoration retirement is uncertain");
      throw error;
    }
  }

  async #restore(id: bigint, kind: 0 | 1, input: WorkspaceStreamInput, signal: AbortSignal): Promise<void> {
    this.#ok("workspace_import_source", id, kind, BigInt(input.bytes));
    const producer = input.source(signal);
    try {
      for await (const frame of producer.frames) {
        this.#active(signal);
        this.#stage(frame); this.#ok("workspace_import_feed", id, frame.length);
      }
      this.#active(signal);
      this.#ok("workspace_import_source_complete", id);
    } finally { await producer.retire(); }
  }

  waitForProducer(): Promise<void> { return this.#draining; }

  async requestFile(request: Uint8Array, checkCanceled: () => void): Promise<Uint8Array<ArrayBuffer>> {
    for (;;) {
      const draining = this.#draining;
      await draining;
      if (this.#failure !== undefined) throw this.#failure;
      if (draining === this.#draining) { this.#storage.workspaceTransfers.assert(this.#generation); checkCanceled(); return callNativeFiles(this.#runtime, request); }
    }
  }

  async persist(signal = new AbortController().signal): Promise<void> {
    this.#active(signal);
    const instance = this.#runtime.instance;
    const revision = call64(instance, "oxidevm_userspace_workspace_revision");
    const published = call64(instance, "oxidevm_userspace_workspace_published_revision");
    if (revision === 0xffff_ffff_ffff_ffffn || published === 0xffff_ffff_ffff_ffffn) throw new VMError("STORAGE_ERROR", "Workspace revision is unavailable");
    if (revision === published) return;
    for (;;) {
      this.#active(signal);
      const status = call(instance, "oxidevm_userspace_workspace_export_begin");
      if (status !== 4) { this.#status(status, "workspace_export_begin"); break; }
      if (!await this.prepareStorage()) throw new VMError("STORAGE_ERROR", "Workspace export is waiting without a storage request");
    }
    const exported = decodeUserspaceWorkspaceCapture(readFileRecord(this.#runtime));
    const draining = Promise.withResolvers<undefined>();
    this.#draining = draining.promise;
    const progress = { frames: 0 };
    let retired = false;
    const retire = (): Promise<void> => {
      try {
        if (!retired) { this.#ok("workspace_export_retire", exported.id); retired = true; this.#wake(); }
        return Promise.resolve();
      } finally { draining.resolve(undefined); }
    };
    const capture: WorkspaceStreamInput = { bytes: exported.bytes, source: signal => ({
      frames: (async function* (owner: UserspaceWorkspacePersistence) {
        while (!retired && !signal.aborted) {
          owner.#ok("workspace_export_next", exported.id);
          const bytes = readFileRecord(owner.#runtime);
          if (bytes.length === 0) return;
          if (bytes.length > 65536) throw new VMError("PROTOCOL_ERROR", "Native workspace frame exceeds its bound");
          progress.frames += 1;
          yield await Promise.resolve(bytes);
        }
      })(this), retire,
    }) };
    const cancellation = new AbortController();
    const abort = (): void => cancellation.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      if (exported.kind === "delta" && this.#publishedGeneration === 0) throw new VMError("PROTOCOL_ERROR", "Native delta has no acknowledged snapshot generation");
      const snapshot = exported.kind === "snapshot" ? capture : { reuse: this.#publishedGeneration };
      const delta = exported.kind === "delta" ? capture : workspaceBytesInput(new Uint8Array([79, 88, 87, 68, 4, 0, 0, 0, 0, 0, 0, 0]));
      const result = await boundedByProgress(this.#storage.workspaceTransfers.publish(this.#base, snapshot, delta, cancellation.signal),
        "publish", SYNCHRONIZATION_STEP_MS, progress);
      if (result.outcome.kind === "failed") throw deserializeError(result.outcome.error);
      this.#ok("workspace_publication_complete", exported.id, 1);
      this.#publishedGeneration = result.outcome.generation;
    } catch (error) {
      abort();
      await retire();
      this.#ok("workspace_publication_complete", exported.id, 0);
      if (error instanceof VMError && error.detail?.["cleanupFailed"] === true) this.#failure = error;
      if (error instanceof VMError && error.detail?.["step"] === "publish") throw this.#fence("Workspace publication retirement is uncertain");
      throw error;
    } finally { signal.removeEventListener("abort", abort); }
  }

  #stage(bytes: Uint8Array): void {
    if (bytes.length < 1 || bytes.length > 65536) throw new VMError("PROTOCOL_ERROR", "Invalid workspace frame length");
    this.#ok("staging_resize", bytes.length);
    const pointer = call(this.#runtime.instance, "oxidevm_userspace_staging_ptr");
    if (pointer + bytes.length > this.#runtime.memory.buffer.byteLength) throw new VMError("PROTOCOL_ERROR", "Workspace staging lies outside Wasm memory");
    new Uint8Array(this.#runtime.memory.buffer, pointer, bytes.length).set(bytes);
  }

  #active(signal: AbortSignal): void {
    this.#storage.workspaceTransfers.assert(this.#generation);
    if (this.#failure !== undefined) throw this.#failure;
    if (signal.aborted) throw new VMError("ABORTED", "Workspace persistence cancelled");
  }

  #fence(message: string): VMError {
    return this.#failure = new VMError("STORAGE_ERROR", message, { cleanupFailed: true });
  }

  #ok(name: string, ...args: readonly (number | bigint)[]): void {
    this.#status(call(this.#runtime.instance, `oxidevm_userspace_${name}`, ...args), name);
  }

  #status(status: number, name: string): void {
    if (status !== 0) throw new VMError(status === 3 ? "QUOTA_EXCEEDED" : "STORAGE_ERROR", `Native workspace ${name} failed (${String(status)})`);
  }
}
