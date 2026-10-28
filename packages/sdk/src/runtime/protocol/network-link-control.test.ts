import { describe, expect, it } from "vitest";

import { VMError } from "../errors.ts";
import { createFrameBridgeBuffer } from "../frame-bridge.ts";
import { decodeControlIncoming, PROTOCOL_VERSION } from "../protocol.ts";

function codeOf(value: unknown): string {
  try {
    decodeControlIncoming(value);
  } catch (error: unknown) {
    if (error instanceof VMError) return error.code;
    throw error;
  }
  return "decoded";
}

describe("network link control requests", () => {
  it("hands control its end of the frame bridge and nothing else", () => {
    const { port1: doorbell, port2 } = new MessageChannel();
    const request = { version: PROTOCOL_VERSION, id: 1, type: "network-link-connect", bridge: createFrameBridgeBuffer(), doorbell };
    try {
      expect(decodeControlIncoming(request)).toEqual(request);
      for (const bad of [
        { ...request, extra: true },
        { ...request, doorbell: {} },
        { ...request, bridge: new SharedArrayBuffer(1024) },
        { ...request, bridge: new ArrayBuffer(1024) },
        { ...request, version: PROTOCOL_VERSION - 1 },
        { version: PROTOCOL_VERSION, id: 1, type: "network-link-connect", bridge: request.bridge },
      ]) expect(codeOf(bad)).toBe("PROTOCOL_ERROR");
    } finally {
      doorbell.close();
      port2.close();
    }
  });

  it("takes a network worker failure without a caller-supplied reason", () => {
    const failure = { version: PROTOCOL_VERSION, id: 2, type: "network-link-failed" };
    expect(decodeControlIncoming(failure)).toEqual(failure);
    expect(codeOf({ ...failure, reason: "trap" })).toBe("PROTOCOL_ERROR");
  });
});
