import { expect, it } from "vitest";
import { createAsyncContext } from "../assistance/async-context.js";
import { createNodePorts } from "./message-port.js";

it("receives posted values synchronously before platform events and emits each remaining value once", async () => {
  const tasks: (() => void)[] = [], scheduled = Promise.withResolvers<undefined>(), ports = createNodePorts(createAsyncContext(), callback => { tasks.push(callback); scheduled.resolve(undefined); }, () => {});
  const pair = new ports.MessageChannel(), delivered: unknown[] = [];
  try {
    expect(ports.receiveMessageOnPort(pair.port2)).toBeUndefined();
    pair.port1.postMessage({ value: 1 }); pair.port1.postMessage(undefined); pair.port1.postMessage("event");
    expect(ports.receiveMessageOnPort(pair.port2)).toEqual({ message: { value: 1 } });
    expect(ports.receiveMessageOnPort(pair.port2)).toEqual({ message: undefined });
    pair.port2.on("message", value => { delivered.push(value); });
    await scheduled.promise;
    for (const task of tasks.splice(0)) task();
    expect(delivered).toEqual(["event"]);
    expect(ports.receiveMessageOnPort(pair.port2)).toBeUndefined();
    expect(() => ports.receiveMessageOnPort({})).toThrow(/MessagePort/u);
  } finally { ports.dispose(); }
});

it("keeps a transferred port's synchronous inbox and cloned graph identity", () => {
  const ports = createNodePorts(createAsyncContext(), callback => queueMicrotask(callback), () => {});
  const pair = new ports.MessageChannel();
  try {
    const cloned = ports.clone({ port: pair.port2 }, [pair.port2]), value: unknown = ports.receive(cloned.value);
    if (typeof value !== "object" || value === null) throw new Error("Missing transferred value");
    const port: unknown = Reflect.get(value, "port");
    if (!(port instanceof ports.MessagePort)) throw new Error("Missing transferred port");
    const buffer = new ArrayBuffer(16), bytes = new Uint8Array(buffer, 4, 4); bytes.set([1, 2, 3, 4]);
    const graph: { self?: unknown; map: Map<unknown, unknown>; date: Date; error: Error; bytes: Uint8Array; view: DataView } = {
      map: new Map([[1n, new Set([NaN, -Infinity, undefined])]]), date: new Date(123), error: new TypeError("fixture", { cause: "cause" }), bytes, view: new DataView(buffer, 2, 8),
    }; graph.self = graph;
    pair.port1.postMessage(graph);
    const message = ports.receiveMessageOnPort(port)?.message;
    expect(message).toEqual(graph);
    if (typeof message !== "object" || message === null) throw new Error("Missing synchronous value");
    expect(Reflect.get(message, "self")).toBe(message);
    const first: unknown = Reflect.get(message, "bytes"), second: unknown = Reflect.get(message, "view");
    if (!(first instanceof Uint8Array) || !(second instanceof DataView)) throw new Error("Missing views");
    expect(first.buffer).toBe(second.buffer);
  } finally { ports.dispose(); }
});

it("preserves cyclic values, port transfer, detachment and Node message listeners", async () => {
  const ports = createNodePorts(createAsyncContext(), callback => queueMicrotask(callback), () => undefined);
  const pair = new ports.MessageChannel(), transferred = new ports.MessageChannel();
  const input: { self?: unknown; port: unknown; bytes: ArrayBuffer } = { port: transferred.port1, bytes: new ArrayBuffer(8) }; input.self = input;
  const received = new Promise<unknown>(resolve => { pair.port2.once("message", resolve); });
  pair.port1.postMessage(input, [transferred.port1, input.bytes]);
  expect(input.bytes.byteLength).toBe(0);
  const value = await received;
  if (typeof value !== "object" || value === null) throw new Error("Missing message");
  expect(Reflect.get(value, "self")).toBe(value);
  const port: unknown = Reflect.get(value, "port");
  if (!(port instanceof ports.MessagePort)) throw new Error("Missing transferred port");
  const reply = new Promise(resolve => transferred.port2.once("message", resolve));
  port.postMessage("reply"); expect(await reply).toBe("reply");
  port.close(); pair.port1.close(); pair.port2.close(); transferred.port2.close();
});

it("rejects transfer of a used endpoint before detaching it", async () => {
  const ports = createNodePorts(createAsyncContext(), callback => queueMicrotask(callback), () => {});
  const pair = new ports.MessageChannel();
  try {
    const before = new Promise(resolve => { pair.port2.once("message", resolve); });
    pair.port1.postMessage("before"); expect(await before).toBe("before");
    expect(() => ports.clone({ port: pair.port2 }, [pair.port2])).toThrow(/used MessagePort/u);
    const after = new Promise(resolve => { pair.port2.once("message", resolve); });
    pair.port1.postMessage("after"); expect(await after).toBe("after");
  } finally { ports.dispose(); }
});

it("accounts complete backing buffers once and includes property names", () => {
  const ports = createNodePorts(createAsyncContext(), callback => callback(), () => {});
  const buffer = new ArrayBuffer(1024 * 1024), view = new Uint8Array(buffer, 0, 1);
  try {
    expect(() => ports.clone(view, [], 1024)).toThrow(/unacknowledged bytes/u);
    expect(ports.clone([view, new DataView(buffer)], [], buffer.byteLength + 1024).bytes).toBeGreaterThanOrEqual(buffer.byteLength);
    expect(ports.clone([view, new DataView(buffer)], [], buffer.byteLength + 1024).bytes).toBeLessThan(buffer.byteLength + 1024);
    expect(() => ports.clone({ ["k".repeat(1024)]: 0 }, [], 100)).toThrow(/unacknowledged bytes/u);
    expect(() => ports.clone(new Uint8Array(new ArrayBuffer(64 * 1024 * 1024 + 1), 0, 1))).toThrow(/byte limit/u);
  } finally { ports.dispose(); }
});

it("counts Error messages and causes before crossing the worker boundary", () => {
  const ports = createNodePorts(createAsyncContext(), callback => callback(), () => {});
  try { expect(() => ports.clone(new Error("x".repeat(1024)), [], 100)).toThrow(/unacknowledged bytes/u); }
  finally { ports.dispose(); }
});

it("rejects incoming frames that underreport their cloned backing bytes", async () => {
  const ports = createNodePorts(createAsyncContext(), callback => queueMicrotask(callback), () => {}), channel = new MessageChannel();
  try {
    const receiver = ports.wrap(channel.port1), error = new Promise(resolve => { receiver.once("messageerror", resolve); });
    channel.port2.postMessage({ version: 2, type: "message", sequence: 1, bytes: 8, value: { version: 1, value: new Uint8Array(new ArrayBuffer(1024), 0, 1), inboxes: [] } });
    expect(await error).toMatchObject({ code: "PROTOCOL_ERROR", message: "Worker message underreports cloned bytes" });
  } finally { ports.dispose(); channel.port2.close(); }
});
