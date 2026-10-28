import { expect, it } from "vitest";
import { decodeControlIncoming, PROTOCOL_VERSION } from "../protocol.js";
it("preserves explicit guest cwd semantics and rejects ambiguous flags", () => {
  const channel = new MessageChannel();
  try {
    const input = { id: 1, version: PROTOCOL_VERSION, type: "agent-spawn", command: "/bin/sh", cwd: "/tmp", args: [], env: {}, port: channel.port1, guestPaths: true };
    expect(decodeControlIncoming(input)).toMatchObject({ guestPaths: true, cwd: "/tmp" });
    expect(() => decodeControlIncoming({ ...input, guestPaths: "true" })).toThrow();
  } finally { channel.port1.close(); channel.port2.close(); }
});
