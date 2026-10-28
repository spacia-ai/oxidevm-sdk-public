import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodeAgentFileEntry, decodeAgentFileEntries, encodeAgentFileRequest } from "./agent-files.js";

describe("native agent file records", () => {
  it("decodes the shared native vector without losing 64-bit version identity", () => {
    const hex = readFileSync(new URL("../../../../../tests/fixtures/agent/workspace-files.hex", import.meta.url), "utf8").trim();
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    expect(decodeAgentFileEntry(bytes, "/file")).toEqual({
      kind: "file", link: null, name: "file", path: "/file", size: 3,
      version: "09000000000000000a000000000000000b00000000000000",
    });
    expect(() => decodeAgentFileEntry(bytes.slice(0, -1), "/file")).toThrow();
    expect(() => decodeAgentFileEntry(Uint8Array.from([...bytes, 0]), "/file")).toThrow();
  });

  it("refuses unsorted, oversized and malicious directory records", () => {
    expect(() => decodeAgentFileEntries(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0), "/")).toThrow();
    expect(() => encodeAgentFileRequest({ operation: "stat", path: "../escape" })).toThrow();
    expect(() => encodeAgentFileRequest({ operation: "read", path: "/file", maxBytes: 16 * 1024 * 1024 + 1 })).toThrow();
  });
});
