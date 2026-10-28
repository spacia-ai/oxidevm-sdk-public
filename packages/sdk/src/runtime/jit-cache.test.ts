import { describe, expect, it } from "vitest";

import {
  decodeJitCacheIndex,
  encodeJitCacheIndex,
  equalBytes,
  findContiguousJitSlots,
  JIT_CACHE_BYTES,
  JIT_DISPATCH_TABLE_ENTRIES,
  USERSPACE_JIT_CACHE_BYTES,
} from "./jit-cache.js";

describe("persistent JIT cache codec", () => {
  it("uses a two-GiB compiled-module budget in both modes", () => {
    expect(USERSPACE_JIT_CACHE_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(USERSPACE_JIT_CACHE_BYTES).toBe(JIT_CACHE_BYTES);
  });

  it("holds a dispatch slot for every translation the byte cache keeps", () => {
    expect(JIT_DISPATCH_TABLE_ENTRIES).toBe(65_536);
  });

  it("round-trips ordered entries and compares exact module bytes", () => {
    const entries = new Map([
      ["abcd:8", 8],
      ["1234:16", 16],
    ]);
    expect(decodeJitCacheIndex(JSON.parse(encodeJitCacheIndex(entries)))).toEqual(
      entries,
    );
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(
      true,
    );
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(
      false,
    );
  });

  it("compares only the requested byte views and detects every differing byte", () => {
    for (const length of [0, 1, 3, 4, 9, 32, 511, 512, 513, 1_025]) {
      const left = new Uint8Array(length + 9).fill(0xa5).subarray(1, length + 1);
      const right = new Uint8Array(length + 11).fill(0x5a).subarray(3, length + 3);
      left.forEach((_, index) => { left[index] = index & 0xff; });
      right.set(left);
      expect(equalBytes(left, right)).toBe(true);
      for (let index = 0; index < length; index += 1) {
        right[index] = (left[index] ?? 0) ^ 1;
        expect(equalBytes(left, right)).toBe(false);
        right[index] = left[index] ?? 0;
      }
      expect(equalBytes(left, right)).toBe(true);
      expect(equalBytes(left, new Uint8Array(length + 1))).toBe(false);
    }
  });

  it("rejects a detached source rather than certifying an empty byte view", () => {
    const source = new Uint8Array(8);
    structuredClone(source.buffer, { transfer: [source.buffer] });
    expect(() => equalBytes(source, new Uint8Array())).toThrow(TypeError);
    expect(() => equalBytes(new Uint8Array(), source)).toThrow(TypeError);
    expect(equalBytes(new Uint8Array(), new Uint8Array())).toBe(true);
  });

  it.each([
    {},
    { version: 2, entries: [] },
    { version: 1, entries: [], extra: true },
    { version: 1, entries: [{ key: "bad", bytes: 8 }] },
    { version: 1, entries: [{ key: "abcd:8", bytes: 7 }] },
    {
      version: 1,
      entries: [
        { key: "abcd:8", bytes: 8 },
        { key: "abcd:8", bytes: 8 },
      ],
    },
  ])("rejects malformed persisted indexes", (value) => {
    expect(() => decodeJitCacheIndex(value)).toThrow();
  });

  it("reuses a contiguous dispatch-table hole before evicting live slots", () => {
    expect(findContiguousJitSlots(new Set([0, 1, 6, 7]), 2, 6, 8)).toBe(2);
    expect(findContiguousJitSlots(new Set([0, 2, 4, 6]), 2, 6, 8)).toBeNull();
    expect(findContiguousJitSlots(new Set<number>(), 2, 7, 8)).toBe(0);
    expect(() => findContiguousJitSlots(new Set<number>(), 0, 0, 8)).toThrow(
      RangeError,
    );
  });

  it("does not probe a dispatch table already known to be full", () => {
    let probes = 0;
    const occupied = {
      size: 8,
      has: () => {
        probes += 1;
        return true;
      },
    };

    expect(findContiguousJitSlots(occupied, 1, 6, 8)).toBeNull();
    expect(probes).toBe(0);
  });
});
