import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function finalization(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 960), view = new DataView(bytes.buffer), at = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 41, true); view.setUint32(8, 960, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(at + field, 1n, true);
  view.setUint32(at + 24, 2, true); view.setUint32(at + 28, 2, true);
  view.setBigUint64(at + 40, 0x1000n, true); view.setBigUint64(at + 48, 0x1002n, true);
  view.setBigUint64(at + 56, 3n, true); bytes[at + 120] = 2; bytes[at + 123] = 4;
  for (const [field, value] of [[192, 7n], [200, 8n], [208, 99n], [216, 50n], [224, 91n], [256, 31n], [288, 257n]] as const) {
    view.setBigUint64(at + field, value, true);
  }
  bytes[at + 232] = 1; bytes[at + 233] = 3; bytes[at + 234] = 1; bytes[at + 236] = 1;
  view.setUint16(at + 264, 1, true);
  return bytes;
}

describe("trace41 final ring resource ownership", () => {
  it("distinguishes a real seccomp exit on an unknown syscall from a worker or signal origin", () => {
    const bytes = finalization(), view = new DataView(bytes.buffer);
    view.setBigUint64(24 + 56, 0xffff_ffff_ffff_ffffn, true);
    bytes[24 + 272] = 3; view.setUint32(24 + 276, 0x80000000, true);
    view.setBigUint64(24 + 280, 11n, true);
    expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{
      finalization: { source: { kind: "syscall" } }, seccomp: { kind: "filter", value: 0x80000000 },
    }] });
  });
  it("preserves a real worker trigger and its copied submission without inventing another syscall", () => {
    const bytes = finalization(), view = new DataView(bytes.buffer), at = 24;
    view.setUint32(at + 28, 3, true);
    view.setBigUint64(at + 40, 0n, true); view.setBigUint64(at + 48, 0n, true);
    view.setBigUint64(at + 56, 0xffff_ffff_ffff_ffffn, true); bytes[at + 236] = 3;
    view.setUint32(at + 324, 2, true);
    for (const [field, value] of [[328, 19n], [336, 20n], [344, 426n], [400, 0x5000n], [408, 0x5002n], [416, 1n]] as const) {
      view.setBigUint64(at + field, value, true);
    }
    expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ tid: 3, number: 0xffff_ffff_ffff_ffffn,
      finalization: { source: { kind: "worker", guestTicks: 50n, creatorTid: 2,
        work: { poolId: 19n, sequence: 20n }, submission: { number: 426n, instructionRip: 0x5000n } } },
    }] });
    for (const field of [328, 336, 416]) {
      const invalid = bytes.slice(); new DataView(invalid.buffer).setBigUint64(at + field, 0n, true);
      expect(() => decodeUserspaceSyscallTrace(invalid)).toThrow();
    }
    view.setUint32(at + 324, 3, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });

  it("attributes an unpin to its actual close without inventing an SQE, pool or task", () => {
    expect(decodeUserspaceSyscallTrace(finalization())).toMatchObject({ version: 41, events: [{
      kind: "io-uring-finalization", pid: 2, tid: 2, number: 3n,
      finalization: { ringObjectId: 7n, ringOpenFileId: 8n, guestTicks: 99n, cpuCgroupId: 91n,
        source: { kind: "syscall", admittedGuestTicks: 50n }, done: false,
        progress: { kind: "buffers", phase: "unpin", resource: { origin: 31n, index: 1 }, pinsBefore: 257n } },
    }] });
  });

  it("keeps caller and kernel queue page counts distinct from final owner release", () => {
    for (const [code, phase, counts, locked] of [
      [5, "queue-unaccount", [5, 8, 1], 13n],
      [5, "queue-unaccount", [0, 0, 0], 1n],
      [6, "queue-rings", [1, 0, 1], 0n],
      [7, "queue-sqes", [5, 8, 1], 0n],
      [8, "queue-metadata", [0, 0, 1], 0n],
      [9, "queue-owner", [0, 0, 0], 0n],
    ] as const) {
      const bytes = finalization(), view = new DataView(bytes.buffer), at = 24;
      bytes.fill(0, at + 233, at + 236); bytes.fill(0, at + 256, at + 272); bytes.fill(0, at + 288, at + 324);
      bytes[at + 232] = 2; bytes[at + 233] = code;
      view.setBigUint64(at + 304, locked, true);
      counts.forEach((count, index) => view.setUint32(at + 312 + index * 4, count, true));
      expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ finalization: {
        progress: { kind: "queues", phase, ringsPages: counts[0], sqePages: counts[1], metadataPages: counts[2],
          ...(code === 5 ? { lockedPagesBefore: locked } : {}) },
      } }] });
      const invalid = bytes.slice(); invalid[at + 233] = 0;
      expect(() => decodeUserspaceSyscallTrace(invalid)).toThrow();
    }
    const bytes = finalization(), at = 24;
    bytes.fill(0, at + 233, at + 236); bytes.fill(0, at + 256, at + 272); bytes.fill(0, at + 288, at + 324);
    bytes[at + 232] = 3; bytes[at + 235] = 1; bytes[at + 120] = 4;
    expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ outcome: { kind: "released" },
      finalization: { done: true, progress: { kind: "owner" } },
    }] });
  });

  it("retains the accepted signal boundary after its process has been reaped", () => {
    const bytes = finalization(), view = new DataView(bytes.buffer), at = 24;
    view.setBigUint64(at + 40, 0n, true); view.setBigUint64(at + 48, 0n, true);
    view.setBigUint64(at + 56, 0xffff_ffff_ffff_ffffn, true);
    bytes[at + 236] = 2; bytes[at + 237] = 9; view.setBigUint64(at + 240, 0x2000n, true);
    expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ number: 0xffff_ffff_ffff_ffffn,
      finalization: { source: { kind: "signal", signal: 9, instructionRip: 0x2000n, admittedGuestTicks: 50n } },
    }] });
    bytes[at + 237] = 65;
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });

  it("rejects zero identities, backwards clocks, impossible resources and historical reinterpretation", () => {
    for (const [field, value] of [[192, 0n], [200, 0n], [224, 0n], [224, 0xffff_ffff_ffff_ffffn], [216, 100n], [288, 0n], [256, 0n]] as const) {
      const bytes = finalization(); new DataView(bytes.buffer).setBigUint64(24 + field, value, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const [field, value] of [[233, 0], [234, 2], [235, 1], [236, 0], [237, 9], [238, 1], [266, 1], [512, 1], [959, 1]] as const) {
      const bytes = finalization(); bytes[24 + field] = value;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const version of [38, 39, 40]) {
      const bytes = finalization(); new DataView(bytes.buffer).setUint16(4, version, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});
