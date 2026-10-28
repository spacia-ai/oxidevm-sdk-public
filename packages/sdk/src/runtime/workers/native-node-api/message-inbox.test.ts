import { expect, it } from "vitest";
import { SharedMessageInbox } from "./message-inbox.js";

for (const key of ["min", "max"] as const) it(`ignores application Math.${key} while growing and reading the inbox`, () => {
  const writer = new SharedMessageInbox(), reader = new SharedMessageInbox(writer.buffer);
  const payload = new Uint8Array(8192).fill(42), define = Object.defineProperty;
  const previous = Object.getOwnPropertyDescriptor(Math, key);
  if (previous === undefined) throw new Error("Missing Math descriptor");
  let effects = 0, failure: unknown, result: ReturnType<SharedMessageInbox["peek"]>;
  try {
    define(Math, key, { configurable: true, get() { effects++; throw new Error("Application Math"); } });
    try { writer.publish(1, payload, 0); result = reader.peek(); reader.consume(1); } catch (error) { failure = error; }
  } finally { define(Math, key, previous); }
  expect(effects).toBe(0); expect(failure).toBeUndefined(); expect(result).toEqual({ sequence: 1, bytes: payload });
  expect(reader.peek()).toBeUndefined(); expect(writer.buffer.byteLength).toBeGreaterThan(4112);
});

it("publishes complete frames, grows lazily and preserves wrapped cursor order", () => {
  const writer = new SharedMessageInbox(), reader = new SharedMessageInbox(writer.buffer);
  expect(writer.buffer.byteLength).toBe(4112);
  const payload = new Uint8Array(128 * 1024).fill(42);
  writer.publish(1, payload, 4095);
  expect(reader.peek()).toEqual({ sequence: 1, bytes: payload });
  reader.consume(1); expect(reader.peek()).toBeUndefined();
  const header = new Int32Array(writer.buffer, 0, 4);
  Atomics.store(header, 0, -4); Atomics.store(header, 1, -4);
  writer.publish(2, Uint8Array.of(1, 2, 3), 4095);
  expect(reader.peek()).toEqual({ sequence: 2, bytes: Uint8Array.of(1, 2, 3) });
  reader.consume(2); expect(reader.peek()).toBeUndefined();
  writer.publish(3, null, 4095); expect(reader.peek()).toEqual({ sequence: 3, bytes: null }); reader.consume(3);
});

it("rejects malformed cursor, capacity, sequence and frame lengths", () => {
  expect(() => new SharedMessageInbox(new SharedArrayBuffer(4096))).toThrow(/inbox/u);
  const inbox = new SharedMessageInbox(), header = new Int32Array(inbox.buffer, 0, 4);
  expect(() => inbox.consume(1)).toThrow(/inbox/u);
  Atomics.store(header, 1, 4); expect(() => inbox.peek()).toThrow(/inbox/u);
  Atomics.store(header, 1, 0); inbox.publish(1, Uint8Array.of(1), 0);
  expect(() => inbox.consume(2)).toThrow(/inbox/u);
  new DataView(inbox.buffer).setUint32(20, 100, true); expect(() => inbox.peek()).toThrow(/inbox/u);
});
