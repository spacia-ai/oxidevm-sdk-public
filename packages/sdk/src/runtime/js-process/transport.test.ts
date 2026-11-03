import { expect, it } from "vitest";
import { LinuxClient } from "./transport.js";
import { JS_MAILBOX_BYTES, JS_PROCESS_PROTOCOL_VERSION, LinuxError, descriptor, jsMailboxAttention, operation, Writer } from "./codec.js";
import { record, integer } from "../decode.js";
import { VMError } from "../errors.js";
import { asyncFiles } from "./files.js";
import { deliverArrival, signalBuffer, SIGNAL_BUFFER_BYTES, type SignalArrival } from "./signals.js";

it("correlates asynchronous completions and keeps Linux errno distinct from transport failures", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  channel.port2.onmessage = (event: MessageEvent<unknown>) => {
    const request = record(event.data, "request"), sequence = integer(request["sequence"], "sequence", 1);
    channel.port2.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "reply", sequence, errno: sequence === 1 ? 13 : 0, value: 0n, payload: new Uint8Array() });
  }; channel.port2.start();
  try {
    const denied = client.call(operation(4, new Writer().path("/etc/private"), () => undefined));
    const success = client.call(operation(79, new Writer(), () => "ok"));
    await expect(denied).rejects.toBeInstanceOf(LinuxError); await expect(success).resolves.toBe("ok");
    channel.port2.postMessage({ version: 999, type: "reply" });
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    await expect(client.call(operation(79, new Writer(), () => undefined))).rejects.toBeInstanceOf(VMError);
  } finally { client.dispose(); channel.port2.close(); }
});

it("cancels a pending operation through a second ordered Rust request", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES)), abort = new AbortController();
  const accepted = Promise.withResolvers<undefined>(), operations: number[] = [];
  channel.port2.onmessage = (event: MessageEvent<unknown>) => {
    const request = record(event.data, "request"), number = integer(request["operation"], "operation"); operations.push(number);
    if (number === 0) accepted.resolve(undefined);
    else {
      channel.port2.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "reply", sequence: 1, errno: 4, value: 0n, payload: new Uint8Array() });
      channel.port2.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "reply", sequence: 2, errno: 0, value: 1n, payload: new Uint8Array() });
    }
  }; channel.port2.start();
  try {
    const pending = asyncFiles(client).read(descriptor(0), 10, { signal: abort.signal });
    const result = expect(pending).rejects.toMatchObject({ errno: 4 });
    await accepted.promise; abort.abort(); await result; expect(operations).toEqual([0, 65539]);
  } finally { client.dispose(); channel.port2.close(); }
});

it("bounds pending transport promises before another request is sent", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const pending: Promise<unknown>[] = [];
  try {
    for (let index = 0; index < 544; index++) pending.push(client.call(operation(0, new Writer().u64(0).u64(1), () => undefined)).catch((error: unknown) => error));
    await expect(client.call(operation(0, new Writer().u64(0).u64(1), () => undefined))).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  } finally { client.dispose(); channel.port2.close(); await Promise.all(pending); }
});

it("backpressures a filesystem burst and reserves progress for a pipe write", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const accepted = Promise.withResolvers<undefined>(); let reads = 0;
  channel.port2.onmessage = (event: MessageEvent<unknown>) => {
    const request = record(event.data, "request"), number = integer(request["operation"], "operation"), sequence = integer(request["sequence"], "sequence");
    if (number === 0) { if (++reads === 32) accepted.resolve(undefined); }
    else channel.port2.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "reply", sequence, errno: 0, value: 1n, payload: new Uint8Array() });
  }; channel.port2.start();
  const readsPending = Array.from({ length: 40 }, () => client.call(operation(0, new Writer().u64(0).u64(1), () => undefined)).catch((error: unknown) => error));
  try {
    await accepted.promise; expect(reads).toBe(32);
    await expect(client.call(operation(1, new Writer().u64(1).blob(new Uint8Array([1])), result => result.value))).resolves.toBe(1n);
    expect(reads).toBe(32);
  } finally { client.dispose(); channel.port2.close(); await Promise.all(readsPending); }
});

