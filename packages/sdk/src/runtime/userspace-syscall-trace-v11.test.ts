import { describe, expect, expectTypeOf, it } from "vitest";
import { decodeUserspaceSyscallTrace } from "./userspace-abi.js";

function waitingTrace(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(312), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 11, true); view.setUint32(8, 288, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 426n, true);
  bytes[offset + 120] = 2; bytes[offset + 121] = 14; bytes[offset + 123] = 1;
  bytes.set(new TextEncoder().encode("io_uring_enter"), offset + 152);
  view.setBigUint64(offset + 192, 7n, true); view.setBigUint64(offset + 200, 9n, true);
  view.setBigUint64(offset + 208, 51n, true); view.setUint32(offset + 216, 1, true);
  view.setUint32(offset + 224, 0xffff_fffe, true); view.setUint32(offset + 228, 1, true);
  bytes[offset + 232] = 22; bytes[offset + 234] = 3;
  view.setBigUint64(offset + 240, 19n, true); view.setBigUint64(offset + 248, 23n, true);
  view.setUint32(offset + 256, 1, true); view.setBigUint64(offset + 264, 25n, true);
  return bytes;
}

describe("Userspace trace v11 pending I/O", () => {
  it("retains the waiting work identity and exact retained description interest", () => {
    const event = decodeUserspaceSyscallTrace(waitingTrace()).events[0];
    if (event?.kind !== "io-uring-work" || event.work.completion !== "waiting") throw new Error("waiting work missing");
    expectTypeOf(event.work.done).toEqualTypeOf<false>();
    expectTypeOf(event.work.canceledBy).toEqualTypeOf<undefined>();
    if (event.work.wait.kind !== "readiness") throw new Error("readiness wait missing");
    expectTypeOf(event.work.wait).toEqualTypeOf<{ readonly kind: "readiness"; readonly openFileId: bigint; readonly events: 1 | 4; readonly wakeups: bigint }>();
    expect(decodeUserspaceSyscallTrace(waitingTrace())).toMatchObject({ version: 11, events: [{
      kind: "io-uring-work", outcome: { kind: "blocked" }, work: {
        poolId: 7n, sequence: 9n, credentialId: 19n, completion: "waiting", done: false,
        wait: { openFileId: 23n, events: 1, wakeups: 25n },
      },
    }] });
  });

  it("rejects waiting work with a result, final status, missing source or invalid interest", () => {
    for (const [offset, value] of [[120, 0], [233, 1], [248, 0], [256, 0], [256, 2], [260, 1]] as const) {
      const bytes = waitingTrace(); bytes[24 + offset] = value;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow("malformed");
    }
  });

  it("rejects wait metadata on completed work or an older schema", () => {
    const bytes = waitingTrace(), view = new DataView(bytes.buffer);
    bytes[24 + 120] = 0; bytes[24 + 234] = 2;
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow("malformed");
    view.setUint16(4, 10, true); bytes[24 + 234] = 3;
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow("malformed");
  });
});
