import { expect, it } from "vitest";

import { VMError } from "../../errors.js";
import { callNumber, memorySlice } from "./core.js";

/** A core whose one export returns `result` the way Wasm hands an i32 result to JavaScript. */
function exporting(result: unknown): { readonly exports: WebAssembly.Exports } {
  return { exports: { oxidevm_value: () => result } };
}

it("returns the u32 a core export produced, also for pointers above 2 GiB", () => {
  // Wasm hands every i32 result to JavaScript as a signed number, so the u32 pointer of an
  // allocation above 2 GiB (a System machine with 2,048 MiB or more) arrives negative.
  expect(callNumber(exporting(0), "oxidevm_value")).toBe(0);
  expect(callNumber(exporting(0x7fff_ffff), "oxidevm_value")).toBe(0x7fff_ffff);
  expect(callNumber(exporting(-0x8000_0000), "oxidevm_value")).toBe(0x8000_0000);
  expect(callNumber(exporting(0x80f4_a9a0 | 0), "oxidevm_value")).toBe(0x80f4_a9a0);
  expect(callNumber(exporting(-1), "oxidevm_value")).toBe(0xffff_ffff);
});

it("refuses an export result no u32 export produces", () => {
  for (const result of [undefined, 1n, 1.5, Number.NaN, 0x1_0000_0000, -0x8000_0001]) {
    expect(() => callNumber(exporting(result), "oxidevm_value")).toThrow(
      new VMError("VM_FAULT", "Wasm export oxidevm_value returned invalid data"),
    );
  }
});

it("takes the unsigned pointer callNumber returns", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer).set([1, 2, 3, 4], 0xfffc);
  expect([...memorySlice(memory, 0xfffc, 4)]).toEqual([1, 2, 3, 4]);
  for (const [pointer, length] of [[-4, 4], [0xfffd, 4], [0x1_0000_0000, 0], [0, -1]] as const) {
    expect(() => memorySlice(memory, pointer, length)).toThrow(/Wasm record is outside memory/u);
  }
});
