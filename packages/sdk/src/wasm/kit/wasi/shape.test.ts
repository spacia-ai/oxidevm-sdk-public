import { describe, expect, it } from "vitest";
import { admitShape } from "./shape.js";
import { AdmissionError } from "./admission.js";
import { wasm } from "./wasm-builder.test-support.js";

const reason = (bytes: Uint8Array): string => { try { admitShape(bytes); return "admitted"; } catch (error) { return error instanceof AdmissionError ? error.message : `other: ${String(error)}`; } };
function withTable(max: number | null): Uint8Array {
  const base = wasm({ memory: { min: 1, max: 1 } });
  // Insert a table section (id 4) before the memory section: funcref, min 1, optional max.
  const limits = max === null ? [0x00, 0x01] : [0x01, 0x01, ...leb(max)];
  const section = [0x04, limits.length + 2, 0x01, 0x70, ...limits];
  const memoryAt = base.findIndex((byte, index) => byte === 0x05 && base[index + 2] === 0x01 && index > 8);
  return Uint8Array.from([...base.subarray(0, memoryAt), ...section, ...base.subarray(memoryAt)]);
}
function leb(value: number): number[] { const out: number[] = []; let rest = value; do { let byte = rest & 0x7f; rest = Math.floor(rest / 128); if (rest !== 0) byte |= 0x80; out.push(byte); } while (rest !== 0); return out; }

describe("program shape admission (OBL-ADMISSION, OBL-TABLE-LIMIT)", () => {
  it("admits the profile's bounds", () => {
    expect(reason(wasm({ memory: { min: 1, max: 4096 } }))).toBe("admitted");
    expect(reason(withTable(65536))).toBe("admitted");
  });

  it("refuses each unsupported form with its reason", () => {
    expect(reason(wasm({ memory: { min: 1, max: 4097 } }))).toMatch(/maximum of at most 4096 pages/u);
    expect(reason(wasm({ memory: { min: 1, max: null } }))).toMatch(/without a maximum/u);
    expect(reason(wasm({ importMemory: true, exportMemory: false }))).toBe("imports its memory");
    expect(reason(wasm({ start: true }))).toBe("has a start section");
    expect(reason(withTable(65537))).toMatch(/table without a maximum of at most 65536/u);
    expect(reason(withTable(null))).toMatch(/table without a maximum/u);
    expect(reason(Uint8Array.of(0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0))).toMatch(/component/u);
    expect(reason(Uint8Array.of(1, 2, 3))).toBe("is not a WebAssembly binary");
    expect(reason(wasm().subarray(0, 20))).toMatch(/truncated|past its end/u);
  });

  it("refuses shared and 64-bit memories", () => {
    const shared = wasm({ memory: { min: 1, max: 1 } }), memoryAt = shared.findIndex((byte, index) => byte === 0x05 && index > 8);
    const patched = Uint8Array.from(shared); patched[memoryAt + 3] = 0x03;
    expect(reason(patched)).toBe("defines a shared memory");
    patched[memoryAt + 3] = 0x05;
    expect(reason(patched)).toBe("defines a 64-bit memory");
  });

  it("refuses 32 MiB + 1 bytes before reading any section", () => {
    expect(reason(new Uint8Array(32 * 1024 * 1024 + 1))).toMatch(/larger than 33554432 bytes/u);
  });
});
