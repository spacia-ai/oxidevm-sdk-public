import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeWorkspaceCapture, encodeWorkspaceCapture, decodeWorkspaceCaptureProgress, encodeWorkspaceCaptureProgress } from "./workspace-capture.js";

it("matches native capture golden bytes and rejects unsupported dialects and malformed frames", () => {
  for (const line of readFileSync(new URL("../../../../../tests/fixtures/workspace/capture-v7.hex", import.meta.url), "utf8").trim().split("\n")) {
    const [kind, hex] = line.split(" ");
    if (hex === undefined) throw new Error("Invalid capture golden");
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    const operation = decodeWorkspaceCapture(bytes, 7);
    expect(operation.kind).toBe(kind);
    expect(encodeWorkspaceCapture(operation, 7)).toEqual(bytes);
    for (const version of [3, 4, 5, 6, 8]) {
      expect(() => decodeWorkspaceCapture(bytes, version)).toThrow();
      expect(() => encodeWorkspaceCapture(operation, version)).toThrow();
    }
    for (let end = 0; end < bytes.length; end++) expect(() => decodeWorkspaceCapture(bytes.subarray(0, end), 7)).toThrow();
    expect(() => decodeWorkspaceCapture(Uint8Array.from([...bytes, 0]), 7)).toThrow();
    expect(() => encodeWorkspaceCapture({ ...operation, transfer: 0 }, 7)).toThrow();
    expect(() => encodeWorkspaceCapture({ ...operation, extra: true }, 7)).toThrow();
  }
  expect(() => encodeWorkspaceCapture({ kind: "read", transfer: 1, offset: 1024 ** 4 + 1 }, 7)).toThrow();
});

it("matches versioned native progress bytes and rejects malformed or excessive counters", () => {
  for (const line of readFileSync(new URL("../../../../../tests/fixtures/workspace/capture-progress-v1.hex", import.meta.url), "utf8").trim().split("\n")) {
    const [phase, hex] = line.split(" ");
    if (hex === undefined) throw new Error("Invalid progress golden");
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    const value = decodeWorkspaceCaptureProgress(bytes);
    expect(value).toEqual({ phase, entries: 256 });
    expect(encodeWorkspaceCaptureProgress(value)).toEqual(bytes);
    for (let end = 0; end < bytes.length; end++) expect(() => decodeWorkspaceCaptureProgress(bytes.subarray(0, end))).toThrow();
    expect(() => decodeWorkspaceCaptureProgress(Uint8Array.from([...bytes, 0]))).toThrow();
    for (const [offset, invalid] of [[0, 2], [2, 4], [3, 1]] as const) {
      const changed = bytes.slice(); changed[offset] = invalid;
      expect(() => decodeWorkspaceCaptureProgress(changed)).toThrow();
    }
    expect(() => encodeWorkspaceCaptureProgress({ ...value, entries: 2_000_001 })).toThrow();
    expect(() => encodeWorkspaceCaptureProgress({ ...value, entries: -1 })).toThrow();
    expect(() => encodeWorkspaceCaptureProgress({ ...value, extra: true })).toThrow();
  }
});
