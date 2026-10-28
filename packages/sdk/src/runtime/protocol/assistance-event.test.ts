import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeAssistanceEvent, encodeAssistanceEvent } from "./assistance-event.js";

const identity = { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 2, sequence: 0xffff_ffff };
describe("assistance child events", () => {
  it("matches Rust golden bytes and rejects incomplete and trailing frames", () => {
    const fixture = readFileSync(new URL("../../../../../tests/fixtures/assistance/task-event-v4.hex", import.meta.url), "utf8");
    for (const line of fixture.trim().split("\n")) {
      const [kind, hex] = line.split(" ");
      if (hex === undefined) throw new Error("invalid fixture");
      const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
      const event = decodeAssistanceEvent(bytes);
      expect(event.event.kind).toBe(kind);
      expect(encodeAssistanceEvent(event)).toEqual(bytes);
      for (let end = 0; end < bytes.length; end += 1) expect(() => decodeAssistanceEvent(bytes.subarray(0, end))).toThrow();
      expect(() => decodeAssistanceEvent(Uint8Array.from([...bytes, 0]))).toThrow();
    }
  });
  it("copies bounded output and preserves unsigned sequences", () => {
    const bytes = new Uint8Array(65536).fill(127);
    const message = { ...identity, event: { kind: "output", child: 1, stream: "stdout", bytes } };
    const encoded = encodeAssistanceEvent(message);
    const decoded = decodeAssistanceEvent(encoded);
    encoded.fill(0);
    expect(decoded).toEqual(message);
    for (const length of [0, 65537]) expect(() => encodeAssistanceEvent({ ...identity, event: { ...message.event, bytes: new Uint8Array(length) } })).toThrow();
  });
  it("rejects ambiguous exits, unknown streams, extra fields and exhausted identities", () => {
    const event = { kind: "exit", child: 1, code: 0, signal: null };
    expect(() => encodeAssistanceEvent({ ...identity, event: { ...event, signal: 9 } })).toThrow();
    expect(() => encodeAssistanceEvent({ ...identity, event: { ...event, code: null } })).toThrow();
    expect(() => encodeAssistanceEvent({ ...identity, event: { ...event, extra: true } })).toThrow();
    expect(() => encodeAssistanceEvent({ ...identity, sequence: 0x100000000, event })).toThrow();
    expect(() => encodeAssistanceEvent({ ...identity, event: { kind: "eof", child: 1, stream: "stdin" } })).toThrow();
  });
});
