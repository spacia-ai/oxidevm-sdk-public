// The core's network counters (ADR 0015), as oxidevm_system_network_counters writes them:
// version 1, 168 bytes, little-endian. Both directions must reconcile, or the record is a fault.
import { BinaryCursor, fault } from "./cursor.ts";

export const CORE_NETWORK_COUNTERS_VERSION = 1;
export const CORE_NETWORK_COUNTERS_BYTES = 168;

/** Frames dropped in one direction: its queue was full, or the frame was out of bounds. */
export interface CoreNetworkDrops {
  readonly queueFull: bigint;
  readonly oversize: bigint;
  readonly malformed: bigint;
}

export interface CoreNetworkCounters {
  readonly backend: "test-responder" | "host-link";
  readonly transmit: {
    readonly frames: bigint;
    readonly bytes: bigint;
    readonly responder: bigint;
    readonly takenFrames: bigint;
    readonly takenBytes: bigint;
    readonly drops: CoreNetworkDrops;
    readonly queued: bigint;
  };
  readonly receive: {
    readonly givenFrames: bigint;
    readonly givenBytes: bigint;
    readonly responderReplies: bigint;
    readonly drops: CoreNetworkDrops;
    readonly restored: bigint;
    readonly queued: bigint;
    readonly deliveredFrames: bigint;
    readonly deliveredBytes: bigint;
    readonly framingErrors: bigint;
  };
}

export function decodeCoreNetworkCounters(bytes: Uint8Array): CoreNetworkCounters {
  if (bytes.byteLength !== CORE_NETWORK_COUNTERS_BYTES) throw fault("core network counters have the wrong length");
  const cursor = new BinaryCursor(bytes);
  if (cursor.u32() !== CORE_NETWORK_COUNTERS_VERSION) throw fault("unsupported core network counters version");
  const backend = cursor.u32();
  if (backend !== 0 && backend !== 1) throw fault("unknown core network backend");
  const transmit = {
    frames: cursor.u64(),
    bytes: cursor.u64(),
    responder: cursor.u64(),
    takenFrames: cursor.u64(),
    takenBytes: cursor.u64(),
    drops: { queueFull: cursor.u64(), oversize: cursor.u64(), malformed: cursor.u64() },
    queued: cursor.u64(),
  };
  const givenFrames = cursor.u64();
  const givenBytes = cursor.u64();
  const responderReplies = cursor.u64();
  const receive = {
    givenFrames,
    givenBytes,
    responderReplies,
    drops: { queueFull: cursor.u64(), oversize: cursor.u64(), malformed: cursor.u64() },
    restored: cursor.u64(),
    queued: cursor.u64(),
    deliveredFrames: cursor.u64(),
    deliveredBytes: cursor.u64(),
    framingErrors: cursor.u64(),
  };
  cursor.finish("core network counters");
  const counters: CoreNetworkCounters = { backend: backend === 0 ? "test-responder" : "host-link", transmit, receive };
  if (!coreNetworkCountersReconcile(counters)) throw fault("core network counters do not reconcile");
  return counters;
}

/** Every frame Linux transmitted was handled, taken, is queued or was dropped; every frame meant
 * for Linux was delivered, is queued or was dropped. */
export function coreNetworkCountersReconcile(counters: CoreNetworkCounters): boolean {
  const { transmit, receive } = counters;
  const dropped = (drops: CoreNetworkDrops): bigint => drops.queueFull + drops.oversize + drops.malformed;
  return transmit.frames === transmit.responder + transmit.takenFrames + transmit.queued + dropped(transmit.drops)
    && receive.restored + receive.givenFrames + receive.responderReplies === receive.deliveredFrames + receive.queued + dropped(receive.drops);
}
