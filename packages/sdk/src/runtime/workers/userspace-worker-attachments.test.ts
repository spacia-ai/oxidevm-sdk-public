import { expect, it } from "vitest";
import { UserspaceWorkerAttachments, type ProcessAttachmentState } from "./userspace-worker-attachments.js";
import { decodeNativeAttachments } from "./userspace-attachments.js";

function process(sessionId = 1): ProcessAttachmentState {
  return { pid: 7, identityKey: 1, sessionId, command: "sh", terminal: { columns: 80, rows: 24 }, stdinOpen: true,
    sequence: 4, acknowledged: 3, awaitingAck: { sequence: 4, stream: "stdout", count: 2 }, tail: new Uint8Array([1]), stopped: false };
}
it("captures acknowledged tails and native pending byte counts, reserving fresh attachment keys only for replacement", () => {
  const owner = new UserspaceWorkerAttachments(), original = process(owner.allocate());
  const captured = decodeNativeAttachments(owner.capture([original]));
  expect(captured.processes[0]).toMatchObject({ key: 1, pid: 7, sequence: 4, acknowledged: 3, pending: { stream: "stdout", count: 2 } });
  const replacement = owner.prepare(captured, false, [original], () => ({ columns: 101, rows: 37 }));
  expect(owner.pendingCount).toBe(0);
  replacement.publish(); const published = replacement.attachments;
  expect(published.processes[0]).toMatchObject({ key: 2, identityKey: 1, terminal: { columns: 101, rows: 37 }, sequence: 0, acknowledged: 0 });
  expect(owner.pendingCount).toBe(1);
  const adopted = owner.adopt(2); expect(adopted.pid).toBe(7); expect(adopted.pending).toBeUndefined();
  expect(() => owner.adopt(2)).toThrow();
  expect(original.awaitingAck).toEqual({ sequence: 4, stream: "stdout", count: 2 });
});
it("recovery retains original live keys and acknowledgement cut instead of replaying already emitted output", () => {
  const owner = new UserspaceWorkerAttachments(), original = process(owner.allocate());
  const captured = decodeNativeAttachments(owner.capture([original]));
  const recovery = owner.prepare(captured, true, [original], attachment => attachment.terminal);
  recovery.publish();
  expect(recovery.attachments.processes[0]).toMatchObject({ key: 1, sequence: 4, acknowledged: 3, pending: { stream: "stdout", count: 2 } });
  expect(owner.pendingCount).toBe(0); expect(owner.allocate()).toBe(2);
});
it("keeps the current attachment slots intact when candidate validation fails", () => {
  const owner = new UserspaceWorkerAttachments(), original = process(owner.allocate());
  const captured = decodeNativeAttachments(owner.capture([original]));
  expect(() => owner.prepare(captured, false, [original], () => { throw new Error("forged pending count"); })).toThrow();
  expect(owner.pendingCount).toBe(0); expect(owner.allocate()).toBe(2);
});

it("keeps original terminal identity and order across partially adopted replacements", () => {
  const owner = new UserspaceWorkerAttachments();
  const first = process(owner.allocate());
  const second = { ...process(owner.allocate()), pid: 8, identityKey: 2 };
  const saved = decodeNativeAttachments(owner.capture([first, second]));
  owner.prepare(saved, false, [first, second], attachment => attachment.terminal).publish();
  const adopted = owner.adopt(4);
  const active = { ...second, sessionId: adopted.key };
  const again = decodeNativeAttachments(owner.capture([active]));
  expect(again.processes.map(attachment => [attachment.identityKey, attachment.key])).toEqual([[1, 3], [2, 4]]);
});
