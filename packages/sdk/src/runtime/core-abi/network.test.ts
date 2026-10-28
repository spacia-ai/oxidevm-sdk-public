import { describe, expect, it } from "vitest";

import { CoreAbiError } from "./cursor.ts";
import { CORE_NETWORK_COUNTERS_BYTES, coreNetworkCountersReconcile, decodeCoreNetworkCounters } from "./network.ts";

/** The core's counter fields, in record order. */
const FIELDS = [
  "transmittedFrames", "transmittedBytes", "responderFrames", "takenFrames", "takenBytes",
  "txQueueFull", "txOversize", "txMalformed", "transmitQueued",
  "givenFrames", "givenBytes", "responderReplies",
  "rxQueueFull", "rxOversize", "rxMalformed", "receiveRestored", "receiveQueued",
  "receivedFrames", "receivedBytes", "giveFramingErrors",
] as const;
type Field = typeof FIELDS[number];

/** Transmit: 5 = responder 2 + taken 1 + queued 1 + oversize 1. Receive: restored 1 + given 4 +
 * replies 2 = received 3 + queued 2 + queue-full 1 + malformed 1. */
const CONSISTENT: Readonly<Record<Field, bigint>> = {
  transmittedFrames: 5n, transmittedBytes: 3_000n, responderFrames: 2n, takenFrames: 1n, takenBytes: 60n,
  txQueueFull: 0n, txOversize: 1n, txMalformed: 0n, transmitQueued: 1n,
  givenFrames: 4n, givenBytes: 2_000n, responderReplies: 2n,
  rxQueueFull: 1n, rxOversize: 0n, rxMalformed: 1n, receiveRestored: 1n, receiveQueued: 2n,
  receivedFrames: 3n, receivedBytes: 180n, giveFramingErrors: 1n,
};

function record(fields: Partial<Record<Field, bigint>> = {}, header: { readonly version?: number; readonly backend?: number } = {}): Uint8Array {
  const bytes = new Uint8Array(CORE_NETWORK_COUNTERS_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, header.version ?? 1, true);
  view.setUint32(4, header.backend ?? 1, true);
  FIELDS.forEach((name, index) => { view.setBigUint64(8 + index * 8, fields[name] ?? CONSISTENT[name], true); });
  return bytes;
}

function faultOf(run: () => unknown): string {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof CoreAbiError) return error.code;
    throw error;
  }
  return "no error";
}

describe("core network counters", () => {
  it("decodes version 1 into the two directions", () => {
    expect(CORE_NETWORK_COUNTERS_BYTES).toBe(168);
    const counters = decodeCoreNetworkCounters(record());
    expect(counters).toEqual({
      backend: "host-link",
      transmit: {
        frames: 5n, bytes: 3_000n, responder: 2n, takenFrames: 1n, takenBytes: 60n,
        drops: { queueFull: 0n, oversize: 1n, malformed: 0n }, queued: 1n,
      },
      receive: {
        givenFrames: 4n, givenBytes: 2_000n, responderReplies: 2n,
        drops: { queueFull: 1n, oversize: 0n, malformed: 1n },
        restored: 1n, queued: 2n, deliveredFrames: 3n, deliveredBytes: 180n, framingErrors: 1n,
      },
    });
    expect(coreNetworkCountersReconcile(counters)).toBe(true);
    expect(decodeCoreNetworkCounters(record({}, { backend: 0 })).backend).toBe("test-responder");
  });

  it.each([
    ["a short record", () => decodeCoreNetworkCounters(record().slice(0, 167))],
    ["a long record", () => decodeCoreNetworkCounters(Uint8Array.of(...record(), 0))],
    ["version 2", () => decodeCoreNetworkCounters(record({}, { version: 2 }))],
    ["backend 2", () => decodeCoreNetworkCounters(record({}, { backend: 2 }))],
    ["a transmit side that does not add up", () => decodeCoreNetworkCounters(record({ transmittedFrames: 6n }))],
    ["a receive side that does not add up", () => decodeCoreNetworkCounters(record({ receivedFrames: 4n }))],
  ])("rejects %s as a VM fault", (_name, run) => {
    expect(faultOf(run)).toBe("VM_FAULT");
  });
});
