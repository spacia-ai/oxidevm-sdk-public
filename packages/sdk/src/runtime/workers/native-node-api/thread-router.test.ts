import { expect, it } from "vitest";
import { decodeJSIdentity } from "../../js-process/codec.js";
import { NativeThreadRouter } from "./thread-router.js";
import { NATIVE_TASK_CONTROL_VERSION } from "./thread-metadata.js";

it("rejects a peer with the previous task-control version", async () => {
  const router = new NativeThreadRouter(), failure = Promise.withResolvers<unknown>();
  let control: MessagePort | undefined;
  const root = router.attach(decodeJSIdentity(1n, 1n), { kind: "main" }, port => { control = port; }, failure.resolve);
  if (control === undefined) throw new Error("Control route is absent");
  try {
    control.postMessage({ version: 2, type: "prepare" });
    expect(await failure.promise).toMatchObject({ code: "PROTOCOL_ERROR" });
  } finally { root.dispose(); control.close(); }
});

it("starts each Rust environment once and rejects replayed metadata", async () => {
  const router = new NativeThreadRouter(), root = decodeJSIdentity(1n, 1n), child = decodeJSIdentity(1n, 2n);
  let control: MessagePort | undefined, starts = 0;
  const failure = Promise.withResolvers<unknown>();
  const parent = router.attach(root, { kind: "main" }, port => { control = port; }, failure.resolve);
  const worker = router.attach(child, { kind: "thread", tid: 12, parent: root.id, stdio: [20, 21, 22] }, port => { starts++; port.close(); }, failure.resolve);
  if (control === undefined) throw new Error("Root route is absent");
  const parentControl = control;
  const send = () => { const pair = new MessageChannel(); parentControl.postMessage({ version: NATIVE_TASK_CONTROL_VERSION, type: "prepare", child: child.id, metadata: { port: pair.port1, data: {}, execArgv: [], transfers: [], autoSelectFamily: null } }, [pair.port1]); pair.port2.close(); };
  send(); send();
  expect(await failure.promise).toBeInstanceOf(Error); expect(starts).toBe(1);
  worker.dispose(); parent.dispose(); control.close();
});

it("disconnects fork IPC when Rust retires the parent environment", async () => {
  const router = new NativeThreadRouter(), root = decodeJSIdentity(1n, 1n), child = decodeJSIdentity(1n, 2n);
  let control: MessagePort | undefined;
  const begun = Promise.withResolvers<MessagePort>();
  const fail = (error: unknown): never => { throw error; };
  const parent = router.attach(root, { kind: "main" }, port => { control = port; }, fail);
  const fork = router.attach(child, { kind: "fork", parent: root.id }, (port, metadata) => { port.close(); if (metadata === null) throw new Error("Fork channel is absent"); begun.resolve(metadata.port); }, fail);
  if (control === undefined) throw new Error("Root route is absent");
  const channel = new MessageChannel();
  control.postMessage({ version: NATIVE_TASK_CONTROL_VERSION, type: "prepare", child: child.id, metadata: { port: channel.port1, data: null, execArgv: [], transfers: [], autoSelectFamily: null } }, [channel.port1]);
  const ipc = await begun.promise;
  const ended = new Promise<unknown>(resolve => { ipc.onmessage = event => { const value: unknown = event.data; resolve(value); }; ipc.start(); });
  parent.dispose(); expect(await ended).toEqual({ disconnect: true });
  fork.dispose(); ipc.close(); channel.port2.close(); control.close();
});

it("retires a fork that lost its parent before IPC bootstrap", async () => {
  const router = new NativeThreadRouter(), root = decodeJSIdentity(1n, 1n), child = decodeJSIdentity(1n, 2n);
  const failure = Promise.withResolvers<unknown>();
  const parent = router.attach(root, { kind: "main" }, port => { port.close(); }, failure.resolve);
  const fork = router.attach(child, { kind: "fork", parent: root.id }, () => { throw new Error("Unexpected fork bootstrap"); }, failure.resolve);
  parent.dispose(); expect(await failure.promise).toBeInstanceOf(Error); fork.dispose();
});
