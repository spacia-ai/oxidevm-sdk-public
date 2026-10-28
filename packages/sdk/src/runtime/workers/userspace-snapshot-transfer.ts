import { integer } from "../decode.js";
import { VMError } from "../errors.js";
import type { UserspaceCapture, UserspacePrecopy } from "./userspace-checkpoint.js";
import type { SnapshotStorageClient } from "./snapshot-channel.js";

type Capture = Pick<UserspaceCapture, "finish" | "abort">;
type Precopy = Pick<UserspacePrecopy, "transferRound" | "commitRound" | "finalize" | "finish" | "abort">;
export interface NativeCheckpointTransferRuntime {
  freeze(signal?: AbortSignal): Promise<void>;
  beginCapture(): Pick<UserspaceCapture, "transfer" | "finish" | "abort">;
  beginPrecopy(baseline?: bigint): Precopy;
}
export type NativeCheckpointTransferOptions =
  | { readonly kind: "precopy"; readonly rounds?: 1 | 2 | 3; readonly signal?: AbortSignal; readonly baseline?: bigint }
  | { readonly kind: "frozen"; readonly alreadyFrozen: boolean; readonly signal?: AbortSignal };
export interface NativeCheckpointTransfer {
  readonly capture: Capture;
  readonly graphBytes: number;
  readonly payloadBytes: number;
  readonly pauseStartedAt: number;
}
type Storage = Pick<SnapshotStorageClient, "request">;

/** The caller opens a fresh storage capture and commits its manifest. This owner moves bytes
 * and keeps the native final cut held; it never acknowledges the final dirty generation. */
export async function transferNativeCheckpoint(runtime: NativeCheckpointTransferRuntime, storage: Storage,
  options: NativeCheckpointTransferOptions): Promise<NativeCheckpointTransfer> {
  let capture: Capture | undefined;
  const signal = options.signal;
  try {
    active(signal);
    if (options.kind === "frozen") {
      const pauseStartedAt = performance.now();
      if (!options.alreadyFrozen) await runtime.freeze(signal);
      active(signal); const frozen = runtime.beginCapture(); capture = frozen;
      const lengths = await frozen.transfer(async (area, index, data) => {
        await storage.request({ type: "put-native-chunk", area, index, data }, [data.buffer], signal);
      }, signal);
      active(signal); return { capture, ...lengths, pauseStartedAt };
    }
    const precopy = runtime.beginPrecopy(options.baseline); capture = precopy;
    const count = integer(options.rounds ?? 3, "native precopy rounds", 1, 3);
    for (let round = 0; round < count; round++) {
      await storage.request({ type: "native-payload-round-open", round }, [], signal);
      const received = await precopy.transferRound(async (index, data) => {
        await storage.request({ type: "native-payload-round-put", round, index, data }, [data.buffer], signal);
      }, signal);
      if (received.round !== round) invalid("Native precopy returned a different round");
      await storage.request({ type: "native-payload-round-seal", round, bytes: received.payloadBytes }, [], signal);
      active(signal); precopy.commitRound();
    }
    const pauseStartedAt = performance.now();
    await runtime.freeze(signal); active(signal);
    const lengths = await finalRound(precopy, storage, count, signal);
    return { capture, ...lengths, pauseStartedAt };
  } catch (error) {
    let cleanupFailed = error instanceof VMError && error.detail?.["cleanupFailed"] === true;
    try { capture?.abort(); } catch { cleanupFailed = true; }
    try { await storage.request({ type: "abort" }); } catch { cleanupFailed = true; }
    if (cleanupFailed) throw new VMError("STORAGE_ERROR", "Native checkpoint capture could not confirm cancellation", {
      reason: "checkpoint-capture-cleanup-failed", cleanupFailed: true,
    });
    throw error;
  }
}
async function finalRound(capture: Precopy, storage: Storage, round: number, signal?: AbortSignal): Promise<{ readonly graphBytes: number; readonly payloadBytes: number }> {
  await storage.request({ type: "native-payload-round-open", round }, [], signal);
  const received = await capture.finalize(async (area, index, data) => {
    await storage.request(area === "graph" ? { type: "put-native-chunk", area, index, data }
      : { type: "native-payload-round-put", round, index, data }, [data.buffer], signal);
  }, async (index, data) => {
    await storage.request({ type: "native-live-index-put", index, data }, [data.buffer], signal);
  }, signal);
  if (received.round !== round) invalid("Native final capture returned a different round");
  await storage.request({ type: "native-payload-round-seal", round, bytes: received.payloadBytes }, [], signal);
  await storage.request({ type: "native-live-index-seal", bytes: received.liveIndexBytes }, [], signal);
  const payloadBytes = integer(await storage.request({ type: "native-payload-consolidate" }, [], signal), "native consolidated bytes", 16, 16 * 1024 ** 3);
  active(signal); return { graphBytes: received.graphBytes, payloadBytes };
}
function active(signal?: AbortSignal): void { if (signal?.aborted === true) throw new VMError("ABORTED", "Native checkpoint transfer cancelled"); }
function invalid(message: string): never { throw new VMError("PROTOCOL_ERROR", message); }
