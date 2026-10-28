import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace, USERSPACE_SYSCALL_TRACE_VERSION } from "./userspace-abi.ts";
import { REGION_PHASES, regionTrace } from "./userspace-region-retirement.fixtures.ts";

describe("trace45 final registered-region disposal", () => {
  it.each(REGION_PHASES)("retains phase %s user=%s without completing the ring", (phase, user) => {
    const snapshot = decodeUserspaceSyscallTrace(regionTrace(phase, user));
    expect(snapshot).toMatchObject({ version: 45, events: [{ kind: "io-uring-finalization", finalization: {
      done: false, cpuCgroupId: 91n, progress: { kind: "region", originalPages: 257, storage: user ? "user" : "kernel" },
    } }] });
    const progress = snapshot.events[0];
    if (progress?.kind !== "io-uring-finalization") throw new Error("Expected the region owner");
    if (phase === 18) expect(progress.finalization.progress).toMatchObject({ phase: "region-unaccount", uid: 1000, lockedPagesBefore: 257n });
    if (phase === 19) expect(progress.finalization.progress).toMatchObject({ phase: "region-user-pin", pinsBefore: 128, allocationId: 57n, allocationCgroupId: 92n });
    if (phase === 20) expect(progress.finalization.progress).toMatchObject({ phase: "region-kernel-page", pagesBefore: 128, backingId: 1n << 48n, offset: 127n * 4096n });
    if (phase === 21) expect(progress.finalization.progress).toMatchObject({ phase: "region-metadata", metadataPagesBefore: user ? 3 : 1, allocationId: 57n });
    if (phase === 22) expect(progress.finalization.progress).toMatchObject({ phase: "region-owner" });
  });

  it.each(REGION_PHASES)("rejects downgraded, early-completed and unclaimed phase %s user=%s", (phase, user) => {
    for (const version of [41, 42, 43, 44, USERSPACE_SYSCALL_TRACE_VERSION + 1]) {
      const bytes = regionTrace(phase, user); new DataView(bytes.buffer).setUint16(4, version, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const field of [238, 256, 264, 288, 296, 304, 312, 320, 440, 511, 525, 526, 527, 560, 991]) {
      const bytes = regionTrace(phase, user); bytes[24 + field] = 1;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const done = regionTrace(phase, user); done[24 + 235] = 1; done[24 + 120] = 4;
    expect(() => decodeUserspaceSyscallTrace(done)).toThrow();
  });

  it("rejects wrong page geometry, storage, physical identity and empty owner residue", () => {
    for (const [phase, user, field, value] of [
      [18, true, 512, 0], [18, true, 516, 256], [18, true, 520, 2],
      [19, true, 516, 0], [19, true, 516, 258], [19, true, 520, 2], [19, true, 524, 2],
      [20, false, 520, 0], [20, false, 524, 1], [21, true, 520, 0], [21, false, 520, 2],
      [22, false, 516, 1], [22, false, 520, 1],
    ] as const) {
      const bytes = regionTrace(phase, user); new DataView(bytes.buffer).setUint32(24 + field, value, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const [phase, user, field, value] of [
      [18, false, 528, 0x1_0000_0000n], [18, false, 536, 256n],
      [19, true, 528, 1n], [19, true, 544, 0n], [19, true, 552, 0n],
      [20, false, 528, 4096n], [20, false, 528, (1n << 48n) + 1n], [20, false, 536, 128n * 4096n],
      [21, true, 516, 1n], [21, true, 544, 0n], [22, true, 528, 1n], [22, true, 544, 1n],
    ] as const) {
      const bytes = regionTrace(phase, user); new DataView(bytes.buffer).setBigUint64(24 + field, value, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });

  it("retains a root exemption and the largest admissible real UID", () => {
    for (const [encoded, uid] of [[0n, undefined], [0xffff_ffffn, 0xffff_fffe]] as const) {
      const bytes = regionTrace(18, false); new DataView(bytes.buffer).setBigUint64(24 + 528, encoded, true);
      const event = decodeUserspaceSyscallTrace(bytes).events[0];
      if (event?.kind !== "io-uring-finalization") throw new Error("Expected a region unaccount");
      expect(event.finalization.progress).toEqual({ kind: "region", phase: "region-unaccount", storage: "kernel",
        originalPages: 257, metadataPagesBefore: 1, lockedPagesBefore: 257n, ...(uid === undefined ? {} : { uid }) });
    }
  });

  it("rejects original pin metadata beyond the Rust owner's allocation geometry", () => {
    const bytes = regionTrace(19, true), view = new DataView(bytes.buffer);
    const originalPages = (512 * 1024 * 1024 - 128) / 32 + 1;
    view.setUint32(24 + 512, originalPages, true);
    view.setUint32(24 + 520, Math.ceil((128 + originalPages * 32) / 4096), true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });
});
