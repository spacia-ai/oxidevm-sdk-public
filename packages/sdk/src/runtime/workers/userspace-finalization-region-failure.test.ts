import { describe, expect, it } from "vitest";
import { REGION_PHASES, writeRegionFields, type RegionPhase } from "../userspace-region-retirement.fixtures.ts";
import { decodeUserspaceFinalizationFailure, finalizationFailureDetail } from "./userspace-finalization-failure.ts";

function failure(phase: RegionPhase, user: boolean): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(256), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OXFF")); view.setUint16(4, 5, true); view.setUint16(6, 256, true);
  view.setBigUint64(8, 99n, true); bytes[16] = 2; bytes[17] = 1; bytes[18] = 1; view.setInt32(20, 5, true);
  for (const [field, value] of [[24, 7n], [32, 8n], [40, 91n], [64, 50n], [88, 3n],
    [144, 0x1000n], [152, 0x1002n], [160, 1n]] as const) view.setBigUint64(field, value, true);
  bytes[48] = 1; view.setUint32(52, 2, true); view.setUint32(56, 2, true);
  bytes[184] = 7; bytes[185] = phase; bytes[186] = phase === 22 ? 0 : 1;
  writeRegionFields(bytes, 208, phase, user);
  return bytes;
}

describe("canonical final-region failure5", () => {
  it.each(REGION_PHASES)("retains phase %s user=%s without a trace", (phase, user) => {
    const decoded = decodeUserspaceFinalizationFailure(failure(phase, user));
    expect(decoded).toMatchObject({ stage: "resource", errno: 5, identity: { cpuCgroupId: 91n },
      progress: { kind: "region", originalPages: 257, storage: user ? "user" : "kernel" } });
    expect(() => JSON.stringify(finalizationFailureDetail(decoded))).not.toThrow();
    if (phase === 19 || phase === 20 || phase === 21) expect(finalizationFailureDetail(decoded)).toMatchObject({ progress: { allocationId: "57", allocationCgroupId: "92" } });
  });

  it.each(REGION_PHASES)("rejects downgraded and unclaimed phase %s user=%s", (phase, user) => {
    for (const version of [1, 2, 3, 4, 9]) {
      const bytes = failure(phase, user); new DataView(bytes.buffer).setUint16(4, version, true);
      expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
    for (const field of [187, 188, 190, 192, 199, 200, 207, 221, 222, 223]) {
      const bytes = failure(phase, user); bytes[field] = 1;
      expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
  });
});
