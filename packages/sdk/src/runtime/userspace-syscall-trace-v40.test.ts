import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function release(cause: 3 | 4 | 5 = 3): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 960), view = new DataView(bytes.buffer), at = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 40, true); view.setUint32(8, 960, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(at + field, 1n, true);
  view.setUint32(at + 24, 2, true); view.setUint32(at + 28, 2, true);
  view.setBigUint64(at + 40, 0x1000n, true); view.setBigUint64(at + 48, 0x1002n, true);
  view.setBigUint64(at + 56, 426n, true); bytes[at + 123] = 1;
  view.setBigUint64(at + 192, 7n, true); view.setBigUint64(at + 200, 9n, true);
  view.setBigUint64(at + 208, 51n, true); view.setUint32(at + 216, 2, true);
  bytes[at + 232] = 4; bytes[at + 234] = 8; view.setBigUint64(at + 240, 19n, true);
  bytes[at + 624] = cause;
  view.setUint32(at + 632, 2, true); view.setUint32(at + 636, 2, true);
  view.setBigUint64(at + 640, 50n, true); view.setBigUint64(at + 704, 0x2000n, true);
  view.setBigUint64(at + 720, 1n, true);
  if (cause === 4) bytes[at + 625] = 9;
  else {
    view.setBigUint64(at + 648, cause === 3 ? 231n : 102n, true);
    view.setBigUint64(at + 712, 0x2002n, true);
    if (cause === 5) {
      bytes[at + 728] = 3; view.setUint16(at + 730, 2, true);
      view.setUint32(at + 732, 0x80000000, true); view.setBigUint64(at + 736, 88n, true);
    }
  }
  bytes[at + 784] = 1; bytes[at + 785] = 3; bytes[at + 786] = 3; bytes[at + 787] = 1;
  view.setBigUint64(at + 792, 11n, true); view.setBigUint64(at + 800, 31n, true);
  view.setBigUint64(at + 808, 257n, true); view.setBigUint64(at + 816, 3n, true);
  view.setBigUint64(at + 952, 91n, true);
  return bytes;
}

function copiedRelease(phase: number, entries: number, submission: number, completion: number): Uint8Array<ArrayBuffer> {
  const bytes = release(), view = new DataView(bytes.buffer), at = 24;
  bytes.fill(0, at + 785, at + 832);
  bytes[at + 785] = 8; bytes[at + 786] = 3;
  view.setBigUint64(at + 792, 11n, true);
  bytes[at + 937] = phase;
  view.setUint32(at + 940, entries, true); view.setUint32(at + 944, submission, true);
  view.setUint32(at + 948, completion, true);
  return bytes;
}

