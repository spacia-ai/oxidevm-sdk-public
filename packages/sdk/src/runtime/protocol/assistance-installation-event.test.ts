import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeInstallationEvent, encodeInstallationEvent } from "./assistance-installation-event.js";
import { decodeInstallationRequest, encodeInstallationRequest, decodeInstallationBootstrap, encodeInstallationBootstrap } from "./assistance-installation.js";
import { decodeInstallationReply, encodeInstallationReply } from "./assistance-installation-reply.js";

it("guest seven preserves guest-six installation bytes and exact decoding", () => {
  const codecs = [
    ["event", decodeInstallationEvent, encodeInstallationEvent],
    ["request", decodeInstallationRequest, encodeInstallationRequest],
    ["reply", decodeInstallationReply, encodeInstallationReply],
    ["bootstrap", decodeInstallationBootstrap, encodeInstallationBootstrap],
  ] as const;
  for (const [name, decode, encode] of codecs) {
    const fixture = readFileSync(new URL(`../../../../../tests/fixtures/assistance/installation-${name}-v6.hex`, import.meta.url), "utf8");
    for (const line of fixture.trim().split("\n")) {
      const hex = line.split(" ")[1];
      if (hex === undefined) throw new Error("invalid fixture");
      const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
      const legacy = decode(bytes, 6);
      expect(decode(bytes, 7)).toEqual(legacy);
      expect(encode(legacy, 7)).toEqual(bytes);
      for (const version of [3, 4, 5, 8]) {
        expect(() => decode(bytes, version)).toThrow();
        expect(() => encode(legacy, version)).toThrow();
      }
      for (let end = 0; end < bytes.length; end += 1) expect(() => decode(bytes.subarray(0, end), 7)).toThrow();
      expect(() => decode(Uint8Array.from([...bytes, 0]), 7)).toThrow();
    }
  }
});

it("installation events retain native child handles under VM-scoped guest-six authority", () => {
  const fixture = readFileSync(new URL("../../../../../tests/fixtures/assistance/installation-event-v6.hex", import.meta.url), "utf8");
  for (const line of fixture.trim().split("\n")) {
    const [kind, hex] = line.split(" ");
    if (hex === undefined) throw new Error("invalid fixture");
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    const event = decodeInstallationEvent(bytes, 6);
    expect(event.installation).toBe(7);
    expect(event.event.kind).toBe(kind);
    expect(encodeInstallationEvent(event, 6)).toEqual(bytes);
    for (const version of [3, 4, 5]) {
      expect(() => decodeInstallationEvent(bytes, version)).toThrow();
      expect(() => encodeInstallationEvent(event, version)).toThrow();
    }
    for (let end = 0; end < bytes.length; end += 1) expect(() => decodeInstallationEvent(bytes.subarray(0, end), 6)).toThrow();
    expect(() => decodeInstallationEvent(Uint8Array.from([...bytes, 0]), 6)).toThrow();
    expect(() => encodeInstallationEvent({ ...event, process: 7 }, 6)).toThrow();
    expect(() => encodeInstallationEvent({ ...event, installation: 0 }, 6)).toThrow();
  }
});
