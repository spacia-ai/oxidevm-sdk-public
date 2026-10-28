import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";
import { counterCapacityWait } from "./userspace-syscall-trace-v33.fixtures.ts";
import { putSource } from "./workers/userspace-registration-failure.fixtures.ts";
import type { UserspaceIoUringEnterProgress } from "./userspace-io-uring-enter-body.ts";

function cqWriter(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 928), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(counterCapacityWait());
  view.setUint16(4, 35, true); view.setUint32(8, 928, true);
  bytes.fill(0, offset + 248, offset + 272);
  bytes.fill(0, offset + 512, offset + 552);
  bytes[offset + 232] = 0; bytes[offset + 512] = 4;
  view.setBigUint64(offset + 520, 17n, true);
  putSource(view, offset + 832, 426n, 7);
  return bytes;
}

function enterBody(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 928), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 35, true); view.setUint32(8, 928, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 7, true); view.setUint32(offset + 28, 7, true);
  view.setBigUint64(offset + 40, 0x5000n, true); view.setBigUint64(offset + 48, 0x5002n, true);
  view.setBigUint64(offset + 56, 426n, true);
  view.setBigUint64(offset + 64, 3n, true); view.setBigUint64(offset + 72, 512n, true);
  bytes[offset + 120] = 2; bytes[offset + 122] = 15;
  view.setBigUint64(offset + 128, 17n, true); view.setBigUint64(offset + 136, 11n, true);
  bytes[offset + 192] = 2; bytes[offset + 193] = 2;
  view.setUint32(offset + 196, 128, true); view.setBigUint64(offset + 200, 139n, true);
  for (const [index, count] of [127, 256, 0, 33].entries()) view.setUint32(offset + 208 + index * 4, count, true);
  return bytes;
}

interface BodyPhase {
  readonly phase: number;
  readonly counts: readonly [number, number, number, number];
  readonly expected: UserspaceIoUringEnterProgress;
  readonly errno?: number;
  readonly corrupt: (view: DataView) => void;
}

const bodyPhases: readonly BodyPhase[] = [
  { phase: 1, counts: [0, 0, 0, 0], expected: { kind: "starting" },
    corrupt: view => view.setUint32(24 + 208, 1, true) },
  { phase: 2, counts: [256, 256, 8, 33], expected: { kind: "funding", submissionPages: 256, submissionGoal: 256, completionPages: 8, completionGoal: 33 },
    corrupt: view => view.setUint32(24 + 208, 255, true) },
  { phase: 3, counts: [7, 512, 2, 5], expected: { kind: "submitting", submitted: 7, maximum: 512, preparedEntries: 2, completions: 5 },
    corrupt: view => view.setUint32(24 + 216, 506, true) },
  { phase: 4, counts: [0, 128, 0, 0], expected: { kind: "cq-claim", outputs: 128 },
    corrupt: view => view.setUint32(24 + 208, 1, true) },
  { phase: 5, counts: [64, 128, 64, 0], expected: { kind: "publishing", phase: "outputs", nextOutput: 64, ownedOutputs: 128, stagedTail: 64, retiringPages: 0 },
    corrupt: view => view.setUint32(24 + 208, 129, true) },
  { phase: 6, counts: [128, 128, 128, 0], expected: { kind: "publishing", phase: "overflow", nextOutput: 128, ownedOutputs: 128, stagedTail: 128, retiringPages: 0 },
    corrupt: view => view.setUint32(24 + 208, 127, true) },
  { phase: 7, counts: [128, 0, 128, 33], expected: { kind: "publishing", phase: "flush", nextOutput: 128, ownedOutputs: 0, stagedTail: 128, retiringPages: 33 },
    corrupt: view => view.setUint32(24 + 212, 1, true) },
  { phase: 8, counts: [128, 0, 128, 0], expected: { kind: "publishing", phase: "commit", nextOutput: 128, ownedOutputs: 0, stagedTail: 128, retiringPages: 0 },
    corrupt: view => view.setUint32(24 + 220, 1, true) },
  { phase: 9, counts: [512, 10, 33, 0], expected: { kind: "retiring", submitted: 512, submissionPages: 10, completionPages: 33 },
    corrupt: view => view.setUint32(24 + 212, 257, true) },
  { phase: 10, counts: [127, 0, 0, 0], errno: 12, expected: { kind: "allocation-cleanup", submissionPages: 127, completionPages: 0, errno: 12 },
    corrupt: view => view.setUint32(24 + 244, 5, true) },
  { phase: 11, counts: [512, 0, 0, 0], expected: { kind: "complete", submitted: 512 },
    corrupt: view => view.setUint32(24 + 208, 513, true) },
  { phase: 12, counts: [0, 0, 0, 0], errno: 5, expected: { kind: "failed", errno: 5 },
    corrupt: view => view.setUint32(24 + 244, 0, true) },
];

function phaseBody(phase: BodyPhase): Uint8Array<ArrayBuffer> {
  const bytes = enterBody(), view = new DataView(bytes.buffer);
  bytes[24 + 192] = phase.phase;
  for (const [index, count] of phase.counts.entries()) view.setUint32(24 + 208 + index * 4, count, true);
  view.setUint32(24 + 244, phase.errno ?? 0, true);
  return bytes;
}

