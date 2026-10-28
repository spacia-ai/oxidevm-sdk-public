import { describe, expect, it } from "vitest";
import { FILTER_PHASES, writeFilterFields, type FilterPhase } from "../userspace-filter-retirement.fixtures.ts";
import { decodeUserspaceFinalizationFailure, finalizationFailureDetail } from "./userspace-finalization-failure.ts";

function failure(phase: FilterPhase): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(256), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OXFF")); view.setUint16(4, 7, true); view.setUint16(6, 256, true);
  view.setBigUint64(8, 99n, true); bytes[16] = 2; bytes[17] = 1; bytes[18] = 1; view.setInt32(20, 5, true);
  for (const [field, value] of [[24, 7n], [32, 8n], [40, 91n], [64, 50n], [88, 3n],
    [144, 0x1000n], [152, 0x1002n], [160, 1n]] as const) view.setBigUint64(field, value, true);
  bytes[48] = 1; view.setUint32(52, 2, true); view.setUint32(56, 2, true);
  bytes[184] = 9; bytes[185] = phase; bytes[186] = phase === 34 || phase === 35 ? 0 : 1;
  writeFilterFields(bytes, 208, phase);
  return bytes;
}

describe("canonical filter failure7", () => {
  it.each(FILTER_PHASES)("retains phase %s with tracing disabled and JSON-safe identities", phase => {
    const decoded = decodeUserspaceFinalizationFailure(failure(phase));
    expect(decoded).toMatchObject({ stage: "resource", errno: 5, identity: { cpuCgroupId: 91n }, progress: { kind: "filters" } });
    expect(() => JSON.stringify(finalizationFailureDetail(decoded))).not.toThrow();
    if (phase !== 35) expect(finalizationFailureDetail(decoded)).toMatchObject({ progress: { backingId: "281474976710656" } });
    if (phase === 33) expect(finalizationFailureDetail(decoded)).toMatchObject({ progress: { offset: "32768", allocationId: "57", allocationCgroupId: "92" } });
    if (phase === 30 || phase === 32) expect(finalizationFailureDetail(decoded)).toMatchObject({ progress: { references: "257" } });
  });

  it.each(FILTER_PHASES)("rejects downgraded and unclaimed phase %s", phase => {
    for (const version of [1, 2, 3, 4, 5, 6, 9]) {
      const bytes = failure(phase); new DataView(bytes.buffer).setUint16(4, version, true);
      expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
    for (const field of [187, 188, 190, 192, 199, 200, 207, 244, 247]) {
      const bytes = failure(phase); bytes[field] = 1;
      expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
  });
});
