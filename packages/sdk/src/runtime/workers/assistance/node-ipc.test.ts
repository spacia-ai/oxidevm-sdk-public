import { expect, it, vi } from "vitest";
import { createIpcChannel, IPC_WINDOW_BYTES } from "./node-ipc.ts";
import { createAsyncContext } from "./async-context.ts";

function pair() {
  const { port1, port2 } = new MessageChannel();
  const deliveries: (() => void)[] = [];
  const deliver = (callback: () => void) => { deliveries.push(callback); };
  const left = { messages: [] as unknown[], disconnected: 0 };
  const right = { messages: [] as unknown[], disconnected: 0 };
  const context = createAsyncContext();
  const parent = createIpcChannel(port1, { context, deliver, onMessage: value => { left.messages.push(value); }, onDisconnect: () => { left.disconnected += 1; } });
  const child = createIpcChannel(port2, { context, deliver, onMessage: value => { right.messages.push(value); }, onDisconnect: () => { right.disconnected += 1; } });
  const flush = async () => { for (let round = 0; round < 8; round += 1) { await new Promise(resolve => setTimeout(resolve, 0)); deliveries.splice(0).forEach(callback => callback()); } };
  return { parent, child, left, right, flush };
}

it("delivers JSON messages in order and credits the sender only through acknowledgements", async () => {
  const { parent, child, left, right, flush } = pair();
  try {
    expect(parent.send({ cmd: 1 })).toBe(true);
    expect(parent.send("two")).toBe(true);
    expect(parent.send(null)).toBe(true);
    await flush();
    expect(right.messages).toEqual([{ cmd: 1 }, "two", null]);
    expect(child.send({ back: true })).toBe(true);
    await flush();
    expect(left.messages).toEqual([{ back: true }]);
    // A burst beyond the window is queued, not dropped: send reports the backlog.
    const big = "x".repeat(IPC_WINDOW_BYTES / 2 - 8);
    expect(parent.send(big)).toBe(true);
    expect(parent.send(big)).toBe(true);
    const callback = vi.fn();
    expect(parent.send(big, callback)).toBe(false);
    expect(callback).not.toHaveBeenCalled();
    await flush();
    expect(right.messages).toHaveLength(6);
    expect(callback).toHaveBeenCalledWith(null);
    expect(() => parent.send(undefined)).toThrow(TypeError);
    expect(() => parent.send(() => 1)).toThrow(TypeError);
  } finally { parent.disconnect(); child.disconnect(); }
});

it("keeps the process alive only while connected and listened to, and disconnects both ends", async () => {
  const { parent, child, left, right, flush } = pair();
  expect(parent.connected).toBe(true);
  expect(parent.hasReferences).toBe(false);
  parent.setListeners(1);
  expect(parent.hasReferences).toBe(true);
  parent.unref();
  expect(parent.hasReferences).toBe(false);
  parent.ref();
  expect(parent.hasReferences).toBe(true);
  child.disconnect();
  expect(child.connected).toBe(false);
  await flush();
  expect(parent.connected).toBe(false);
  expect(parent.hasReferences).toBe(false);
  expect(left.disconnected).toBe(1);
  expect(right.disconnected).toBe(1);
  const callback = vi.fn();
  expect(parent.send("late", callback)).toBe(false);
  await flush();
  expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: "ERR_IPC_CHANNEL_CLOSED" }));
  let thrown: unknown;
  try { parent.send("late"); } catch (error) { thrown = error; }
  expect(thrown).toMatchObject({ code: "ERR_IPC_CHANNEL_CLOSED" });
  parent.disconnect();
  expect(left.disconnected).toBe(1);
});

it("treats a malformed frame as a broken channel", async () => {
  const { port1, port2 } = new MessageChannel();
  const deliveries: (() => void)[] = [];
  let disconnected = 0;
  const channel = createIpcChannel(port1, { context: createAsyncContext(), deliver: callback => { deliveries.push(callback); }, onMessage: () => {}, onDisconnect: () => { disconnected += 1; } });
  port2.postMessage({ message: "{not json" });
  await new Promise(resolve => setTimeout(resolve, 10));
  deliveries.splice(0).forEach(callback => callback());
  expect(channel.connected).toBe(false);
  expect(disconnected).toBe(1);
  port2.close();
});

it("retains an outgoing message until peer acknowledgement and completes its callback once", async () => {
  const pair = new MessageChannel(), callbacks: (() => void)[] = [], done = vi.fn();
  const delivered = Promise.withResolvers<undefined>();
  const channel = createIpcChannel(pair.port1, { context: createAsyncContext(), deliver: callback => { callbacks.push(callback); delivered.resolve(undefined); }, onMessage() {}, onDisconnect() {} });
  try {
    channel.send("hello", done); callbacks.splice(0).forEach(callback => callback());
    expect(done).not.toHaveBeenCalled(); expect(channel.hasReferences).toBe(true);
    const received = new Promise<void>(resolve => { pair.port2.onmessage = () => { pair.port2.postMessage({ ack: 7 }); resolve(); }; pair.port2.start(); });
    await received; await delivered.promise; callbacks.splice(0).forEach(callback => callback());
    expect(done).toHaveBeenCalledExactlyOnceWith(null); expect(channel.hasReferences).toBe(false);
  } finally { channel.disconnect(); pair.port2.close(); }
});
