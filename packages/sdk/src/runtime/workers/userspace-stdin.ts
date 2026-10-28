import { VMError } from "../errors.js";
import { STDIN_CHUNK_BYTES } from "../guest-process.js";
import { decodeUserspaceStdinCount } from "../userspace-abi.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";

export function writeUserspaceStdin(
  runtime: { readonly instance: Pick<WebAssembly.Instance, "exports">; readonly memory: WebAssembly.Memory },
  pid: number,
  data: Uint8Array,
  progress: () => void,
): number {
  const status = call(runtime.instance, "oxidevm_userspace_staging_resize", data.byteLength);
  if (status !== 0) throw new VMError("GUEST_CRASH", `Userspace stdin staging failed with status ${status}`);
  const pointer = call(runtime.instance, "oxidevm_userspace_staging_ptr");
  new Uint8Array(runtime.memory.buffer, pointer, data.byteLength).set(data);
  const count = decodeUserspaceStdinCount(call(runtime.instance, "oxidevm_userspace_process_stdin_write", pid, data.byteLength) | 0, data.byteLength);
  if (count > 0) progress();
  return count;
}

interface PendingInput {
  readonly request: number;
  readonly bytes: Uint8Array;
  readonly resolve: (count: number) => void;
  readonly reject: (error: unknown) => void;
}

/** One bounded, unacknowledged driver packet per process; Rust owns input capacity. */
export class UserspaceStdin {
  readonly #attempt: (pid: number, bytes: Uint8Array) => number;
  readonly #pending = new Map<number, PendingInput>();

  constructor(attempt: (pid: number, bytes: Uint8Array) => number) { this.#attempt = attempt; }

  #accept(pid: number, bytes: Uint8Array): number {
    const count = this.#attempt(pid, bytes);
    if (!Number.isSafeInteger(count) || count < 0 || count > bytes.length) {
      throw new VMError("PROTOCOL_ERROR", "Invalid accepted Userspace stdin prefix");
    }
    return count;
  }

  async write(request: number, pid: number, bytes: Uint8Array): Promise<number> {
    if (bytes.length > STDIN_CHUNK_BYTES) throw new VMError("QUOTA_EXCEEDED", "Userspace stdin chunk exceeds its transport bound");
    if (this.#pending.has(pid)) throw new VMError("PROTOCOL_ERROR", "Userspace stdin already has a pending write");
    if (bytes.length === 0) return 0;
    const count = this.#accept(pid, bytes);
    if (count !== 0) return count;
    return new Promise((resolve, reject) => { this.#pending.set(pid, { request, bytes, resolve, reject }); });
  }

  pump(): void {
    for (const [pid, input] of this.#pending) {
      try {
        const count = this.#accept(pid, input.bytes);
        if (count === 0) continue;
        this.#pending.delete(pid);
        input.resolve(count);
      } catch (error) { this.rejectProcess(pid, error); }
    }
  }

  cancel(request: number): void {
    for (const [pid, input] of this.#pending) if (input.request === request) {
      this.rejectProcess(pid, new VMError("ABORTED", "Userspace stdin write cancelled"));
    }
  }

  rejectProcess(pid: number, error: unknown): void {
    const input = this.#pending.get(pid);
    this.#pending.delete(pid);
    input?.reject(error);
  }
}
