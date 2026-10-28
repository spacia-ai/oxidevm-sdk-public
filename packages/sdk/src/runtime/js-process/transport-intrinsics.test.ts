import { expect, it } from "vitest";
import { integer, record } from "../decode.js";
import { JS_MAILBOX_BYTES, LinuxError, operation, Writer } from "./codec.js";
import { LinuxClient } from "./transport.js";

for (const key of ["getUint32", "getBigUint64", "Number", "BigInt", "DataView", "Uint8Array", "set", "subarray", "slice"] as const) for (const throwing of [false, true]) it("synchronous Linux replies ignore " + key + " getters throwing=" + String(throwing), () => {
  const channel = new MessageChannel(), memory = new SharedArrayBuffer(JS_MAILBOX_BYTES);
  const header = new Int32Array(memory, 0, 4), body = new Uint8Array(memory, 16);
  const writeReply = body.set.bind(body);
  const reply = new Writer().u32(0).u64(0x0123_4567_89ab_cdefn).raw(new Uint8Array([3, 4])).finish();
  const client = new LinuxClient(channel.port1, memory), request = operation(79, new Writer(), result => result);
  channel.port1.postMessage = (input: unknown) => {
    const sequence = integer(record(input, "request")["sequence"], "sequence", 1);
    writeReply(reply); Atomics.store(header, 1, reply.length); Atomics.store(header, 2, sequence); Atomics.store(header, 0, 1);
  };
  const prototype = Reflect.getPrototypeOf(Uint8Array.prototype);
  if (prototype === null) throw new Error("Missing mailbox byte prototype");
  const owner = key === "set" || key === "subarray" || key === "slice" ? prototype : key === "getUint32" || key === "getBigUint64" ? DataView.prototype : globalThis;
  const original = Object.getOwnPropertyDescriptor(owner, key);
  if (original === undefined) throw new Error("Missing mailbox intrinsic");
  const previous: unknown = original.value, define = Object.defineProperty;
  let effects = 0, failure: unknown, output: unknown;
  try {
    try {
      define(owner, key, { configurable: true, get(): unknown { effects++; if (throwing) throw new Error("Application mailbox getter"); return previous; } });
      try { output = client.sync(request); } catch (error) { failure = error; }
    } finally { define(owner, key, original); }
    expect(effects).toBe(0); expect(failure).toBeUndefined();
    expect(output).toEqual({ value: 0x0123_4567_89ab_cdefn, bytes: new Uint8Array([3, 4]) });
  } finally { client.dispose(); channel.port2.close(); }
});

it("synchronous Linux replies preserve errno, bounds, sequence checks and a later valid request", () => {
  const channel = new MessageChannel(), memory = new SharedArrayBuffer(JS_MAILBOX_BYTES);
  const header = new Int32Array(memory, 0, 4), body = new Uint8Array(memory, 16);
  const client = new LinuxClient(channel.port1, memory), request = operation(79, new Writer(), result => result.value);
  let errno = 13, length = 12, wrongSequence = false, decoded = false;
  channel.port1.postMessage = (input: unknown) => {
    const sequence = integer(record(input, "request")["sequence"], "sequence", 1);
    body.set(new Writer().u32(errno).u64(7n).finish());
    Atomics.store(header, 1, length); Atomics.store(header, 2, wrongSequence ? sequence + 1 : sequence); Atomics.store(header, 0, 1);
  };
  try {
    expect(() => client.sync({ ...request, decode: () => { decoded = true; } })).toThrow(LinuxError);
    expect(decoded).toBe(false);
    errno = 0; length = 11;
    expect(() => client.sync(request)).toThrow(/Linux mailbox length/u);
    length = 12; wrongSequence = true;
    expect(() => client.sync(request)).toThrow(/sequence mismatch/u);
    wrongSequence = false; expect(client.sync(request)).toBe(7n);
  } finally { client.dispose(); channel.port2.close(); }
});
