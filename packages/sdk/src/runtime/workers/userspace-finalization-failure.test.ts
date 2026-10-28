import { describe, expect, it } from "vitest";
import { decodeUserspaceFinalizationFailure } from "./userspace-finalization-failure.ts";
import { throwIfUserspaceKernelFailed } from "./userspace-io-failure.ts";
import { VMError } from "../errors.ts";

function failureRecord(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(256), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OXFF")); view.setUint16(4, 1, true); view.setUint16(6, 256, true);
  view.setBigUint64(8, 99n, true); bytes[16] = 2; bytes[17] = 1; bytes[18] = 1;
  view.setInt32(20, 5, true);
  for (const [field, value] of [[24, 7n], [32, 8n], [40, 91n], [64, 50n], [88, 3n], [144, 0x1000n], [152, 0x1002n], [160, 1n], [192, 31n], [200, 257n]] as const) {
    view.setBigUint64(field, value, true);
  }
  bytes[48] = 1; view.setUint32(52, 2, true); view.setUint32(56, 2, true);
  bytes[184] = 1; bytes[185] = 3; bytes[186] = 1;
  return bytes;
}

function fixedFileFailureRecord(): Uint8Array<ArrayBuffer> {
  const bytes = failureRecord(), view = new DataView(bytes.buffer);
  bytes.fill(0, 184); view.setUint16(4, 2, true);
  bytes[184] = 4; bytes[185] = 10; bytes[186] = 1;
  view.setUint32(188, 65_536, true); view.setBigUint64(192, 57n, true);
  view.setBigUint64(200, 257n, true); view.setBigUint64(208, 8192n, true);
  return bytes;
}

