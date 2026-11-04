import { describe, expect, it } from "vitest";
import { GuestFault, GuestMemory } from "./memory.js";
import { LIMITS } from "./limits.js";

const PAGE = 65536;
const guest = (pages = 1) => { const memory = new WebAssembly.Memory({ initial: pages, maximum: 4 }); return { memory, view: new GuestMemory(memory) }; };

describe("checked guest memory (OBL-MEMORY)", () => {
  it("accepts the last byte and the empty range at the end, and refuses one byte past it", () => {
    const { view } = guest();
    expect(() => { view.check(PAGE - 1, 1); }).not.toThrow();
    expect(() => { view.check(PAGE, 0); }).not.toThrow();
    expect(() => { view.check(PAGE, 1); }).toThrow(GuestFault);
    expect(() => { view.check(PAGE - 3, 4); }).toThrow(GuestFault);
  });

  it("refuses ranges whose end wraps past 2^32, and values that are not guest u32 integers", () => {
    const { view } = guest();
    expect(() => { view.check(0xffff_fff0, 0x20); }).toThrow(GuestFault);
    for (const [pointer, length] of [[-1, 1], [0, -1], [1.5, 1], [2 ** 32, 0], [0, 2 ** 32]] as const) expect(() => { view.check(pointer, length); }).toThrow(GuestFault);
  });

  it("refuses an out-of-range write before changing any byte", () => {
    const { memory, view } = guest();
    expect(() => { view.write(PAGE - 2, Uint8Array.of(1, 2, 3)); }).toThrow(GuestFault);
    expect(new Uint8Array(memory.buffer, PAGE - 2, 2)).toEqual(Uint8Array.of(0, 0));
  });

  it("sees memory.grow between calls instead of a detached buffer", () => {
    const { memory, view } = guest();
    expect(() => { view.check(PAGE, 8); }).toThrow(GuestFault);
    memory.grow(1);
    view.setU64(PAGE, 0xffff_ffff_ffff_ffffn);
    expect(view.u64(PAGE)).toBe(0xffff_ffff_ffff_ffffn);
  });

  it("copies reads, so the host keeps no view into guest memory", () => {
    const { view } = guest();
    view.write(16, Uint8Array.of(7));
    const copy = view.read(16, 1);
    view.write(16, Uint8Array.of(9));
    expect(copy).toEqual(Uint8Array.of(7));
  });
});

describe("iovec lists (OBL-IO-BOUNDS)", () => {
  const list = (lengths: readonly number[], pages = 32) => {
    const { view } = guest(Math.min(pages, 4));
    lengths.forEach((length, index) => { view.setU32(index * 8, 4096); view.setU32(index * 8 + 4, length); });
    return view;
  };

  it("accepts 0, 1 and 128 entries, and refuses 129 before reading any of them", () => {
    expect(list([]).ioVectors(0, 0)).toEqual([]);
    expect(list([1]).ioVectors(0, 1)).toEqual([{ pointer: 4096, length: 1 }]);
    expect(list(Array.from({ length: LIMITS.iovecs }, () => 0)).ioVectors(0, LIMITS.iovecs)).toHaveLength(128);
    expect(() => list(Array.from({ length: 129 }, () => 0)).ioVectors(0, 129)).toThrow(/iovec count 129/u);
  });

  it("accepts an aggregate of exactly 1 MiB and refuses one byte more", () => {
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 32 }), view = new GuestMemory(memory);
    view.setU32(0, 4096); view.setU32(4, LIMITS.ioBytes);
    expect(view.ioVectors(0, 1)).toEqual([{ pointer: 4096, length: LIMITS.ioBytes }]);
    view.setU32(8, 4096); view.setU32(12, 1);
    expect(() => view.ioVectors(0, 2)).toThrow(/total exceeds/u);
  });

  it("refuses a buffer outside memory", () => {
    const view = list([4 * PAGE]);
    expect(() => view.ioVectors(0, 1)).toThrow(GuestFault);
  });
});
