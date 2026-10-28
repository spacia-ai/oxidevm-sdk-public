import { expect, it } from "vitest";
import { decodeJitAliasEvents } from "./jit-aliases.js";

function batch(): Uint8Array {
  const bytes = new Uint8Array(53);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OXJB"));
  view.setUint16(4, 1, true);
  view.setUint32(8, bytes.length - 12, true);
  view.setUint32(12, 1, true);
  view.setBigUint64(16, 7n, true);
  view.setBigUint64(24, 9n, true);
  view.setUint32(32, 80, true);
  view.setBigUint64(36, 11n, true);
  view.setUint32(44, 81, true);
  view.setUint32(48, 1, true);
  bytes[52] = 0;
  return bytes;
}

it("decodes a bounded alias batch with exact artifact and binding identity", () => {
  expect(decodeJitAliasEvents(batch())).toEqual([
    { sequence: 7n, artifactCacheKey: 9n, artifactModuleLength: 80,
      cacheKey: 11n, moduleLength: 81, suffix: Uint8Array.of(0) },
  ]);
});

it("rejects malformed headers, bounds, counts and zero identities", () => {
  for (const offset of [0, 4, 6, 8, 12, 16, 24, 32, 36, 44, 48]) {
    const bytes = batch();
    bytes[offset] = 255;
    if ([16, 24, 36].includes(offset)) bytes.fill(0, offset, offset + 8);
    expect(() => decodeJitAliasEvents(bytes)).toThrow();
  }
  expect(() => decodeJitAliasEvents(batch().subarray(0, 52))).toThrow();
  expect(() => decodeJitAliasEvents(new Uint8Array(1024 * 1024 + 1))).toThrow();
});
