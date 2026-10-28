import { describe, expect, it } from "vitest";

import { VMError } from "../errors.ts";
import { decodeControlIncoming, PROTOCOL_VERSION } from "../protocol.ts";
import { decodeListeningPorts, decodeListeningPortsMessage } from "./listening-ports.ts";

const PORT = { port: 3000, address: "0.0.0.0", program: "bun dev", previewable: true };

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof VMError) return error.code;
    throw error;
  }
  return "decoded";
}

describe("listening-port control messages", () => {
  it("decodes the three control requests exactly", () => {
    const { port1, port2 } = new MessageChannel();
    try {
      const watch = { id: 1, version: PROTOCOL_VERSION, type: "agent-listeners-watch", port: port1 };
      expect(decodeControlIncoming(watch)).toEqual(watch);
      expect(codeOf(() => decodeControlIncoming({ ...watch, port: {} }))).toBe("PROTOCOL_ERROR");
      for (const type of ["agent-listeners-unwatch", "agent-listeners-list"]) {
        const request = { id: 2, version: PROTOCOL_VERSION, type };
        expect(decodeControlIncoming(request)).toEqual(request);
        expect(codeOf(() => decodeControlIncoming({ ...request, extra: 1 }))).toBe("PROTOCOL_ERROR");
      }
    } finally {
      port1.close();
      port2.close();
    }
  });

  it("decodes port lists strictly", () => {
    expect(decodeListeningPorts([PORT, { ...PORT, port: 4002, address: "::1", program: null, previewable: false }]))
      .toEqual([PORT, { ...PORT, port: 4002, address: "::1", program: null, previewable: false }]);
    for (const bad of [
      [{ ...PORT, port: 0 }],
      [{ ...PORT, port: 65_536 }],
      [{ ...PORT, extra: 1 }],
      [{ ...PORT, program: "x".repeat(257) }],
      [{ ...PORT, address: "" }],
      [{ ...PORT, previewable: "yes" }],
      new Array(257).fill(PORT),
      "ports",
    ]) expect(codeOf(() => decodeListeningPorts(bad))).toBe("PROTOCOL_ERROR");
  });

  it("decodes the watch port's messages", () => {
    expect(decodeListeningPortsMessage({ type: "ports", ports: [PORT] })).toEqual({ type: "ports", ports: [PORT] });
    const failure = { type: "failed", error: { code: "FEATURE_NOT_AVAILABLE", message: "update", detail: { reason: "image-update-required" } } };
    expect(decodeListeningPortsMessage(failure)).toEqual(failure);
    for (const bad of [{ type: "ports" }, { type: "ports", ports: [], extra: 1 }, { type: "other" }, { type: "failed", error: { code: "NOPE", message: "x" } }]) {
      expect(codeOf(() => decodeListeningPortsMessage(bad))).toBe("PROTOCOL_ERROR");
    }
  });
});