describe("trace40 last-capability retirement", () => {
  it("distinguishes real last-close cancellation CQEs from final resource retirement", () => {
    const bytes = release(), view = new DataView(bytes.buffer), at = 24;
    bytes.fill(0, at + 784, at + 832);
    bytes[at + 234] = 2; bytes[at + 938] = 1;
    view.setBigInt64(at + 112, -125n, true);
    expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ work: {
      ringClosing: true, cpuCgroupId: 91n, completion: "published", opcode: 4,
    } }] });
    bytes[at + 938] = 0;
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    const final = copiedRelease(9, 0, 0, 0), finalView = new DataView(final.buffer);
    final[at + 232] = 0; final[at + 786] = 2; final[at + 938] = 1;
    finalView.setBigInt64(at + 112, -125n, true);
    expect(decodeUserspaceSyscallTrace(final)).toMatchObject({ events: [{ work: {
      ringClosing: true, completion: "retiring", opcode: 0, retirement: {
        completion: "published", phase: "finished", release: { phase: "queue-owner" },
      },
    } }] });
    finalView.setUint16(4, 39, true);
    expect(() => decodeUserspaceSyscallTrace(final)).toThrow();
  });

  it("attributes a completed scalar/vector capability transfer without claiming a fixed-buffer unpin", () => {
    for (const opcode of [1, 2, 22, 23]) {
      const bytes = copiedRelease(0, 0, 0, 0), view = new DataView(bytes.buffer), at = 24;
      bytes[at + 232] = opcode; bytes[at + 785] = 1; bytes[at + 786] = 2; bytes[at + 938] = 1;
      view.setBigInt64(at + 112, -125n, true);
      expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ work: {
        ringClosing: true, retirement: { completion: "published", phase: "select", pinsBefore: 0n },
      } }] });
      bytes[at + 938] = 0;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });

  it("retains the exited CPU account during publication, notification and completed retirement", () => {
    for (const cause of [3, 4, 5] as const) {
      for (const [phase, completion, name] of [[3, 2, "published"], [4, 9, "notified"], [5, 12, "retired"]] as const) {
        const bytes = release(cause), view = new DataView(bytes.buffer), at = 24;
        bytes.fill(0, at + 784, at + 832);
        bytes[at + 232] = 0;
        bytes[at + 233] = completion === 12 ? 1 : 0;
        bytes[at + 234] = completion;
        view.setBigUint64(at + 928, 3n, true); bytes[at + 936] = phase;
        expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ work: {
          cpuCgroupId: 91n, completion: name, executor: { issuer: { generation: 3n } },
        } }] });
        view.setBigUint64(at + 952, 0n, true);
        expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
        view.setUint16(4, 39, true);
        expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ version: 39, events: [{ work: { completion: name } }] });
      }
    }
  });

  it("keeps copied-input, reservation and final-owner work separate from fixed-buffer unpins", () => {
    for (const [tag, entries, submission, completion, phase] of [
      [1, 511, 44, 1, "copied-inputs"], [2, 0, 1, 0, "submission-metadata"],
      [3, 0, 1, 1, "completion-metadata"], [4, 0, 0, 0, "owner"],
    ] as const) {
      const bytes = copiedRelease(tag, entries, submission, completion);
      expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ version: 40, events: [{ work: {
        retirement: { completion: "released", phase: "finished", release: {
          phase, copiedEntries: entries, submissionPages: submission, completionPages: completion,
        } },
      } }] });
      new DataView(bytes.buffer).setUint16(4, 39, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });

  it("identifies bounded queue unaccounting, page retirement and the final empty queue owner", () => {
    for (const [tag, metadataPages, ringsPages, sqePages, phase] of [
      [5, 1, 5, 8, "queue-unaccount"], [6, 1, 5, 0, "queue-rings"],
      [7, 1, 5, 8, "queue-sqes"], [8, 1, 0, 0, "queue-metadata"], [9, 0, 0, 0, "queue-owner"],
    ] as const) {
      expect(decodeUserspaceSyscallTrace(copiedRelease(tag, metadataPages, ringsPages, sqePages)))
        .toMatchObject({ events: [{ work: { retirement: { release: { phase, metadataPages, ringsPages, sqePages } } } }] });
    }
    for (const bytes of [copiedRelease(5, 0, 0, 0), copiedRelease(6, 0, 0, 1),
      copiedRelease(7, 0, 1, 0), copiedRelease(8, 1, 1, 0), copiedRelease(9, 1, 0, 0),
      copiedRelease(10, 0, 0, 0), copiedRelease(7, 0, 1025, 1)]) {
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });

  it("admits ordinary scalar/vector release without claiming a fixed-buffer unpin", () => {
    for (const opcode of [1, 2, 22, 23]) {
      const bytes = copiedRelease(1, 511, 44, 1); bytes[24 + 232] = opcode;
      expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ work: {
        retirement: { completion: "released", phase: "finished", release: { phase: "copied-inputs" } },
      } }] });
      const invalid = release(); invalid[24 + 232] = opcode;
      expect(() => decodeUserspaceSyscallTrace(invalid)).toThrow();
    }
  });

  it("rejects unclaimed release bytes, impossible phase counts and overlap with issuer generations", () => {
    for (const bytes of [copiedRelease(0, 1, 1, 1), copiedRelease(1, 0, 1, 1),
      copiedRelease(1, 32769, 1, 1), copiedRelease(2, 1, 1, 0), copiedRelease(2, 0, 1, 1),
      copiedRelease(3, 0, 1, 0), copiedRelease(4, 0, 1, 0), copiedRelease(10, 0, 0, 0)]) {
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const field of [928, 936, 938]) {
      const bytes = copiedRelease(1, 511, 44, 1); bytes[24 + field] = 1;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const active = copiedRelease(1, 511, 44, 1); active[24 + 785] = 3;
    expect(() => decodeUserspaceSyscallTrace(active)).toThrow();
    for (const invalidGroup of [0n, 0xffff_ffff_ffff_ffffn]) {
      const bytes = copiedRelease(1, 511, 44, 1);
      new DataView(bytes.buffer).setBigUint64(24 + 952, invalidGroup, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });

  it("keeps original normal, signal and seccomp exit origins without inventing an I/O result", () => {
    for (const [cause, kind] of [[3, "exited"], [4, "exited-signal"], [5, "exited-seccomp"]] as const) {
      expect(decodeUserspaceSyscallTrace(release(cause))).toMatchObject({ version: 40, dropped: 0n,
        events: [{ pid: 2, tid: 2, outcome: { kind: "result", value: 0n }, work: {
          completion: "retiring", done: false, creatorTid: 2, cpuCgroupId: 91n, executor: {
            kind, source: { pid: 2, tid: 2, guestTicks: 50n },
          }, retirement: { completion: "released", phase: "unpin", pinsBefore: 257n },
        } }],
      });
    }
  });

  it("rejects release retirement in historical trace38/39 while preserving committed CQ retirement", () => {
    for (const version of [38, 39]) {
      const bytes = release(), view = new DataView(bytes.buffer);
      view.setUint16(4, version, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
      bytes[24 + 786] = 2; view.setBigInt64(24 + 112, 4n, true);
      view.setBigUint64(24 + 952, 0n, true);
      expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ version,
        events: [{ work: { retirement: { completion: "published" } } }],
      });
    }
  });

  it("rejects nonzero results, foreign issuers, invalid buffer opcodes and invented release phases", () => {
    for (const change of [
      (view: DataView): void => view.setBigInt64(24 + 112, 1n, true),
      (view: DataView): void => view.setUint32(24 + 632, 3, true),
      (view: DataView): void => view.setUint8(24 + 232, 22),
      (view: DataView): void => view.setUint8(24 + 786, 4),
      (view: DataView): void => view.setBigUint64(24 + 928, 1n, true),
    ]) {
      const bytes = release(); change(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});
