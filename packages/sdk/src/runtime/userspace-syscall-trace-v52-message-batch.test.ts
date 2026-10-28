import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.ts";

function batchWait(number = 299n, completed = 64n, total = 130n, reason = 1): Uint8Array {
  const bytes = new Uint8Array(24 + 992), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 52, true); view.setUint32(8, 992, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  for (const field of [24, 28]) view.setUint32(offset + field, 1, true);
  view.setBigUint64(offset + 40, 0x401000n, true); view.setBigUint64(offset + 48, 0x401002n, true);
  view.setBigUint64(offset + 56, number, true);
  view.setBigUint64(offset + 64, 3n, true); view.setBigUint64(offset + 72, 0x9000n, true);
  view.setBigUint64(offset + 80, total, true);
  view.setUint8(offset + 120, 2); view.setUint8(offset + 122, 18);
  view.setBigUint64(offset + 128, completed, true); view.setBigUint64(offset + 136, total, true);
  view.setUint8(offset + 192, reason);
  return bytes;
}

describe("trace52 message batch continuations", () => {
  it("keeps the original batch syscall and exact message progress", () => {
    for (const number of [299n, 307n]) {
      expect(decodeUserspaceSyscallTrace(batchWait(number))).toMatchObject({ version: 52, events: [{
        number, outcome: { kind: "blocked" }, wait: {
          kind: "message-batch", completedMessages: 64, totalMessages: 130, reason: "message-bound",
        },
      }] });
    }
  });

  it("records CPU quota before the first message and a runnable sibling", () => {
    const bytes = batchWait(299n, 0n, 2n, 2);
    new DataView(bytes.buffer).setUint8(24 + 120, 1);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({
      outcome: { kind: "resumed" }, wait: {
        kind: "message-batch", completedMessages: 0, totalMessages: 2, reason: "cpu-quota",
      },
    });
  });

  it("uses the Linux low count word and the send vector cap", () => {
    const receive = batchWait(), receiveView = new DataView(receive.buffer);
    receiveView.setBigUint64(24 + 80, (1n << 32n) | 130n, true);
    expect(decodeUserspaceSyscallTrace(receive).events[0]?.wait).toMatchObject({ totalMessages: 130 });
    const send = batchWait(307n, 64n, 1024n);
    new DataView(send.buffer).setBigUint64(24 + 80, 8192n, true);
    expect(decodeUserspaceSyscallTrace(send).events[0]?.wait).toMatchObject({ totalMessages: 1024 });
  });

  it("rejects stale schemas, wrong calls, impossible counters and reserved fields", () => {
    const changes: readonly ((view: DataView) => void)[] = [
      view => view.setUint16(4, 51, true), view => view.setBigUint64(24 + 56, 47n, true),
      view => view.setUint8(24 + 120, 0), view => view.setUint8(24 + 192, 0),
      view => view.setUint8(24 + 192, 3), view => view.setUint8(24 + 193, 1),
      view => view.setUint8(24 + 123, 1), view => view.setBigUint64(24 + 144, 1n, true),
      view => view.setBigUint64(24 + 128, 0n, true), view => view.setBigUint64(24 + 128, 131n, true),
      view => view.setBigUint64(24 + 136, 0n, true), view => view.setBigUint64(24 + 136, 129n, true),
      view => view.setBigUint64(24 + 136, 0x1_0000_0000n, true),
      view => view.setBigUint64(24 + 64, 0xffff_ffffn, true),
    ];
    for (const change of changes) {
      const bytes = batchWait(); change(new DataView(bytes.buffer));
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
  });
});
