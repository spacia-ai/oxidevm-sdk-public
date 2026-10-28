import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeRestoreBegun, decodeRestoreStatus, decodeWorkspaceRestore, encodeWorkspaceRestore } from "./workspace-restore.js";

it("guest-seven restore operations match native golden bytes and reject ambiguous framing", () => {
  const fixture = readFileSync(new URL("../../../../../tests/fixtures/workspace/restore-v7.hex", import.meta.url), "utf8");
  for (const line of fixture.trim().split("\n")) {
    const [kind, hex] = line.split(" ");
    if (hex === undefined) throw new Error("invalid fixture");
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    const operation = decodeWorkspaceRestore(bytes, 7);
    expect(operation.kind).toBe(kind);
    expect(operation.transfer).toBe(9);
    expect(encodeWorkspaceRestore(operation, 7)).toEqual(bytes);
    for (const version of [3, 4, 5, 6, 8]) {
      expect(() => decodeWorkspaceRestore(bytes, version)).toThrow();
      expect(() => encodeWorkspaceRestore(operation, version)).toThrow();
    }
    for (let end = 0; end < bytes.length; end += 1) expect(() => decodeWorkspaceRestore(bytes.subarray(0, end), 7)).toThrow();
    expect(() => decodeWorkspaceRestore(Uint8Array.from([...bytes, 0]), 7)).toThrow();
    expect(() => encodeWorkspaceRestore({ ...operation, transfer: 0 }, 7)).toThrow();
    expect(() => encodeWorkspaceRestore({ ...operation, extra: true }, 7)).toThrow();
  }
});

it("bounds every restore allocation, offset, format and digest before encoding", () => {
  const chunk = { kind: "chunk", transfer: 1, offset: 0, sha256: new Uint8Array(32), data: new Uint8Array(1) };
  for (const value of [
    { kind: "begin", transfer: 1, format: "snapshot", bytes: 11 },
    { kind: "begin", transfer: 1, format: "snapshot", bytes: 1024 ** 4 + 1 },
    { kind: "begin", transfer: 1, format: "dependencies", bytes: 12 },
    { kind: "begin-dependencies", transfer: 1, bytes: 12, generation: new Uint8Array(31), inputs: new Uint8Array(32) },
    { kind: "begin-dependencies", transfer: 1, bytes: 12, generation: new Uint8Array(32), inputs: new Uint8Array(33) },
    { kind: "begin-dependencies", transfer: 1, bytes: 11, generation: new Uint8Array(32), inputs: new Uint8Array(32) },
    { ...chunk, offset: 1024 ** 4 }, { ...chunk, offset: -1 },
    { ...chunk, sha256: new Uint8Array(31) }, { ...chunk, sha256: new Uint8Array(33) },
    { ...chunk, data: new Uint8Array(0) }, { ...chunk, data: new Uint8Array(65_537) },
  ]) expect(() => encodeWorkspaceRestore(value, 7)).toThrow();
  const maximum = { ...chunk, data: new Uint8Array(65_536), offset: 1024 ** 4 - 65_536 };
  expect(decodeWorkspaceRestore(encodeWorkspaceRestore(maximum, 7), 7)).toEqual(maximum);
});

it("decodes the guest-seven dependency begin outcome as current or receive and rejects anything else", () => {
  expect(decodeRestoreBegun(Uint8Array.of(0), true)).toBe("receive");
  expect(decodeRestoreBegun(Uint8Array.of(1), true)).toBe("current");
  expect(decodeRestoreBegun(new Uint8Array(), false)).toBe("receive");
  for (const payload of [new Uint8Array(), Uint8Array.of(2), Uint8Array.of(0, 0)]) expect(() => decodeRestoreBegun(payload, true)).toThrow();
  for (const payload of [Uint8Array.of(0), Uint8Array.of(1)]) expect(() => decodeRestoreBegun(payload, false)).toThrow();
});

it("decodes a restore status as applying, done or failed with the agent's error and rejects malformed replies", () => {
  const header = (state: number, applied: number, total: number): number[] => [state, ...Array.from({ length: 8 }, (_, index) => Number((BigInt(applied) >> BigInt(index * 8)) & 0xffn)), ...Array.from({ length: 8 }, (_, index) => Number((BigInt(total) >> BigInt(index * 8)) & 0xffn))];
  expect(decodeRestoreStatus(Uint8Array.from(header(0, 3, 1927)))).toEqual({ state: "applying", applied: 3, total: 1927 });
  expect(decodeRestoreStatus(Uint8Array.from(header(1, 1927, 1927)))).toEqual({ state: "done", applied: 1927, total: 1927 });
  expect(decodeRestoreStatus(Uint8Array.from([...header(2, 5, 9), ...new TextEncoder().encode("EACCES")]))).toEqual({ state: "failed", applied: 5, total: 9, error: "EACCES" });
  for (const bytes of [header(3, 0, 0), header(0, 2, 1), header(0, 0, 0).slice(0, 16), [...header(1, 0, 0), 0]]) {
    expect(() => decodeRestoreStatus(Uint8Array.from(bytes))).toThrow(/restore/u);
  }
});
