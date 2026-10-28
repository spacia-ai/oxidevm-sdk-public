import { VMError } from "../errors.js";
import { callUserspaceU32 as call, callUserspaceU64 as call64 } from "./userspace-exports.js";
import type { PreviewRuntimeCompletion, PreviewRuntimeOperation } from "./preview-runtime-channel.js";
import { decodePreviewGeneration } from "./preview-runtime-channel.js";

interface Pending {
  readonly interest: "read" | "write";
  readonly cleanup: () => void;
  readonly resolve: (completion: PreviewRuntimeCompletion) => void;
  readonly reject: (error: Error) => void;
}

/** Promises belong to this runtime incarnation. Pending readiness belongs to Rust. */
export class UserspacePreviewWaits {
  readonly #pending = new Map<number, Pending>();
  #closed = false;
  readonly generation: bigint;
  constructor(readonly instance: WebAssembly.Instance) {
    this.generation = decodePreviewGeneration(call64(instance, "oxidevm_userspace_preview_generation"));
  }

  async wait(operation: Extract<PreviewRuntimeOperation, { kind: "wait" }>, signal: AbortSignal): Promise<PreviewRuntimeCompletion> {
    if (this.#closed || signal.aborted) throw aborted();
    if (operation.generation !== this.generation) return { kind: "error", code: "process" };
    const { id, errno } = decode(call64(this.instance, "oxidevm_userspace_preview_wait", this.generation, operation.connection, operation.interest === "write" ? 1 : 0));
    if (errno !== 0) {
      if (id !== 0) throw invalid();
      return { kind: "error", code: errno === 11 ? "capacity" : operation.interest };
    }
    if (id === 0 || this.#pending.has(id)) throw invalid();
    return new Promise((resolve, reject) => {
      const cancel = (): void => {
        const pending = this.#take(id);
        if (pending === undefined) return;
        try { this.#cancel(id); pending.reject(aborted()); }
        catch (error) { pending.reject(error instanceof Error ? error : invalid()); }
      };
      this.#pending.set(id, { resolve, reject, interest: operation.interest, cleanup: () => signal.removeEventListener("abort", cancel) });
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      this.pump();
    });
  }

  pump(): void {
    if (this.#closed) return;
    try {
      for (;;) {
        const value = call64(this.instance, "oxidevm_userspace_preview_wait_next", this.generation);
        if (value === 0n) return;
        const { id, errno } = decode(value);
        const pending = this.#take(id);
        if (pending === undefined) throw new VMError("PROTOCOL_ERROR", "Stale preview readiness completion");
        pending.resolve(errno === 0 ? { kind: "ready" } : { kind: "error", code: pending.interest });
      }
    } catch (error) {
      const failure = error instanceof Error ? error : invalid();
      this.#finish(false, failure);
      throw failure;
    }
  }

  #take(id: number): Pending | undefined {
    const pending = this.#pending.get(id);
    if (pending !== undefined) { this.#pending.delete(id); pending.cleanup(); }
    return pending;
  }

  #cancel(id: number): void {
    if (call(this.instance, "oxidevm_userspace_preview_wait_cancel", this.generation, id) !== 0) {
      throw new VMError("PROTOCOL_ERROR", "Preview readiness cancellation failed");
    }
  }

  close(): void {
    this.#finish(true);
  }

  /** The native heap was replaced. Its former wait IDs must never reach the new owner. */
  retire(): void {
    this.#finish(false);
  }

  #finish(cancel: boolean, reason: Error = aborted()): void {
    if (this.#closed) return;
    this.#closed = true;
    let failure: Error | undefined;
    for (const id of this.#pending.keys()) {
      const pending = this.#take(id);
      try { if (cancel) this.#cancel(id); } catch (error) { failure ??= error instanceof Error ? error : invalid(); }
      pending?.reject(reason);
    }
    if (failure !== undefined) throw failure;
  }
}

function decode(value: bigint): { readonly id: number; readonly errno: number } {
  const id = Number(value & 0xffff_ffffn), errno = Number(value >> 32n);
  if (errno > 4095 || id === 0 && errno === 0) throw invalid();
  return { id, errno };
}
function invalid(): VMError { return new VMError("PROTOCOL_ERROR", "Invalid preview readiness result"); }
function aborted(): VMError { return new VMError("ABORTED", "Preview readiness wait retired"); }
