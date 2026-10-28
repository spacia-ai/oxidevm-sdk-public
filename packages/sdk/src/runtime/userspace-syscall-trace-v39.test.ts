import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function exited(phase = 3, completion = 2, cause = 4): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 960), view = new DataView(bytes.buffer), at = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 39, true); view.setUint32(8, 960, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(at + field, 1n, true);
  view.setUint32(at + 24, 2, true); view.setUint32(at + 28, 2, true);
  view.setBigUint64(at + 40, 0x1000n, true); view.setBigUint64(at + 48, 0x1002n, true);
  view.setBigUint64(at + 56, 426n, true); bytes[at + 123] = 1;
  view.setBigUint64(at + 192, 7n, true); view.setBigUint64(at + 200, 9n, true);
  view.setBigUint64(at + 208, 51n, true); view.setUint32(at + 216, 2, true);
  bytes[at + 234] = completion; view.setBigUint64(at + 240, 19n, true);
  bytes[at + 624] = cause;
  view.setUint32(at + 632, 2, true); view.setUint32(at + 636, 2, true);
  view.setBigUint64(at + 640, 50n, true); view.setBigUint64(at + 704, 0x2000n, true);
  view.setBigUint64(at + 720, 1n, true); view.setBigUint64(at + 928, 3n, true);
  bytes[at + 936] = phase;
  if (cause === 4) bytes[at + 625] = 9;
  else {
    view.setBigUint64(at + 648, cause === 3 ? 231n : 102n, true);
    view.setBigUint64(at + 712, 0x2002n, true);
    if (cause === 5) {
      bytes[at + 728] = 3; view.setUint16(at + 730, 2, true);
      view.setUint32(at + 732, 0x80000000, true); view.setBigUint64(at + 736, 88n, true);
    }
  }
  if (completion === 12) bytes[at + 233] = 1;
  return bytes;
}

describe("trace39 exited issuer generations", () => {
  it("preserves signal, syscall and seccomp origins through publication, notification and retirement", () => {
    for (const [cause, kind] of [[3, "exited"], [4, "exited-signal"], [5, "exited-seccomp"]] as const) {
      for (const [phase, tag, action, completion] of [[3, 2, "publish", "published"],
        [4, 9, "notify", "notified"], [5, 12, "retire", "retired"]] as const) {
        expect(decodeUserspaceSyscallTrace(exited(phase, tag, cause))).toMatchObject({ version: 39,
          dropped: 0n, events: [{ work: { completion, executor: {
            kind, source: { pid: 2, tid: 2, guestTicks: 50n }, issuer: { generation: 3n, phase: action },
          } } }] });
      }
    }
  });

  it("rejects reissue, admission, zero generations and mismatched completion phases after exit", () => {
    for (const [phase, tag] of [[1, 5], [2, 10], [3, 9], [4, 2], [5, 9]] as const) {
      expect(() => decodeUserspaceSyscallTrace(exited(phase, tag))).toThrow();
    }
    for (const [field, value] of [[928, 0], [936, 0], [937, 1], [959, 1], [625, 0]] as const) {
      const bytes = exited(); bytes[24 + field] = value;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });

  it("keeps trace38 exited trailers reserved and rejects an unowned trace39 publication", () => {
    const old = exited(); new DataView(old.buffer).setUint16(4, 38, true);
    expect(() => decodeUserspaceSyscallTrace(old)).toThrow();
    const missing = exited(); missing.fill(0, 24 + 928, 24 + 960);
    expect(() => decodeUserspaceSyscallTrace(missing)).toThrow();
  });

  it("retains the actual exec thread while another thread owns the committed generation", () => {
    for (const [phase, completion] of [[3, 2], [4, 9], [5, 12]] as const) {
      const bytes = exited(phase, completion, 3), view = new DataView(bytes.buffer);
      bytes[24 + 624] = 7;
      view.setBigUint64(24 + 648, 59n, true);
      view.setUint32(24 + 216, 3, true);
      expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ work: {
        creatorTid: 3, executor: { kind: "ordinary-task-run", source: { tid: 2, number: 59n } },
      } }] });
      view.setUint16(4, 38, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
      view.setUint16(4, 39, true);
      view.setBigUint64(24 + 648, 102n, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});
