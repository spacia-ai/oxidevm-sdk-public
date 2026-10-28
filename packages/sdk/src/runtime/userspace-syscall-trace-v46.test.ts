import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace, USERSPACE_SYSCALL_TRACE_VERSION } from "./userspace-abi.ts";
import { PERSONALITY_PHASES, personalityTrace } from "./userspace-personality-retirement.fixtures.ts";

describe("trace46 original personality cleanup", () => {
  it.each(PERSONALITY_PHASES)("retains the precise owner in phase %s", phase => {
    const decoded = decodeUserspaceSyscallTrace(personalityTrace(phase));
    expect(decoded).toMatchObject({ version: 46, events: [{ kind: "io-uring-finalization", finalization: {
      done: false, cpuCgroupId: 91n, progress: { kind: "personalities" },
    } }] });
    const event = decoded.events[0];
    if (event?.kind !== "io-uring-finalization") throw new Error("Expected personality finalization");
    const expected = {
      23: { phase: "personality-id", id: 3, credentialId: 7n, idsBefore: 257, referencesBefore: 257 },
      24: { phase: "personality-snapshot", credentialId: 7n, groups: 65536, snapshotsBefore: 1, metadataPages: 65 },
      25: { phase: "personality-snapshot-metadata", credentialId: 7n, groups: 65536, pagesBefore: 64, allocationId: 57n, allocationCgroupId: 92n },
      26: { phase: "personality-snapshot-owner", credentialId: 7n, groups: 65536 },
      27: { phase: "personality-free-range", start: 5, end: 7, rangesBefore: 2 },
      28: { phase: "personality-metadata", originalPages: 5, pagesBefore: 5, allocationId: 57n, allocationCgroupId: 92n },
      29: { phase: "personality-owner" },
    } as const;
    expect(event.finalization.progress).toEqual({ kind: "personalities", ...expected[phase] });
  });

  it.each(PERSONALITY_PHASES)("rejects downgraded, early-completed or unclaimed phase %s", phase => {
    for (const version of [41, 42, 43, 44, 45, USERSPACE_SYSCALL_TRACE_VERSION + 1]) {
      const bytes = personalityTrace(phase); new DataView(bytes.buffer).setUint16(4, version, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const field of [238, 256, 264, 288, 296, 304, 312, 320, 440, 511, 552, 559, 991]) {
      const bytes = personalityTrace(phase); bytes[24 + field] = 1;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const done = personalityTrace(phase); done[24 + 235] = 1; done[24 + 120] = 4;
    expect(() => decodeUserspaceSyscallTrace(done)).toThrow();
  });

  it("rejects inconsistent credential references, group geometry, ranges and leases", () => {
    for (const [phase, field, value] of [
      [23, 520, 0], [23, 520, 65536], [23, 524, 258], [23, 528, 0], [23, 530, 1], [23, 532, 1],
      [24, 520, 0], [24, 524, 65537], [24, 532, 64], [24, 528, 1],
      [25, 520, 0], [25, 520, 66], [25, 524, 0], [25, 532, 1],
      [26, 520, 1], [26, 524, 65537], [26, 532, 1],
      [27, 520, 0], [27, 520, 32769], [27, 524, 1], [27, 528, 8 + 7 * 65536],
      [28, 520, 0], [28, 520, 6], [28, 524, 1025], [28, 532, 1],
      [29, 520, 1], [29, 524, 1], [29, 528, 1], [29, 532, 1],
    ] as const) {
      const bytes = personalityTrace(phase); new DataView(bytes.buffer).setUint32(24 + field, value, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const [phase, field, value] of [
      [23, 512, 0n], [23, 512, 0xffff_ffff_ffff_ffffn], [24, 536, 1n],
      [25, 536, 0n], [25, 544, 0n], [26, 536, 1n],
      [27, 512, 1n], [28, 512, 1n], [28, 536, 0n], [28, 544, 0n],
      [29, 512, 1n], [29, 536, 1n],
    ] as const) {
      const bytes = personalityTrace(phase); new DataView(bytes.buffer).setBigUint64(24 + field, value, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});
