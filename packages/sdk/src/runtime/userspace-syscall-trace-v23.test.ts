import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.js";

function seccompReadiness(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 752), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 23, true); view.setUint32(8, 752, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 426n, true);
  bytes[offset + 120] = 2; bytes[offset + 121] = 14; bytes[offset + 123] = 1;
  bytes.set(new TextEncoder().encode("io_uring_enter"), offset + 152);
  view.setBigUint64(offset + 192, 7n, true); view.setBigUint64(offset + 200, 9n, true);
  view.setBigUint64(offset + 208, 51n, true); view.setUint32(offset + 216, 2, true);
  bytes[offset + 232] = 22; bytes[offset + 234] = 6;
  view.setBigUint64(offset + 240, 19n, true);
  bytes[offset + 512] = 2;
  view.setBigUint64(offset + 520, 71n, true); view.setUint32(offset + 528, 2, true);
  bytes[offset + 624] = 5;
  view.setUint32(offset + 632, 1, true); view.setUint32(offset + 636, 2, true);
  view.setBigUint64(offset + 640, 50n, true); view.setBigUint64(offset + 648, 102n, true);
  view.setBigUint64(offset + 704, 0x2000n, true); view.setBigUint64(offset + 712, 0x2002n, true);
  view.setBigUint64(offset + 720, 1n, true);
  bytes[offset + 728] = 3; view.setUint16(offset + 730, 2, true); view.setBigUint64(offset + 736, 3n, true);
  return bytes;
}

describe("Userspace trace v23 fatal seccomp issuer exit", () => {
  it("retains the denied syscall and exact filter decision through readiness and release", () => {
    const bytes = seccompReadiness();
    expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ version: 23, events: [{
      pid: 1, tid: 2, number: 426n, work: { completion: "task-run-reissue", executor: {
        kind: "exited-seccomp", source: { pid: 1, tid: 2, number: 102n, guestTicks: 50n },
        decision: { kind: "filter", programId: 3n, instruction: 2, value: 0, flags: 0 },
      } },
    }] });
    bytes.fill(0, 24 + 512, 24 + 552);
    bytes[24 + 120] = 4; bytes[24 + 233] = 1; bytes[24 + 234] = 7;
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      outcome: { kind: "released" }, work: { completion: "released", executor: { kind: "exited-seccomp" } },
    });
  });

  it("distinguishes strict thread death and permits a different caller only for process-wide filter death", () => {
    const strict = seccompReadiness(); strict.fill(0, 24 + 728, 24 + 744); strict[24 + 728] = 2;
    expect(decodeUserspaceSyscallTrace(strict).events[0]).toMatchObject({ work: { executor: {
      kind: "exited-seccomp", decision: { kind: "strict", action: "kill" },
    } } });
    for (const value of [0x80000000, 0x00010000]) {
      const process = seccompReadiness(), view = new DataView(process.buffer);
      view.setUint32(24 + 636, 1, true); view.setUint32(24 + 732, value, true);
      expect(decodeUserspaceSyscallTrace(process).events[0]).toMatchObject({ work: { executor: {
        kind: "exited-seccomp", source: { tid: 1 }, decision: { kind: "filter", value },
      } } });
    }
  });

  it("rejects nonfatal decisions, forged boundaries, wrong scope, padding and older envelopes", () => {
    for (const [field, value] of [[625,1],[632,2],[636,1],[640,52],[712,0],[720,2],[728,0],[728,1],[729,128],[731,16],[734,3],[736,0],[744,1],[28,3],[216,3]] as const) {
      const invalid = seccompReadiness(); invalid[24 + field] = value;
      expect(() => decodeUserspaceSyscallTrace(invalid)).toThrow();
    }
    const legacy = seccompReadiness(); new DataView(legacy.buffer).setUint16(4, 22, true);
    expect(() => decodeUserspaceSyscallTrace(legacy)).toThrow();
    for (const value of [0x00030000,0x00050000,0x7fc00000,0x7ff00000,0x7ffc0000,0x7fff0000]) {
      const invalid = seccompReadiness(); new DataView(invalid.buffer).setUint32(24 + 732, value, true);
      expect(() => decodeUserspaceSyscallTrace(invalid)).toThrow();
    }
  });
});
