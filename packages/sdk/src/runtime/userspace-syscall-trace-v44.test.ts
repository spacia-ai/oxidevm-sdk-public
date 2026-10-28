import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function napiTrace(phase: 15 | 16 | 17): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 992), view = new DataView(bytes.buffer), at = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 44, true); view.setUint32(8, 992, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(at + field, 1n, true);
  view.setUint32(at + 24, 2, true); view.setUint32(at + 28, 2, true);
  view.setBigUint64(at + 40, 0x1000n, true); view.setBigUint64(at + 48, 0x1002n, true);
  view.setBigUint64(at + 56, 3n, true); bytes[at + 120] = 2; bytes[at + 123] = 4;
  for (const [field, value] of [[192, 7n], [200, 8n], [208, 99n], [216, 50n], [224, 91n]] as const) {
    view.setBigUint64(at + field, value, true);
  }
  bytes[at + 232] = 6; bytes[at + 233] = phase; bytes[at + 234] = phase === 17 ? 0 : 1;
  bytes[at + 236] = 1;
  view.setUint32(at + 512, 257, true);
  if (phase !== 17) view.setUint32(at + 520, 5, true);
  if (phase === 15) {
    view.setUint32(at + 516, 257, true); view.setUint32(at + 524, 0xffff_ffff, true);
    view.setBigUint64(at + 528, 6000n, true);
  } else if (phase === 16) {
    view.setBigUint64(at + 536, 57n, true); view.setBigUint64(at + 544, 92n, true);
  }
  return bytes;
}

describe("trace44 NAPI finalization", () => {
  it("retains the full static ID, expiry and original metadata geometry", () => {
    expect(decodeUserspaceSyscallTrace(napiTrace(15))).toMatchObject({ version: 44, events: [{
      kind: "io-uring-finalization", finalization: { done: false, progress: {
        kind: "napi", phase: "napi-id", originalEntries: 257, idsBefore: 257,
        metadataPagesBefore: 5, napiId: 0xffff_ffff, expiryJiffies: 6000n,
      } },
    }] });
    const partial = napiTrace(15), view = new DataView(partial.buffer);
    view.setUint32(24 + 516, 1, true);
    expect(decodeUserspaceSyscallTrace(partial)).toMatchObject({ events: [{ finalization: { progress: {
      originalEntries: 257, idsBefore: 1, metadataPagesBefore: 5,
    } } }] });
  });

  it("retains each actual allocation separately from the closing CPU account", () => {
    expect(decodeUserspaceSyscallTrace(napiTrace(16))).toMatchObject({ events: [{ finalization: {
      cpuCgroupId: 91n, done: false, progress: { kind: "napi", phase: "napi-metadata",
        originalEntries: 257, metadataPagesBefore: 5, metadataAllocationId: 57n, allocationCgroupId: 92n,
      },
    } }] });
    const last = napiTrace(16), view = new DataView(last.buffer);
    view.setUint32(24 + 520, 1, true);
    view.setBigUint64(24 + 536, 0xffff_ffff_ffff_ffffn, true);
    expect(decodeUserspaceSyscallTrace(last)).toMatchObject({ events: [{ finalization: { progress: {
      metadataPagesBefore: 1, metadataAllocationId: 0xffff_ffff_ffff_ffffn,
    } } }] });
  });

  it("distinguishes an empty NAPI owner from the final ring owner without inventing allocation IDs", () => {
    expect(decodeUserspaceSyscallTrace(napiTrace(17))).toMatchObject({ events: [{ finalization: {
      done: false, progress: { kind: "napi", phase: "napi-owner", originalEntries: 257 },
    } }] });
    const empty = napiTrace(17); new DataView(empty.buffer).setUint32(24 + 512, 0, true);
    expect(decodeUserspaceSyscallTrace(empty)).toMatchObject({ events: [{ finalization: {
      progress: { kind: "napi", phase: "napi-owner", originalEntries: 0 },
    } }] });
  });

  it.each([15, 16, 17] as const)("rejects falsely downgraded NAPI phase %i", phase => {
    for (const version of [41, 42, 43]) {
      const bytes = napiTrace(phase); new DataView(bytes.buffer).setUint16(4, version, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });

  it.each([15, 16, 17] as const)("rejects unclaimed fields and a prematurely completed phase %i", phase => {
    for (const field of [238, 256, 264, 288, 296, 304, 312, 316, 320, 440, 511, 552, 559, 560, 959, 960, 991]) {
      const bytes = napiTrace(phase); bytes[24 + field] = 1;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const early = napiTrace(phase); early[24 + 235] = 1; early[24 + 120] = 4;
    expect(() => decodeUserspaceSyscallTrace(early)).toThrow();
  });

  it("rejects impossible ID counts, reserved IDs, expiry and metadata ownership", () => {
    for (const [field, values] of [[512, [0, 256, 0xffff_ffff]], [516, [0, 258]],
      [520, [0, 4, 6]], [524, [0, 1]]] as const) {
      for (const value of values) {
        const bytes = napiTrace(15); new DataView(bytes.buffer).setUint32(24 + field, value, true);
        expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
      }
    }
    for (const value of [0n, 5999n, 0xffff_ffff_ffff_ffffn]) {
      const bytes = napiTrace(15); new DataView(bytes.buffer).setBigUint64(24 + 528, value, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const field of [536, 544]) {
      const bytes = napiTrace(15); new DataView(bytes.buffer).setBigUint64(24 + field, 1n, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
      const metadata = napiTrace(16); new DataView(metadata.buffer).setBigUint64(24 + field, 0n, true);
      expect(() => decodeUserspaceSyscallTrace(metadata)).toThrow();
    }
    for (const field of [516, 520, 524, 528, 536, 544]) {
      const owner = napiTrace(17); owner[24 + field] = 1;
      expect(() => decodeUserspaceSyscallTrace(owner)).toThrow();
    }
    const resource = napiTrace(15); resource[24 + 234] = 0;
    expect(() => decodeUserspaceSyscallTrace(resource)).toThrow();
  });
});
