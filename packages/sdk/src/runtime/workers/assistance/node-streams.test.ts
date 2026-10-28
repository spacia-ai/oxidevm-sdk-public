import { expect, it } from "vitest";
import { bindAsyncEvents, EventEmitter, createInputStream, createOutputStream } from "./node-streams.js";
import { createAsyncContext } from "./async-context.js";

it("lets middleware replace event methods while retaining registration context", () => {
  const context = createAsyncContext(), store = new context.AsyncLocalStorage<string>();
  const emitter = new EventEmitter(); bindAsyncEvents(emitter, context);
  for (const name of ["on", "addListener", "once", "prependListener", "prependOnceListener"]) {
    expect(Object.getOwnPropertyDescriptor(emitter, name)?.writable).toBe(true);
  }
  const on = emitter.on.bind(emitter), events: (string | symbol)[] = [], seen: (string | undefined)[] = [];
  emitter.on = (event, listener) => { events.push(event); return on(event, listener); };
  store.run("registration", () => emitter.on("data", () => { seen.push(store.getStore()); }));
  store.run("emission", () => emitter.emit("data"));
  expect(events).toEqual(["data"]); expect(seen).toEqual(["registration"]);
});

it("binds all asynchronous listener registration forms without changing plain synchronous emit", () => {
  const context = createAsyncContext(); const store = new context.AsyncLocalStorage<string>();
  const emitter = new EventEmitter(); bindAsyncEvents(emitter, context);
  const seen: (string | undefined)[] = [];
  const removed = () => { throw new Error("removed listener invoked"); };
  store.run("removed", () => emitter.prependOnceListener("event", removed));
  emitter.removeListener("event", removed);
  store.run("alias", () => emitter.addListener("event", () => { seen.push(store.getStore()); }));
  store.run("prepend", () => emitter.prependListener("event", () => { seen.push(store.getStore()); }));
  store.run("once", () => emitter.prependOnceListener("event", () => { seen.push(store.getStore()); }));
  store.run("emission", () => { emitter.emit("event"); emitter.emit("event"); });
  expect(seen).toEqual(["once", "prepend", "alias", "prepend", "alias"]);
  const plain = new EventEmitter();
  store.run("registration", () => plain.on("event", () => { seen.push(store.getStore()); }));
  store.run("synchronous", () => plain.emit("event"));
  expect(seen.at(-1)).toBe("synchronous");
});

it("keeps output pending until Linux/browser acknowledgement and preserves write callback context", async () => {
  const context = createAsyncContext();
  const store = new context.AsyncLocalStorage<string>();
  const acknowledgement = Promise.withResolvers<undefined>();
  const chunks: Uint8Array[] = [];
  const output = createOutputStream(async bytes => { chunks.push(bytes); await acknowledgement.promise; }, context);
  const completed = Promise.withResolvers<string | undefined>();
  store.run("writer", () => output.write("hello", () => completed.resolve(store.getStore())));
  expect(chunks.map(bytes => new TextDecoder().decode(bytes))).toEqual(["hello"]);
  expect(output.writableLength).toBe(5);
  store.enterWith("other");
  acknowledgement.resolve(undefined);
  await expect(completed.promise).resolves.toBe("writer");
  expect(output.writableLength).toBe(0);
  output.destroy();
});

it("holds input acknowledgement while its readable buffer is full", async () => {
  const input = createInputStream(createAsyncContext());
  let acknowledged = false;
  const pending = input.receive(new Uint8Array(65536));
  void pending.then(() => { acknowledged = true; });
  await Promise.resolve();
  expect(acknowledged).toBe(false);
  expect(input.stream.readableLength).toBe(65536);
  input.stream.resume();
  await pending;
  await input.receive(null);
  expect(input.stream.readableLength).toBe(0);
  input.stream.destroy();
});

it("retires destroyed input without retaining the process or rejecting an already admitted EOF", async () => {
  const input = createInputStream(createAsyncContext()), seen: unknown[] = [];
  input.stream.on("data", value => { seen.push(value); });
  expect(input.hasReferences).toBe(true); input.stream.destroy();
  expect(input.hasReferences).toBe(false); expect(input.closed.aborted).toBe(true);
  await expect(input.receive(null)).resolves.toBeUndefined();
  await expect(input.receive(Uint8Array.of(1))).resolves.toBeUndefined();
  await input.idle(); expect(seen).toEqual([]);
});

it("releases input backpressure when its consumer destroys the stream", async () => {
  const input = createInputStream(createAsyncContext());
  const pending = input.receive(new Uint8Array(65536));
  input.stream.destroy(); await expect(pending).resolves.toBeUndefined(); expect(input.hasReferences).toBe(false);
});

it("keeps duplicate EOF invalid while input is still open", async () => {
  const input = createInputStream(createAsyncContext());
  try {
    await input.receive(null);
    await expect(input.receive(null)).rejects.toMatchObject({ code: "ABORTED" });
    await expect(input.receive(Uint8Array.of(1))).rejects.toMatchObject({ code: "ABORTED" });
    expect(input.closed.aborted).toBe(false);
  } finally { input.stream.destroy(); }
});

it("preserves stream errors when destruction cancels input", async () => {
  const input = createInputStream(createAsyncContext()), failure = new Error("consumer failed");
  const failed = Promise.withResolvers<unknown>(); input.stream.on("error", error => failed.resolve(error));
  input.stream.destroy(failure);
  expect(input.closed.aborted).toBe(true); await expect(failed.promise).resolves.toBe(failure);
});

it("binds asynchronous data listeners while retaining once and removal semantics", async () => {
  const context = createAsyncContext(); const store = new context.AsyncLocalStorage<string>();
  const input = createInputStream(context);
  const seen: unknown[] = [];
  const listener = () => { seen.push(store.getStore()); };
  store.run("removed", () => input.stream.once("data", listener));
  input.stream.removeListener("data", listener);
  store.run("reader", () => input.stream.once("data", listener));
  store.enterWith("writer");
  await input.receive(Uint8Array.of(1));
  await input.receive(Uint8Array.of(2));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(seen).toEqual(["reader"]);
  input.stream.destroy();
});

it("delivers end failures to the registered callback in its original async context", async () => {
  const context = createAsyncContext(); const store = new context.AsyncLocalStorage<string>();
  const failure = new Error("native output failed");
  const output = createOutputStream(() => Promise.reject(failure), context);
  output.on("error", () => {});
  const result = await store.run("ending", () => new Promise(resolve => {
    output.end("body", (error: unknown) => resolve([error, store.getStore()]));
  }));
  expect(result).toEqual([failure, "ending"]);
});
it("commits synchronous stdio writes before an immediate process exit", () => {
  const chunks: string[] = [];
  const output = createOutputStream(bytes => { chunks.push(new TextDecoder().decode(bytes)); }, createAsyncContext());
  output.write("first"); output.write("second");
  expect(chunks).toEqual(["first", "second"]);
});
