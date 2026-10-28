import { callUserspaceU32 as call, callUserspaceU64 as call64 } from "./userspace-exports.js";
import { decodePreviewGeneration } from "./preview-runtime-channel.js";
import { VMError } from "../errors.js";
import type { UserspaceCheckpointGate } from "./userspace-checkpoint-gate.js";
import { UserspacePreviewWaits } from "./userspace-preview-waits.js";
import type {
  PreviewRuntimeCompletion,
  PreviewRuntimeOperation,
} from "./preview-runtime-channel.js";

const ERROR = 0xffff_ffff;
const BLOCKED = ERROR - 1;

export interface PreviewProcess {
  readonly pid: number;
  readonly instance: WebAssembly.Instance;
  readonly memory: WebAssembly.Memory;
  wake(): void;
}

export class UserspacePreviewRuntime {
  #waits: UserspacePreviewWaits | undefined;
  constructor(readonly owner: {
    readonly gate: Pick<UserspaceCheckpointGate, "deliver">;
    epoch(): unknown;
    processes(): Iterable<PreviewProcess>;
    opened(pid: number): void;
    closed(pid: number): void;
  }) {}

  async request(operation: PreviewRuntimeOperation, signal: AbortSignal): Promise<PreviewRuntimeCompletion> {
    const epoch = this.owner.epoch();
    let completion: PreviewRuntimeCompletion | Promise<PreviewRuntimeCompletion> | undefined;
    await this.owner.gate.deliver(() => {
      if (signal.aborted) throw new VMError("ABORTED", "Preview request was cancelled");
      if (epoch !== this.owner.epoch()) throw new VMError("ABORTED", "Preview belongs to a retired runtime");
      const processes = [...this.owner.processes()];
      if (operation.kind === "wait") {
        const process = processes.find(process => process.pid === operation.process);
        if (process === undefined) { completion = { kind: "error", code: "process" }; return; }
        this.#waits ??= new UserspacePreviewWaits(process.instance);
        completion = this.#waits.wait(operation, signal); return;
      }
      completion = servicePreviewRuntime(operation, processes);
      if (completion.kind === "opened") this.owner.opened(completion.process);
      else if (operation.kind === "close" && completion.kind === "closed") this.owner.closed(operation.process);
      this.pump();
    });
    if (completion === undefined) throw new VMError("ABORTED", "Native preview runtime is closed");
    return completion;
  }

  pump(): void { this.#waits?.pump(); }
  close(): void { try { this.#waits?.close(); } finally { this.#waits = undefined; } }
  retire(): void { this.#waits?.retire(); this.#waits = undefined; }
}

export function servicePreviewRuntime(
  operation: Exclude<PreviewRuntimeOperation, { kind: "wait" }>,
  processes: Iterable<PreviewProcess>,
): PreviewRuntimeCompletion {
  if (operation.kind === "open") {
    for (const process of processes) {
      if (operation.process !== null && process.pid !== operation.process) continue;
      const generation = decodePreviewGeneration(call64(process.instance, "oxidevm_userspace_preview_generation"));
      const connection = call(process.instance, "oxidevm_userspace_preview_open", generation, operation.port);
      if (connection !== 0) {
        process.wake();
        return { kind: "opened", generation, process: process.pid, connection };
      }
    }
    return { kind: "error", code: "listener" };
  }
  const process = [...processes].find((candidate) => candidate.pid === operation.process);
  if (process === undefined) return { kind: "error", code: "process" };
  if (operation.kind === "write") {
    if (call(process.instance, "oxidevm_userspace_staging_resize", operation.bytes.byteLength) !== 0) {
      return { kind: "error", code: "staging" };
    }
    const pointer = call(process.instance, "oxidevm_userspace_staging_ptr");
    new Uint8Array(process.memory.buffer, pointer, operation.bytes.byteLength).set(operation.bytes);
    const written = call(
      process.instance,
      "oxidevm_userspace_preview_write",
      operation.generation,
      operation.connection,
      operation.bytes.byteLength,
    );
    if (written === BLOCKED) {
      process.wake();
      return { kind: "blocked" };
    }
    if (written === ERROR || written > operation.bytes.byteLength) return { kind: "error", code: "write" };
    process.wake();
    return { kind: "written", bytes: written };
  }
  if (operation.kind === "read") {
    const status = call(
      process.instance,
      "oxidevm_userspace_preview_read",
      operation.generation,
      operation.connection,
      operation.maxBytes,
    );
    if (status === 1) {
      process.wake();
      return { kind: "blocked" };
    }
    if (status === 2) return { kind: "eof" };
    if (status !== 0) return { kind: "error", code: "read" };
    const pointer = call(process.instance, "oxidevm_userspace_preview_ptr");
    const length = call(process.instance, "oxidevm_userspace_preview_len");
    if (length > operation.maxBytes) return { kind: "error", code: "read" };
    process.wake();
    return {
      kind: "read",
      bytes: new Uint8Array(process.memory.buffer, pointer, length).slice(),
    };
  }
  const status = call(process.instance, "oxidevm_userspace_preview_close", operation.generation, operation.connection);
  return status === 0 ? { kind: "closed" } : { kind: "error", code: "close" };
}
