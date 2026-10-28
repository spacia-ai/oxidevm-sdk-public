import { AgentKind, AgentPayloadReader } from "../../agent-protocol.js";
import type { AgentFrame } from "../../agent-protocol.js";
import { VMError } from "../../errors.js";

/** The capture transfer owns its progress through the native retirement receipt. */
export class CaptureProgressEvents {
  readonly #captures = new Map<number, { work: bigint; readonly progress: (() => void) | undefined }>();
  open(transfer: number, progress?: () => void): void {
    if (this.#captures.size >= 2 || this.#captures.has(transfer)) throw new VMError("PROTOCOL_ERROR", "capture progress capacity or identity is unavailable");
    this.#captures.set(transfer, { work: 0n, progress });
  }
  retire(transfer: number): void { this.#captures.delete(transfer); }
  clear(): void { this.#captures.clear(); }
  receive(frame: AgentFrame): void {
    if (frame.version !== 7 || frame.kind !== AgentKind.captureProgress || frame.status !== 0) throw new VMError("PROTOCOL_ERROR", "invalid capture progress dialect or envelope");
    const input = new AgentPayloadReader(frame.payload); const transfer = input.u32(); const work = input.u64(); input.finish();
    if (transfer === 0 || transfer !== frame.requestId) throw new VMError("PROTOCOL_ERROR", "capture progress identity mismatch");
    const capture = this.#captures.get(transfer);
    if (capture === undefined) throw new VMError("PROTOCOL_ERROR", "capture progress belongs to a retired transfer");
    if (work > BigInt(Number.MAX_SAFE_INTEGER)) throw new VMError("PROTOCOL_ERROR", "capture work exceeds its bound");
    if (work <= capture.work) throw new VMError("PROTOCOL_ERROR", "capture progress is stale");
    capture.work = work; capture.progress?.();
  }
}
