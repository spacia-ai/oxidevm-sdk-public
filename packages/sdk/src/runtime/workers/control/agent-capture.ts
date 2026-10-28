import { AgentPayloadReader } from "../../agent-protocol.js";
import { integer } from "../../decode.js";
import { VMError, serializeUnknownError } from "../../errors.js";
import type { WorkspaceStreamInput } from "../workspace-stream.js";
import { decodeWorkspaceCaptureProgress, emptyCaptureCounts, type CaptureCounts, type WorkspaceCaptureProgress } from "../../protocol/workspace-capture.js";

/** Progress belongs to the same transfer until native retirement acknowledges it. */
export class AgentCaptureProgress {
  readonly #active = new Map<number, { counts: CaptureCounts; phase: number; receive: (event: WorkspaceCaptureProgress) => void }>();

  open(transfer: number, receive: (event: WorkspaceCaptureProgress) => void): () => void {
    integer(transfer, "capture transfer", 1, 0xffff_ffff);
    if (this.#active.size >= 2 || this.#active.has(transfer)) throw new VMError("PROTOCOL_ERROR", "Capture progress ownership is unavailable");
    const owner = { counts: emptyCaptureCounts(), phase: 0, receive };
    this.#active.set(transfer, owner);
    return () => { if (this.#active.get(transfer) === owner) this.#active.delete(transfer); };
  }

  receive(transfer: number, bytes: Uint8Array): void {
    const owner = this.#active.get(transfer);
    if (owner === undefined) throw new VMError("PROTOCOL_ERROR", "Unknown capture progress transfer");
    const event = decodeWorkspaceCaptureProgress(bytes);
    const phase = { baseline: 0, scan: 1, plan: 2, rescan: 3 }[event.phase];
    if (phase < owner.phase || event.entries < owner.counts[event.phase]
      || (event.phase !== "plan" && event.entries > 1_000_000)) {
      throw new VMError("PROTOCOL_ERROR", "Capture progress regressed or exceeded its phase bound");
    }
    owner.phase = phase;
    owner.counts[event.phase] = event.entries;
    owner.receive(event);
  }

  clear(): void { this.#active.clear(); }
}

type Operation = { readonly kind: "read"; readonly offset: number } | { readonly kind: "finish" | "abort" };

/** Adapter for the guest's existing capture producer. EOF and cancellation both
 * require a retirement receipt before storage can relinquish this source. */
export async function openAgentCapture(ready: Promise<Uint8Array<ArrayBuffer>>,
  send: (operation: Operation) => Promise<Uint8Array<ArrayBuffer>>, signal: AbortSignal, onRetired?: () => void,
): Promise<WorkspaceStreamInput & { retire(): Promise<void> }> {
  let opened = false;
  let stopped = false;
  let reading: Promise<Uint8Array<ArrayBuffer>> | undefined;
  let closing: Promise<void> | undefined;
  let retired = false;
  const retireOwner = (): void => { if (!retired) { retired = true; onRetired?.(); } };
  const cancelled = () => stopped;
  const detach: (() => void)[] = [];
  const retire = (): Promise<void> => {
    stopped = true;
    closing ??= (async () => {
      const receipt = send({ kind: "abort" });
      void receipt.catch(() => {});
      await Promise.allSettled([ready, ...(reading === undefined ? [] : [reading])]);
      if ((await receipt).length !== 0) throw new VMError("PROTOCOL_ERROR", "Invalid capture abort receipt");
      retireOwner();
    })();
    return closing.catch((error: unknown) => {
      throw new VMError("STORAGE_ERROR", "Workspace capture retirement is uncertain", {
        cleanupFailed: true, cause: error instanceof VMError ? error.code : "unknown-transport-failure",
        retirementError: serializeUnknownError(error),
      });
    }).finally(() => { for (const remove of detach.splice(0)) remove(); });
  };
  const bind = (signal: AbortSignal): void => {
    const abort = () => { void retire().catch(() => {}); };
    if (signal.aborted) abort();
    else { signal.addEventListener("abort", abort, { once: true }); detach.push(() => signal.removeEventListener("abort", abort)); }
  };
  bind(signal);
  let bytes: number;
  try {
    bytes = readLength(await ready);
    if (cancelled()) throw new VMError("ABORTED", "Workspace capture cancelled");
  } catch (error) {
    try { await retire(); }
    catch (retirement) {
      if (retirement instanceof VMError) throw new VMError(retirement.code, retirement.message, {
        ...retirement.detail, originalError: serializeUnknownError(error),
      });
      throw retirement;
    }
    throw error;
  }
  return { bytes, retire, source(sourceSignal) {
    if (opened) throw new VMError("PROTOCOL_ERROR", "Capture source already consumed");
    opened = true;
    bind(sourceSignal);
    return { retire, frames: (async function* (): AsyncGenerator<Uint8Array<ArrayBuffer>, void, unknown> {
      let offset = 0;
      try {
        for (;;) {
          if (cancelled()) throw new VMError("ABORTED", "Workspace capture cancelled");
          const pending = send({ kind: "read", offset });
          reading = pending;
          let frame: Uint8Array<ArrayBuffer>;
          try { frame = await pending; } finally { if (reading === pending) reading = undefined; }
          if (cancelled()) throw new VMError("ABORTED", "Workspace capture cancelled");
          if (frame.length > 65_536 || frame.length > bytes - offset) throw new VMError("PROTOCOL_ERROR", "Capture exceeded its declared length");
          if (frame.length === 0) {
            if (offset !== bytes) throw new VMError("PROTOCOL_ERROR", "Capture ended before its declared length");
            closing = send({ kind: "finish" }).then(receipt => {
              if (readLength(receipt) !== bytes) throw new VMError("PROTOCOL_ERROR", "Capture retirement length mismatch");
              retireOwner();
            });
            await closing;
            return;
          }
          offset += frame.length;
          yield frame;
        }
      } finally { await retire(); }
    })() };
  } };
}

function readLength(bytes: Uint8Array): number {
  const input = new AgentPayloadReader(bytes);
  const length = integer(Number(input.u64()), "capture bytes", 12, 1024 ** 4);
  input.finish();
  return length;
}