it("cancels eight blocked operations with one signal without closing the transport", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  const accepted = Promise.withResolvers<undefined>(), abort = new AbortController(); let reads = 0;
  const reply = (sequence: number, errno = 0) => channel.port2.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "reply", sequence, errno, value: 0n, payload: new Uint8Array() });
  channel.port2.onmessage = (event: MessageEvent<unknown>) => {
    const request = record(event.data, "request"), number = integer(request["operation"], "operation"), sequence = integer(request["sequence"], "sequence");
    if (number === 0) { if (++reads === 8) accepted.resolve(undefined); }
    else if (number === 65539) {
      const payload = request["payload"];
      if (!(payload instanceof Uint8Array)) throw new Error("Missing cancellation target");
      reply(Number(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigUint64(0, true)), 4); reply(sequence);
    } else reply(sequence);
  }; channel.port2.start();
  try {
    const pending = Array.from({ length: 8 }, () => asyncFiles(client).read(descriptor(0), 1, { signal: abort.signal }).catch((error: unknown) => error));
    await accepted.promise; abort.abort();
    const results = await Promise.all(pending);
    expect(results.map(result => result instanceof LinuxError ? result.errno : result)).toEqual(Array.from({ length: 8 }, () => 4));
    await expect(client.call(operation(79, new Writer(), () => "usable"))).resolves.toBe("usable");
  } finally { client.dispose(); channel.port2.close(); }
});

it("counts every request on the mailbox's attention slot before posting it", async () => {
  const channel = new MessageChannel(), mailbox = new SharedArrayBuffer(JS_MAILBOX_BYTES);
  const client = new LinuxClient(channel.port1, mailbox), attention = jsMailboxAttention(mailbox);
  const seen: { version: unknown; counted: number }[] = [];
  channel.port2.onmessage = (event: MessageEvent<unknown>) => {
    const request = record(event.data, "request"), sequence = integer(request["sequence"], "sequence", 1);
    // The execution worker reads the count when its guest slice checks attention, before delivery.
    seen.push({ version: request["version"], counted: Atomics.load(attention, 0) });
    channel.port2.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "reply", sequence, errno: 0, value: 0n, payload: new Uint8Array() });
  }; channel.port2.start();
  try {
    await client.call(operation(79, new Writer(), () => undefined));
    await client.call(operation(79, new Writer(), () => undefined));
    expect(seen).toEqual([{ version: JS_PROCESS_PROTOCOL_VERSION, counted: 1 }, { version: JS_PROCESS_PROTOCOL_VERSION, counted: 2 }]);
  } finally { client.dispose(); channel.port2.close(); }
});

it("rejects a reply from a peer on the previous JS process protocol", async () => {
  const channel = new MessageChannel(), client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  channel.port2.onmessage = (event: MessageEvent<unknown>) => {
    const sequence = integer(record(event.data, "request")["sequence"], "sequence", 1);
    channel.port2.postMessage({ version: 1, type: "reply", sequence, errno: 0, value: 0n, payload: new Uint8Array() });
  }; channel.port2.start();
  try { await expect(client.call(operation(79, new Writer(), () => undefined))).rejects.toMatchObject({ code: "PROTOCOL_ERROR" }); }
  finally { client.dispose(); channel.port2.close(); }
});

/** The driver's side of the signal buffer: standard signals without details. */
function pend(words: Int32Array, ...signals: readonly number[]): void { for (const signal of signals) Atomics.or(words, 0, 1 << (signal - 1)); }
const signalSignals = (arrivals: readonly SignalArrival[]) => arrivals.map(arrival => arrival.signal);
/** Resolves once every message posted to the client before it has been delivered: the reply to a later request. */
async function settle(client: LinuxClient, peer: MessagePort): Promise<void> {
  peer.onmessage = (event: MessageEvent<unknown>) => {
    const sequence = integer(record(event.data, "request")["sequence"], "sequence", 1);
    peer.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "reply", sequence, errno: 0, value: 0n, payload: new Uint8Array() });
  };
  await client.call(operation(79, new Writer(), () => undefined));
}

it("hands each signal Rust caught to the listener exactly once, lowest first, at once and after each nudge", async () => {
  const channel = new MessageChannel(), buffer = new SharedArrayBuffer(SIGNAL_BUFFER_BYTES), words = new Int32Array(buffer);
  const client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES), buffer), delivered: number[][] = [];
  try {
    pend(words, 15);
    client.listenForSignals(arrivals => { delivered.push(signalSignals(arrivals)); });
    expect(delivered).toEqual([[15]]);
    pend(words, 10, 2, 1);
    // Two nudges for the same bits: the first takes them all, the second finds nothing to deliver.
    channel.port2.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal" });
    channel.port2.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal" });
    await settle(client, channel.port2);
    expect(delivered).toEqual([[15], [1, 2, 10]]);
    expect(Atomics.load(words, 0)).toBe(0);
    pend(words, 3);
    channel.port2.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal" });
    await settle(client, channel.port2);
    expect(delivered).toEqual([[15], [1, 2, 10], [3]]);
  } finally { client.dispose(); channel.port2.close(); }
});

