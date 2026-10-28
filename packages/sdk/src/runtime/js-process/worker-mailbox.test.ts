import { expect, it } from "vitest";
import { JS_MAILBOX_BYTES } from "./codec.js";
import { writeWorkerMailbox } from "./worker-mailbox.js";

it("publishes complete bounded replies and leaves the mailbox unchanged on invalid input", () => {
  const memory = new SharedArrayBuffer(JS_MAILBOX_BYTES), header = new Int32Array(memory, 0, 4), body = new Uint8Array(memory, 16);
  writeWorkerMailbox(header, body, 17, 13, 9n, Uint8Array.of(3, 4));
  expect([...header]).toEqual([1, 14, 17, 0]);
  expect(new DataView(memory, 16).getUint32(0, true)).toBe(13);
  expect(new DataView(memory, 16).getBigUint64(4, true)).toBe(9n);
  expect([...body.slice(12, 14)]).toEqual([3, 4]);
  const before = new Uint8Array(memory).slice();
  for (const [sequence, errno, value, payload] of [
    [0, 0, 0n, new Uint8Array()], [18, 4096, 0n, new Uint8Array()],
    [18, 0, -1n, new Uint8Array()], [18, 0, 0n, new Uint8Array(JS_MAILBOX_BYTES)],
  ] as const) expect(() => writeWorkerMailbox(header, body, sequence, errno, value, payload)).toThrow();
  expect(new Uint8Array(memory).every((byte, index) => byte === before[index])).toBe(true);
});
