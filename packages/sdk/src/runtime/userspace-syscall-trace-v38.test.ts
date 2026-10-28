import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace, USERSPACE_SYSCALL_TRACE_VERSION,
  type UserspaceSyscallTraceSnapshot } from "./userspace-abi.ts";

function boundary(phase = 1, completion = 5, source = 426n): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 960), view = new DataView(bytes.buffer), at = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 38, true); view.setUint32(8, 960, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(at + field, 1n, true);
  view.setUint32(at + 24, 1, true); view.setUint32(at + 28, 1, true);
  view.setBigUint64(at + 40, 0x1000n, true); view.setBigUint64(at + 48, 0x1002n, true);
  view.setBigUint64(at + 56, 426n, true); bytes[at + 123] = 1;
  view.setBigUint64(at + 192, 7n, true); view.setBigUint64(at + 200, 9n, true);
  view.setBigUint64(at + 208, 51n, true); view.setUint32(at + 216, 1, true);
  bytes[at + 234] = completion; view.setBigUint64(at + 240, 19n, true);
  if (completion === 5) {
    bytes[at + 512] = 2; view.setBigUint64(at + 520, 71n, true);
    view.setUint32(at + 528, 1, true);
  }
  bytes[at + 624] = 7;
  view.setUint32(at + 632, 1, true); view.setUint32(at + 636, 1, true);
  view.setBigUint64(at + 640, 50n, true); view.setBigUint64(at + 648, source, true);
  view.setBigUint64(at + 704, 0x2000n, true); view.setBigUint64(at + 712, 0x2002n, true);
  view.setBigUint64(at + 720, 1n, true); view.setBigUint64(at + 928, 3n, true);
  bytes[at + 936] = phase;
  return bytes;
}

describe("trace38 ordinary issuer generations", () => {
  function callerYield(reason = 2, units = 17): Uint8Array<ArrayBuffer> {
    const bytes = boundary(3, 2), view = new DataView(bytes.buffer), at = 24;
    bytes.fill(0, at + 192, at + 928);
    bytes[at + 123] = 0; bytes[at + 120] = 2; bytes[at + 122] = 16;
    view.setBigUint64(at + 56, 39n, true);
    view.setBigUint64(at + 128, 71n, true); view.setBigUint64(at + 136, 1n, true);
    bytes[at + 937] = reason; view.setUint32(at + 940, units, true);
    return bytes;
  }

  it("retains exact CPU, turn and CQ-writer yields without inventing another syscall", () => {
    for (const [tag, units, reason] of [[1, 128, "turn-limit"], [2, 17, "cpu-quota"],
      [3, 17, "cq-writer"]] as const) {
      expect(decodeUserspaceSyscallTrace(callerYield(tag, units))).toMatchObject({ events: [{
        kind: "syscall", number: 39n, outcome: { kind: "blocked" }, wait: {
          kind: "io-uring-issuer", generation: 3n, phase: "publish", reason,
          ringOpenFileId: 71n, pendingRequests: 1, kernelUnits: units,
        },
      }] });
    }
  });

  it("rejects invalid yield units, reasons, owners, phases and unused trailers", () => {
    for (const [reason, units] of [[0, 17], [4, 17], [1, 127], [2, 129]] as const) {
      expect(() => decodeUserspaceSyscallTrace(callerYield(reason, units))).toThrow();
    }
    for (const [field, value] of [[128, 0], [136, 0], [928, 0], [938, 1], [944, 1],
      [192, 1], [120, 0]] as const) {
      const bytes = callerYield(); bytes[24 + field] = value;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const writer = callerYield(3); writer[24 + 936] = 1;
    expect(() => decodeUserspaceSyscallTrace(writer)).toThrow();
    const unrelated = callerYield(); unrelated[24 + 122] = 0;
    expect(() => decodeUserspaceSyscallTrace(unrelated)).toThrow();
  });

  it("retains arbitrary real syscall-return sources and the canonical generation", () => {
    const version: UserspaceSyscallTraceSnapshot["version"] = 38;
    expect(USERSPACE_SYSCALL_TRACE_VERSION).toBe(52);
    for (const source of [39n, 426n, 427n, 228n, 999999n]) {
      expect(decodeUserspaceSyscallTrace(boundary(1, 5, source))).toMatchObject({ version, events: [{
        kind: "io-uring-work", work: { completion: "task-run", done: false,
          executor: { kind: "ordinary-task-run", generation: 3n, phase: "issue",
            source: { number: source, instructionRip: 0x2000n, nextRip: 0x2002n } } },
      }] });
    }
  });

  it("distinguishes worker admission, publication, notification and retirement", () => {
    for (const [phase, tag, completion, name] of [[2, 10, "worker-queued", "admit-worker"],
      [3, 2, "published", "publish"], [4, 9, "notified", "notify"], [5, 12, "retired", "retire"]] as const) {
      expect(decodeUserspaceSyscallTrace(boundary(phase, tag))).toMatchObject({ events: [{ work: {
        completion, executor: { generation: 3n, phase: name },
      } }] });
    }
    for (const errno of [11n, 12n]) {
      const bytes = boundary(2, 11); new DataView(bytes.buffer).setBigInt64(24 + 112, -errno, true);
      expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{
        outcome: { kind: "result", value: -errno }, work: { completion: "worker-rejected" },
      }] });
    }
  });

  it("rejects invented generations, phases, mixed boundaries and reserved bytes", () => {
    for (const [field, value] of [[928, 0], [936, 0], [936, 6], [937, 1], [940, 1],
      [959, 1], [624, 1], [636, 2], [233, 1]] as const) {
      const bytes = boundary(); bytes[24 + field] = value;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const [phase, tag] of [[1, 9], [2, 2], [3, 10], [4, 5], [5, 9]] as const) {
      expect(() => decodeUserspaceSyscallTrace(boundary(phase, tag))).toThrow();
    }
    for (const value of [0n, -125n]) {
      const bytes = boundary(2, 11); new DataView(bytes.buffer).setBigInt64(24 + 112, value, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });

  it("does not reinterpret new executors or completions in trace37", () => {
    for (const [phase, completion] of [[1, 5], [2, 10], [3, 2], [4, 9], [5, 12]] as const) {
      const bytes = boundary(phase, completion).slice(0, 24 + 928), view = new DataView(bytes.buffer);
      view.setUint16(4, 37, true); view.setUint32(8, 928, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});