describe("trace35 caller cursor phases", () => {
  for (const phase of bodyPhases) {
    it(`decodes ${phase.expected.kind} phase ${phase.phase} and rejects its contradictory state`, () => {
      const bytes = phaseBody(phase);
      expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ wait: { progress: phase.expected } }] });
      phase.corrupt(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    });
  }

  it("preserves a prepared SQE or a partially copied vector header prefix", () => {
    for (const vector of [false, true]) {
      const phase = bodyPhases.find(candidate => candidate.phase === 3);
      if (phase === undefined) throw new Error("submitting phase missing");
      const bytes = phaseBody(phase), view = new DataView(bytes.buffer);
      view.setUint32(24 + 224, 17, true); view.setUint32(24 + 228, 4, true);
      bytes[24 + 232] = vector ? 1 : 0; bytes[24 + 233] = vector ? 2 : 1;
      if (vector) {
        view.setUint32(24 + 216, 0, true);
        view.setUint32(24 + 236, 16, true); view.setUint32(24 + 240, 33, true);
      }
      expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ wait: { progress: {
        kind: "submitting", item: { kind: vector ? "iovecs" : "prepared", sqSequence: 17, sqeIndex: 4, opcode: vector ? 1 : 0,
          ...(vector ? { copiedHeaders: 16, totalHeaders: 33 } : {}) },
      } } }] });
      if (vector) view.setUint32(24 + 236, 17, true);
      else view.setUint32(24 + 216, 0, true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });

  it("accepts an empty enter whose completed return is held by CPU quota", () => {
    const phase = bodyPhases.find(candidate => candidate.phase === 11);
    if (phase === undefined) throw new Error("complete phase missing");
    const bytes = phaseBody(phase), view = new DataView(bytes.buffer);
    view.setBigUint64(24 + 72, 0n, true); view.setUint32(24 + 208, 0, true);
    bytes[24 + 193] = 3; view.setUint32(24 + 196, 6, true);
    expect(decodeUserspaceSyscallTrace(bytes)).toMatchObject({ events: [{ wait: {
      reason: "cpu-quota", kernelUnits: 6, progress: { kind: "complete", submitted: 0 },
    } }] });
  });
});

describe("trace35 private CQ writer", () => {
  it("attributes a bounded caller turn to its actual funding cursor", () => {
    expect(decodeUserspaceSyscallTrace(enterBody())).toMatchObject({ version: 35, events: [{
      kind: "syscall", wait: { kind: "io-uring-enter", ringOpenFileId: 17n,
        admittedGuestTicks: 11n, guestTicks: 139n, kernelUnits: 128, reason: "turn-limit",
        progress: { kind: "funding", submissionPages: 127, submissionGoal: 256, completionPages: 0, completionGoal: 33 },
      },
    }] });
  });

  it("rejects invalid caller sources, budgets, cursor phases, counts and padding", () => {
    const changes: readonly ((view: DataView) => void)[] = [
      view => view.setBigUint64(24 + 56, 427n, true), view => view.setBigUint64(24 + 128, 0n, true),
      view => view.setBigUint64(24 + 64, 0xffff_ffffn, true), view => view.setBigUint64(24 + 88, 256n, true),
      view => view.setUint8(24 + 192, 13), view => view.setUint8(24 + 193, 1),
      view => view.setUint8(24 + 194, 1), view => view.setUint32(24 + 196, 129, true),
      view => view.setUint32(24 + 196, 127, true), view => view.setBigUint64(24 + 200, 138n, true),
      view => view.setUint32(24 + 208, 257, true), view => view.setUint32(24 + 220, 2050, true),
      view => view.setUint8(24 + 224, 1), view => view.setUint32(24 + 244, 12, true),
      view => view.setUint8(24 + 248, 1), view => view.setUint8(24 + 832, 1),
    ];
    for (const change of changes) {
      const bytes = enterBody(); change(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });

  it("retains a waiting request and the writer's complete admitted source", () => {
    expect(decodeUserspaceSyscallTrace(cqWriter())).toMatchObject({ version: 35, events: [{
      kind: "io-uring-work", outcome: { kind: "blocked" }, work: {
        completion: "waiting", done: false, opcode: 0, wait: {
          kind: "cq-writer", ringOpenFileId: 17n,
          source: { pid: 7, tid: 7, number: 426n, instructionRip: 0x5000n, nextRip: 0x5002n },
        },
      },
    }] });
  });

  it("rejects version skew, missing or foreign owners and contradictory wait payloads", () => {
    const changes: readonly ((view: DataView) => void)[] = [
      view => view.setUint16(4, 34, true), view => view.setUint32(8, 832, true),
      view => view.setBigUint64(24 + 520, 0n, true), view => view.setBigUint64(24 + 520, 0xffff_ffff_ffff_ffffn, true),
      view => view.setUint32(24 + 832, 0, true), view => view.setUint32(24 + 836, 0, true),
      view => view.setBigUint64(24 + 848, 427n, true), view => view.setBigUint64(24 + 840, 52n, true),
      view => view.setBigUint64(24 + 920, 0n, true), view => view.setBigUint64(24 + 912, 0x1010n, true),
      view => view.setUint8(24 + 528, 1), view => view.setUint8(24 + 513, 1),
      view => view.setBigUint64(24 + 248, 17n, true), view => view.setUint8(24 + 233, 1),
      view => view.setUint8(24 + 234, 2),
    ];
    for (const change of changes) {
      const bytes = cqWriter(); change(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });

  it("rejects owner payload bytes on an ordinary wait", () => {
    const bytes = cqWriter(), view = new DataView(bytes.buffer);
    bytes[24 + 512] = 3; bytes[24 + 232] = 23;
    view.setBigUint64(24 + 248, 17n, true); view.setUint32(24 + 256, 4, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });
});