describe("final ring cleanup failures", () => {
  it("retains 32-bit fixed slots in version2 and rejects a forged version1 header", () => {
    const bytes = fixedFileFailureRecord(), view = new DataView(bytes.buffer);
    expect(decodeUserspaceFinalizationFailure(bytes)).toMatchObject({ progress: {
      kind: "files", phase: "file-descriptor", slot: 65_536, openFileId: 57n,
      descriptorsBefore: 257, metadataPagesBefore: 8192,
    } });
    view.setUint16(4, 1, true);
    expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
  });

  it("distinguishes fixed metadata and the empty fixed table from the final ring owner", () => {
    const bytes = fixedFileFailureRecord(), view = new DataView(bytes.buffer);
    bytes.fill(0, 185); bytes[185] = 11; view.setBigUint64(208, 3n, true);
    expect(decodeUserspaceFinalizationFailure(bytes)).toMatchObject({ progress: {
      kind: "files", phase: "file-metadata", metadataPagesBefore: 3,
    } });
    bytes[185] = 12; view.setBigUint64(208, 0n, true);
    expect(decodeUserspaceFinalizationFailure(bytes)).toMatchObject({ progress: { kind: "files", phase: "file-owner" } });
    for (const field of [187, 192, 200, 208, 216, 224, 236, 248, 255]) {
      const invalid = bytes.slice(); invalid[field] = 1;
      expect(() => decodeUserspaceFinalizationFailure(invalid)).toThrow();
    }
  });
  it("preserves accepted signal and worker origins after the original caller is gone", () => {
    const signal = failureRecord(), sv = new DataView(signal.buffer);
    signal.fill(0, 88, 184); signal[48] = 2; signal[49] = 9;
    sv.setBigUint64(88, 0x5000n, true); sv.setBigUint64(160, 3n, true);
    expect(decodeUserspaceFinalizationFailure(signal)).toMatchObject({ identity: {
      source: { kind: "signal", signal: 9, pid: 2, tid: 2, instructionRip: 0x5000n, addressSpace: 3n },
    } });
    const worker = failureRecord(), wv = new DataView(worker.buffer);
    worker[48] = 3; wv.setUint32(56, 3, true); wv.setUint32(60, 2, true);
    wv.setBigUint64(72, 19n, true); wv.setBigUint64(80, 20n, true); wv.setBigUint64(88, 426n, true);
    expect(decodeUserspaceFinalizationFailure(worker)).toMatchObject({ identity: {
      source: { kind: "worker", pid: 2, tid: 3, creatorTid: 2, poolId: 19n, sequence: 20n,
        submission: { number: 426n, instructionRip: 0x1000n } },
    } });
    for (const field of [60, 72, 80]) {
      const invalid = worker.slice(); invalid[field] = 0;
      expect(() => decodeUserspaceFinalizationFailure(invalid)).toThrow();
    }
    wv.setUint32(60, 3, true);
    expect(() => decodeUserspaceFinalizationFailure(worker)).toThrow();
  });

  it("retains queue unaccount and physical release as different attempted actions", () => {
    const bytes = failureRecord(), view = new DataView(bytes.buffer);
    bytes.fill(0, 184); bytes[184] = 2; bytes[185] = 5;
    view.setBigUint64(240, 2n, true);
    expect(decodeUserspaceFinalizationFailure(bytes)).toMatchObject({ progress: {
      kind: "queues", phase: "queue-unaccount", lockedPagesBefore: 2n, ringsPages: 0, sqePages: 0, metadataPages: 0,
    } });
    bytes[185] = 7; view.setBigUint64(240, 0n, true); view.setUint32(228, 1, true);
    expect(decodeUserspaceFinalizationFailure(bytes)).toMatchObject({ progress: { kind: "queues", phase: "queue-sqes", sqePages: 1 } });
    view.setBigUint64(240, 1n, true);
    expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
  });
  it("retains the exact ring, releasing source, CPU account and attempted pin cursor", () => {
    expect(decodeUserspaceFinalizationFailure(failureRecord())).toMatchObject({
      stage: "resource", errno: 5, guestTicks: 99n,
      identity: { ringObjectId: 7n, ringOpenFileId: 8n, cpuCgroupId: 91n,
        source: { kind: "syscall", pid: 2, tid: 2, guestTicks: 50n, number: 3n } },
      progress: { kind: "buffers", phase: "unpin", pinsBefore: 257n, resource: { origin: 31n, index: 0 } },
    });
  });

  it("represents an unreadable registry without inventing a ring or task", () => {
    const bytes = failureRecord(); bytes.fill(0, 17, 20); bytes.fill(0, 24); bytes[16] = 1;
    expect(decodeUserspaceFinalizationFailure(bytes)).toEqual({ stage: "selection", errno: 5, guestTicks: 99n });
    bytes[24] = 1;
    expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
  });

  it("rejects unclaimed bytes, inconsistent identities, unsupported versions and impossible origins", () => {
    for (const field of [0, 4, 6, 16, 17, 18, 19, 24, 40, 48, 52, 56, 160, 184, 185]) {
      const bytes = failureRecord(); bytes[field] = field === 19 || field === 6 ? 1 : 0;
      expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
    for (const field of [50, 51, 60, 72, 80, 187, 190, 236, 255]) {
      const bytes = failureRecord(); bytes[field] = 1;
      expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
    for (const length of [0, 255, 257]) expect(() => decodeUserspaceFinalizationFailure(new Uint8Array(length))).toThrow();
  });

  it.each([failureRecord, fixedFileFailureRecord])("reports the canonical failure with trace capture disabled %#", createRecord => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    new Uint8Array(memory.buffer, 32, 256).set(createRecord());
    const runtime = { memory, instance: { exports: {
      oxidevm_userspace_kernel_failure_read: () => 0,
      oxidevm_userspace_kernel_failure_ptr: () => 32,
      oxidevm_userspace_kernel_failure_len: () => 256,
    } } };
    try { throwIfUserspaceKernelFailed(runtime); throw new Error("Expected a fault"); }
    catch (error: unknown) {
      expect(error).toBeInstanceOf(VMError);
      if (!(error instanceof VMError)) throw error;
      expect(error.code).toBe("VM_FAULT");
      expect(error.detail).toMatchObject({ reason: "io-finalization-failure", stage: "resource", errno: 5,
        ringObjectId: "7", ringOpenFileId: "8", cpuCgroupId: "91" });
      expect(() => JSON.stringify(error.detail)).not.toThrow();
    }
  });
});
