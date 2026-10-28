import { describe, expect, it } from "vitest";
import { createCoreEntropyImport } from "./entropy.ts";

describe("bounded core entropy capability", () => {
  it("fills exactly eight bytes at a validated pointer once", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    new Uint8Array(memory.buffer).fill(0x55);
    let calls = 0;
    const request = createCoreEntropyImport(() => memory, bytes => { calls++; bytes.fill(0xa5); });
    expect(request(17, 8)).toBe(0);
    expect(calls).toBe(1);
    expect(Array.from(new Uint8Array(memory.buffer, 16, 10))).toEqual([0x55, ...Array<number>(8).fill(0xa5), 0x55]);
  });

  it("rejects uninitialized, invalid, oversized, and out-of-bounds requests before acquisition", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    let calls = 0;
    const fill = () => { calls++; };
    expect(createCoreEntropyImport(() => undefined, fill)(0, 8)).toBe(1);
    const request = createCoreEntropyImport(() => memory, fill);
    for (const [pointer, length] of [[0, 0], [0, 7], [0, 9], [0, 65536], [-1, 8], [-0x8000_0001, 8], [0x1_0000_0000, 8], [0.5, 8], [NaN, 8], [65529, 8]]) {
      expect(request(pointer ?? NaN, length ?? NaN)).toBe(1);
    }
    expect(calls).toBe(0);
  });

  it("returns unavailable on a host failure without retrying", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    new Uint8Array(memory.buffer).fill(0x55);
    let calls = 0;
    const request = createCoreEntropyImport(() => memory, bytes => { calls++; bytes.fill(7); throw new Error("unavailable"); });
    expect(request(0, 8)).toBe(1);
    expect(calls).toBe(1);
    expect(Array.from(new Uint8Array(memory.buffer, 0, 8))).toEqual(Array<number>(8).fill(0x55));
  });

  it("acquires into an ordinary buffer before copying to shared Wasm memory", () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const request = createCoreEntropyImport(() => memory, bytes => {
      expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
      bytes.fill(9);
    });
    expect(request(0, 8)).toBe(0);
    expect(Array.from(new Uint8Array(memory.buffer, 0, 8))).toEqual(Array<number>(8).fill(9));
  });

  it("uses the current memory buffer after growth", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const request = createCoreEntropyImport(() => memory, bytes => { bytes.fill(7); });
    memory.grow(1);
    expect(request(65536, 8)).toBe(0);
    expect(Array.from(new Uint8Array(memory.buffer, 65536, 8))).toEqual(Array<number>(8).fill(7));
  });
});