it("carries real-time arrivals to the listener in order with their details (protocol 5)", async () => {
  const channel = new MessageChannel(), buffer = new SharedArrayBuffer(SIGNAL_BUFFER_BYTES), target = signalBuffer(buffer);
  const client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES), buffer), delivered: SignalArrival[][] = [];
  try {
    client.listenForSignals(arrivals => { delivered.push([...arrivals]); });
    const details = (value: bigint) => ({ code: -1, sender: 4, uid: 1000, value });
    deliverArrival(target, { signal: 36, details: details(3n) });
    deliverArrival(target, { signal: 35, details: details(1n) });
    deliverArrival(target, { signal: 2, details: null });
    channel.port2.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal" });
    await settle(client, channel.port2);
    expect(delivered).toEqual([[{ signal: 2, details: null }, { signal: 36, details: details(3n) }, { signal: 35, details: details(1n) }]]);
  } finally { client.dispose(); channel.port2.close(); }
});

it("keeps the interrupt word for the module and refuses a second listener, untrappable bits and a stale nudge", async () => {
  const channel = new MessageChannel(), buffer = new SharedArrayBuffer(SIGNAL_BUFFER_BYTES), words = new Int32Array(buffer);
  const client = new LinuxClient(channel.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES), buffer);
  try {
    // The interrupt word is the Int32 at byte 8.
    Atomics.store(words, 2, 2);
    expect(client.interruptWord[0]).toBe(2);
    client.interruptWord[0] = 0;
    expect(Atomics.load(words, 2)).toBe(0);
    client.listenForSignals(() => {});
    expect(() => { client.listenForSignals(() => {}); }).toThrow(VMError);
    // SIGKILL's bit can never be pending: the transport fails instead of inventing a delivery.
    pend(words, 9);
    channel.port2.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal" });
    await expect(settle(client, channel.port2)).rejects.toBeInstanceOf(VMError);
  } finally { client.dispose(); channel.port2.close(); }
  for (const nudge of [{ version: JS_PROCESS_PROTOCOL_VERSION - 1, type: "signal" }, { version: JS_PROCESS_PROTOCOL_VERSION, type: "signal", signal: 2 }]) {
    const stale = new MessageChannel(), other = new LinuxClient(stale.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES), new SharedArrayBuffer(SIGNAL_BUFFER_BYTES));
    try {
      stale.port2.postMessage(nudge);
      await expect(settle(other, stale.port2)).rejects.toMatchObject({ code: expect.stringMatching(/PROTOCOL_ERROR|ABORTED/u) as unknown });
    } finally { other.dispose(); stale.port2.close(); }
  }
  // A native process has no signal words, so it neither listens nor accepts a nudge.
  const native = new MessageChannel(), withoutWords = new LinuxClient(native.port1, new SharedArrayBuffer(JS_MAILBOX_BYTES));
  try {
    expect(() => { withoutWords.listenForSignals(() => {}); }).toThrow(VMError);
    expect(() => withoutWords.interruptWord).toThrow(VMError);
    native.port2.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal" });
    await expect(settle(withoutWords, native.port2)).rejects.toBeInstanceOf(VMError);
  } finally { withoutWords.dispose(); native.port2.close(); }
  expect(() => new LinuxClient(new MessageChannel().port1, new SharedArrayBuffer(JS_MAILBOX_BYTES), new SharedArrayBuffer(4))).toThrow(VMError);
});

it("reports the end of its process by a trappable signal, counted like a request", async () => {
  const channel = new MessageChannel(), mailbox = new SharedArrayBuffer(JS_MAILBOX_BYTES);
  const client = new LinuxClient(channel.port1, mailbox, new SharedArrayBuffer(SIGNAL_BUFFER_BYTES)), attention = jsMailboxAttention(mailbox);
  try {
    const received = new Promise<{ readonly data: unknown; readonly counted: number }>(resolve => { channel.port2.onmessage = (event: MessageEvent<unknown>) => { resolve({ data: event.data, counted: Atomics.load(attention, 0) }); }; });
    client.signaled(2);
    expect(await received).toEqual({ data: { version: JS_PROCESS_PROTOCOL_VERSION, type: "signaled", signal: 2 }, counted: 1 });
    // @ts-expect-error SIGKILL is not a signal a process can end itself by through its worker
    expect(() => { client.signaled(9); }).toThrow(VMError);
  } finally { client.dispose(); channel.port2.close(); }
});
