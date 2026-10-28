import { describe, expect, it } from "vitest";
import { decodeFilterRetirement, readFilterRetirementFields } from "./userspace-filter-retirement.ts";

function fields(phase: number) {
  const bytes = new Uint8Array(48), view = new DataView(bytes.buffer);
  if (phase !== 35) {
    view.setBigUint64(0, 1n << 48n, true);
    view.setBigUint64(8, (1n << 48n) + 4096n, true);
    view.setUint16(32, 4096, true);
  }
  if (phase === 30 || phase === 32) view.setBigUint64(16, 2n, true);
  if (phase === 33) {
    view.setBigUint64(16, 57n, true); view.setBigUint64(24, 92n, true);
    bytes[35] = 9; view.setBigUint64(40, 32768n, true);
  }
  return readFilterRetirementFields(view, 0);
}

describe("original filter retirement ownership", () => {
  it.each([30, 31, 32, 33, 34, 35])("decodes exact phase %s", phase => {
    expect(decodeFilterRetirement(phase, fields(phase))).toMatchObject({ kind: "filters" });
  });

  it("retains complete 64-bit allocation and parent lineage identities", () => {
    expect(decodeFilterRetirement(33, fields(33))).toMatchObject({
      phase: "filter-program-page", backingId: 1n << 48n, parentBackingId: (1n << 48n) + 4096n,
      instructions: 4096, opcode: 0, pagesBefore: 9, offset: 32768n,
      allocationId: 57n, allocationCgroupId: 92n,
    });
  });

  it("rejects invented identities, geometry, aliases and mixed payloads", () => {
    const raw = fields(33);
    for (const patch of [{ backingId: 0n }, { backingId: 1n }, { backingId: 0xffff_ffff_ffff_ffffn },
      { parentBackingId: raw.backingId }, { parentBackingId: 2n }, { instructions: 0 }, { instructions: 4097 },
      { opcode: 65 }, { pagesBefore: 0 }, { pagesBefore: 10 }, { offset: 32769n },
      { offset: 0n }, { allocationOrReferences: 0n }, { allocationCgroupId: 0n }, { reserved: 1 }]) {
      expect(decodeFilterRetirement(33, { ...raw, ...patch })).toBeUndefined();
    }
    expect(decodeFilterRetirement(30, { ...fields(30), allocationOrReferences: 1n })).toBeUndefined();
    expect(decodeFilterRetirement(31, { ...fields(31), allocationOrReferences: 1n })).toBeUndefined();
    expect(decodeFilterRetirement(34, { ...fields(34), pagesBefore: 1 })).toBeUndefined();
    expect(decodeFilterRetirement(35, { ...fields(35), backingId: 1n << 48n })).toBeUndefined();
    expect(decodeFilterRetirement(36, fields(35))).toBeUndefined();
  });
});
