import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace, USERSPACE_SYSCALL_TRACE_VERSION } from "./userspace-abi.ts";
import { FILTER_PHASES, filterTrace } from "./userspace-filter-retirement.fixtures.ts";
import { personalityTrace } from "./userspace-personality-retirement.fixtures.ts";

describe("trace47 original filter cleanup", () => {
  it.each(FILTER_PHASES)("retains exact phase %s and original source", phase => {
    const decoded = decodeUserspaceSyscallTrace(filterTrace(phase));
    expect(decoded).toMatchObject({ version: 47, events: [{ kind: "io-uring-finalization", finalization: {
      done: false, cpuCgroupId: 91n, source: { kind: "syscall" }, progress: { kind: "filters", phase: {
        30: "filter-reference", 31: "filter-node", 32: "filter-program-reference",
        33: "filter-program-page", 34: "filter-program-owner", 35: "filter-owner",
      }[phase] },
    } }] });
  });

  it.each(FILTER_PHASES)("rejects downgraded, premature and mixed phase %s", phase => {
    for (const version of [41, 42, 43, 44, 45, 46, USERSPACE_SYSCALL_TRACE_VERSION + 1]) {
      const bytes = filterTrace(phase); new DataView(bytes.buffer).setUint16(4, version, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const field of [238, 256, 264, 288, 296, 304, 312, 320, 440, 511, 548, 551, 560, 991]) {
      const bytes = filterTrace(phase); bytes[24 + field] = 1;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const done = filterTrace(phase); done[24 + 235] = 1; done[24 + 120] = 4;
    expect(() => decodeUserspaceSyscallTrace(done)).toThrow();
  });

  it("keeps earlier personality payloads readable in the new schema", () => {
    const bytes = personalityTrace(25); new DataView(bytes.buffer).setUint16(4, 47, true);
    expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ finalization: { progress: {
      kind: "personalities", phase: "personality-snapshot-metadata", credentialId: 7n,
    } } }] });
  });
});
