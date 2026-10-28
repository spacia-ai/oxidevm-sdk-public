import { describe, expect, expectTypeOf, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";
import { registeredCancellation, registeredCancellationTaskRun, registeredCancellationDeferredTaskRun, counterCapacityWait, syncCancelTurn } from "./userspace-syscall-trace-v33.fixtures.ts";
import { decodeUserspaceRegistrationFailure } from "./workers/userspace-registration-failure.ts";
import { record } from "./workers/userspace-registration-failure.fixtures.ts";

describe("trace33 synchronous cancellation", () => {
  it("preserves the admitted trace version on the decoded envelope", () => {
    for (const bytes of [counterCapacityWait(), registeredCancellation(), registeredCancellationTaskRun(),
      registeredCancellationDeferredTaskRun(), syncCancelTurn(14, 2)]) {
      expect(decodeUserspaceSyscallTrace(bytes).version).toBe(33);
    }
  });
  it("preserves the exact eventfd capacity and rejects legacy, read, padding and empty-counter claims", () => {
    expect(decodeUserspaceSyscallTrace(counterCapacityWait()).events[0]).toMatchObject({
      work: { completion: "waiting", done: false, wait: { kind: "eventfd-capacity", openFileId: 57n,
        events: 4, wakeups: 5n, balance: 0xffff_ffff_ffff_fffen } },
    });
    const invalid: readonly ((view: DataView) => void)[] = [
      view => view.setUint16(4, 32, true), view => view.setUint8(24 + 232, 22),
      view => view.setBigUint64(24 + 520, 0n, true), view => view.setBigUint64(24 + 248, 0n, true),
      view => view.setUint8(24 + 513, 1), view => view.setUint8(24 + 528, 1),
    ];
    for (const mutate of invalid) {
      const bytes = counterCapacityWait(); mutate(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
  it("retains issuer-owned deferred cancellation without claiming CQ publication", () => {
    expect(decodeUserspaceSyscallTrace(registeredCancellationDeferredTaskRun()).events[0]).toMatchObject({
      tid: 7, work: { executor: { kind: "task-run", source: { number: 427n } },
        completion: "task-run", done: false, wait: { kind: "task-run", ringOpenFileId: 17n, issuerTid: 7 },
        canceledBy: { kind: "registration" } },
    });
  });
  it("admits issuer cancellation task work only with its exact registration source", () => {
    const bytes = registeredCancellationTaskRun();
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      tid: 7, work: { executor: { kind: "task-run", source: { number: 427n, tid: 7 } },
        canceledBy: { kind: "registration", source: { number: 427n, tid: 7 } } },
    });
    const invalid: readonly ((view: DataView) => void)[] = [
      view => view.setUint16(4, 32, true),
      view => view.setBigUint64(24 + 680, 0n, true),
      view => view.setBigUint64(24 + 664, 27n, true),
      view => view.setBigUint64(24 + 672, 0x600900n, true),
      view => view.setBigUint64(24 + 640, 11n, true),
    ];
    for (const mutate of invalid) {
      const forged = registeredCancellationTaskRun(); mutate(new DataView(forged.buffer));
      expect(() => decodeUserspaceSyscallTrace(forged)).toThrow();
    }
  });
  it("keeps the real register source and copied header without invented submission identities", () => {
    const event = decodeUserspaceSyscallTrace(registeredCancellation()).events[0];
    expect(event).toMatchObject({ kind: "io-uring-work", work: { canceledBy: {
      kind: "registration", source: { number: 427n, pid: 7, tid: 7 }, credentialId: 19n,
    } } });
    if (event?.kind !== "io-uring-work" || event.work.canceledBy === undefined) throw new Error("missing cause");
    const cause = event.work.canceledBy;
    if (cause.kind !== "registration") throw new Error("wrong cause family");
    expectTypeOf(cause.source.number).toEqualTypeOf<427n>();
    expectTypeOf(cause.execution).toEqualTypeOf<undefined>();
    expect(cause.header).toHaveLength(64);
    expect(cause.header[0]).toBe(73);
    expect(cause).not.toHaveProperty("execution"); expect(cause).not.toHaveProperty("sqSequence");
    expect(cause).not.toHaveProperty("sqeIndex"); expect(cause).not.toHaveProperty("sqe");
  });
  it("validates FD resolution before ANY matching and retains signed time fields verbatim", () => {
    const bytes = registeredCancellation(), view = new DataView(bytes.buffer);
    view.setUint32(24 + 444, 6, true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    view.setBigUint64(24 + 424, 57n, true);
    view.setBigUint64(24 + 344, 0x1_0000_0001n, true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({ work: { canceledBy: {
      kind: "registration", openFileId: 57n, source: { arguments: [3n, 24n, 0x600800n, 0x1_0000_0001n, 7n, 8n] },
    } } });
  });
  it("rejects legacy reinterpretation, fake SQE metadata, invalid counts and register padding", () => {
    const changes: readonly ((view: DataView) => void)[] = [
      view => view.setUint16(4, 32, true), view => view.setBigUint64(24 + 328, 14n, true),
      view => view.setBigUint64(24 + 344, 0n, true), view => view.setUint8(24 + 465, 1),
      ...[392, 400, 408, 412].map(offset => (view: DataView) => view.setUint8(24 + offset, 1)),
    ];
    for (const change of changes) {
      const bytes = registeredCancellation(); change(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
  it.each([[14, 2, "sync-cancel", "turn-limit"], [15, 4, "sync-cancel-wait", "sync-cancel"],
    [15, 5, "sync-cancel-wait", "sync-cancel-mutex"]] as const)("preserves phase %s reason %s", (phase, reason, name, wait) => {
    expect(decodeUserspaceSyscallTrace(syncCancelTurn(phase, reason)).events[0]).toMatchObject({
      number: 427n, wait: { phase: name, reason: wait, ringOpenFileId: 7n },
    });
  });
  it.each([14, 15])("admits OXRF4 phase %s and rejects older meaning and unrelated operations", phase => {
    const bytes = record(), view = new DataView(bytes.buffer);
    view.setUint16(4, 4, true); bytes[112] = phase;
    view.setBigUint64(40, 24n, true); view.setBigUint64(48, 0x600800n, true); view.setBigUint64(56, 1n, true);
    expect(decodeUserspaceRegistrationFailure(bytes).source.number).toBe(427n);
    view.setUint16(4, 3, true); expect(() => decodeUserspaceRegistrationFailure(bytes)).toThrow();
    view.setUint16(4, 4, true); view.setBigUint64(40, 27n, true);
    expect(() => decodeUserspaceRegistrationFailure(bytes)).toThrow();
  });
});
