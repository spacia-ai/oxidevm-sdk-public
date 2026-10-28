import { describe, expect, it } from "vitest";
import { PERSONALITY_PHASES, writePersonalityFields, type PersonalityPhase } from "../userspace-personality-retirement.fixtures.ts";
import { decodeUserspaceFinalizationFailure, finalizationFailureDetail } from "./userspace-finalization-failure.ts";

function failure(phase: PersonalityPhase): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(256), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OXFF")); view.setUint16(4, 6, true); view.setUint16(6, 256, true);
  view.setBigUint64(8, 99n, true); bytes[16] = 2; bytes[17] = 1; bytes[18] = 1; view.setInt32(20, 5, true);
  for (const [field, value] of [[24, 7n], [32, 8n], [40, 91n], [64, 50n], [88, 3n],
    [144, 0x1000n], [152, 0x1002n], [160, 1n]] as const) view.setBigUint64(field, value, true);
  bytes[48] = 1; view.setUint32(52, 2, true); view.setUint32(56, 2, true);
  bytes[184] = 8; bytes[185] = phase; bytes[186] = phase === 26 || phase === 29 ? 0 : 1;
  writePersonalityFields(bytes, 208, phase);
  return bytes;
}

describe("canonical personality failure6", () => {
  it.each(PERSONALITY_PHASES)("retains phase %s with tracing disabled", phase => {
    const decoded = decodeUserspaceFinalizationFailure(failure(phase));
    expect(decoded).toMatchObject({ stage: "resource", errno: 5, identity: { cpuCgroupId: 91n }, progress: { kind: "personalities" } });
    expect(() => JSON.stringify(finalizationFailureDetail(decoded))).not.toThrow();
    if (phase <= 26) expect(finalizationFailureDetail(decoded)).toMatchObject({ progress: { credentialId: "7" } });
    if (phase === 25 || phase === 28) expect(finalizationFailureDetail(decoded)).toMatchObject({ progress: { allocationId: "57", allocationCgroupId: "92" } });
  });

  it.each(PERSONALITY_PHASES)("rejects downgraded and unclaimed phase %s", phase => {
    for (const version of [1, 2, 3, 4, 5, 9]) {
      const bytes = failure(phase); new DataView(bytes.buffer).setUint16(4, version, true);
      expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
    for (const field of [187, 188, 190, 192, 199, 200, 207, 248, 255]) {
      const bytes = failure(phase); bytes[field] = 1;
      expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
  });
});
