import { describe, expect, it } from "vitest";
import { decodeRingFinalizationProgress } from "./userspace-ring-finalization-progress.ts";

const base = {
  kind: 5, phase: 13, resource: 1, origin: 0n, index: 0,
  pinsBefore: 0n, metadataReferencesBefore: 0n, tag: 0n,
  ringsPages: 0, sqePages: 0, metadataPages: 0, lockedPagesBefore: 0n,
} satisfies Parameters<typeof decodeRingFinalizationProgress>[0];
const provided = {
  groupId: 9, firstId: 7, address: 0x1234n, length: 4, count: 257,
  runsBefore: 1, buffersBefore: 257, groupsBefore: 2,
  metadataAllocationId: 57n, allocationCgroupId: 91n,
};
const run = { ...base, provided };
const group = { ...base, phase: 14, provided: {
  ...provided, groupId: 0, firstId: 0, address: 0n, length: 0, count: 0,
  runsBefore: 0, buffersBefore: 0,
} };

describe("provided-buffer final ring progress", () => {
  it("retains a compact run and its actual memory allocation identity", () => {
    expect(decodeRingFinalizationProgress(run)).toEqual({
      kind: "provided-buffers", phase: "provided-run", ...provided,
    });
  });

  it("distinguishes group zero from an absent resource and retains the maximum charge ID", () => {
    expect(decodeRingFinalizationProgress({ ...group, provided: {
      ...group.provided, metadataAllocationId: 0xffff_ffff_ffff_ffffn,
    } })).toEqual({ kind: "provided-buffers", phase: "provided-group", groupId: 0,
      metadataAllocationId: 0xffff_ffff_ffff_ffffn, allocationCgroupId: 91n, groupsBefore: 2,
    });
  });

  it("accepts the reserved-page boundary without following an unmapped range", () => {
    const address = (1n << 47n) - 4096n - 4n * 257n;
    expect(decodeRingFinalizationProgress({ ...run, provided: { ...provided, address } })).toMatchObject({ address });
    expect(() => decodeRingFinalizationProgress({ ...run, provided: { ...provided, address: address + 1n } })).toThrow();
  });

  it.each([
    { ...run, resource: 0 }, { ...run, origin: 1n }, { ...run, index: 1 },
    { ...run, pinsBefore: 1n }, { ...run, metadataReferencesBefore: 1n },
    { ...run, tag: 1n }, { ...run, lockedPagesBefore: 1n },
    { ...run, ringsPages: 1 }, { ...run, sqePages: 1 }, { ...run, metadataPages: 1 },
    { ...run, phase: 0 }, { ...run, kind: 3, phase: 0, resource: 0 },
    ...[
      { groupId: -1 }, { groupId: 65536 }, { firstId: 65536 }, { firstId: 65535 },
      { address: -1n }, { address: 0x8000_0000_0000n }, { length: 0 }, { length: 0x1_0000_0000 },
      { count: 0 }, { count: 65536 }, { runsBefore: 0 }, { runsBefore: 258 },
      { buffersBefore: 256 }, { buffersBefore: 65536 }, { groupsBefore: 0 }, { groupsBefore: 65537 },
      { metadataAllocationId: 0n }, { metadataAllocationId: 1n << 64n },
      { allocationCgroupId: 0n }, { allocationCgroupId: 1n << 64n },
    ].map(change => ({ ...run, provided: { ...provided, ...change } })),
    { ...group, provided: { ...group.provided, count: 1 } },
    { ...group, provided: { ...group.provided, firstId: 1 } },
    { ...group, provided: { ...group.provided, address: 1n } },
    { ...group, provided: { ...group.provided, length: 1 } },
    { ...group, provided: { ...group.provided, runsBefore: 1 } },
    { ...group, provided: { ...group.provided, buffersBefore: 1 } },
  ])("rejects mixed owners and malformed allocation geometry %#", raw => {
    expect(() => decodeRingFinalizationProgress(raw)).toThrow("ring finalization progress is malformed");
  });
});
