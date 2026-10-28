import { expect, it } from "vitest";
import { createAsyncFiles, createSyncFiles } from "./node-files.js";
import { createAsyncContext } from "./async-context.js";
import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";

it("throws callback argument errors synchronously but delivers filesystem failures asynchronously", async () => {
  let dispatched = 0; let retained = 0;
  const fs = createAsyncFiles(() => { dispatched += 1; return Promise.resolve({ kind: "unit" }); },
    () => "/workspace", createAsyncContext(), () => { retained += 1; return () => { retained -= 1; }; });
  const seen: string[] = [];
  for (const [method, args] of [[fs.stat, [null]], [fs.open, [null, "r"]], [fs.readFile, [null]], [fs.writeFile, [null, "x"]]] as const) {
    expect(() => Reflect.apply(method, fs, [...args, () => { seen.push("unexpected callback"); }])).toThrow(TypeError);
  }
  const completion = Promise.withResolvers<unknown>();
  fs.stat("", (error: unknown) => { seen.push("callback"); completion.resolve(error); });
  seen.push("returned");
  expect(await completion.promise).toMatchObject({ code: "ENOENT" });
  expect(seen).toEqual(["returned", "callback"]);
  expect(dispatched).toBe(0);
  expect(retained).toBe(0);
});

it("uses asynchronous Linux completion and retains the callback registration context", async () => {
  const context = createAsyncContext();
  const store = new context.AsyncLocalStorage<string>();
  const opened = Promise.withResolvers<AssistanceResult>();
  const operations: AssistanceOperation[] = [];
  const fs = createAsyncFiles(operation => { operations.push(operation); return opened.promise; }, () => "/workspace", context, () => () => {});
  const completed = Promise.withResolvers<unknown[]>();
  store.run("request-a", () => fs.open("file", "r", (error: unknown, fd: unknown) => {
    completed.resolve([error, fd, store.getStore()]);
  }));
  expect(operations).toEqual([{ kind: "open", path: "file", flags: 0, mode: 0o666 }]);
  store.enterWith("request-b");
  opened.resolve({ kind: "opened", fd: 7 });
  expect(await completed.promise).toEqual([null, 7, "request-a"]);
});

it("preserves a failed asynchronous write over a failed close and never replays it", async () => {
  const operations: AssistanceOperation[] = [];
  const fs = createAsyncFiles(operation => {
    operations.push(operation);
    if (operation.kind === "open") return Promise.resolve({ kind: "opened", fd: 1 });
    return Promise.resolve({ kind: "error", errno: operation.kind === "write" ? 28 : 5,
      code: operation.kind === "write" ? "ENOSPC" : "EIO", syscall: operation.kind, path: null, destination: null });
  }, () => "/workspace", createAsyncContext(), () => () => {});
  await expect(fs.promises.writeFile("file", "data")).rejects.toMatchObject({ code: "ENOSPC", syscall: "write" });
  expect(operations.map(operation => operation.kind)).toEqual(["open", "write", "close"]);
});

it("retains FileHandle identity, loops partial writes, and closes it exactly once", async () => {
  const operations: AssistanceOperation[] = [];
  const fs = createAsyncFiles(operation => {
    operations.push(operation);
    if (operation.kind === "open") return Promise.resolve({ kind: "opened", fd: 9 });
    if (operation.kind === "write") return Promise.resolve({ kind: "written", count: Math.min(2, operation.bytes.length) });
    return Promise.resolve({ kind: "unit" });
  }, () => "/workspace", createAsyncContext(), () => () => {});
  const handle = await fs.promises.open("file", "w");
  await handle.writeFile("hello");
  const first = handle.close();
  expect(handle.close()).toBe(first);
  await first;
  expect(handle.fd).toBe(-1);
  await expect(handle.writeFile("later")).rejects.toMatchObject({ code: "EBADF" });
  expect(operations.map(operation => operation.kind)).toEqual(["open", "write", "write", "write", "close"]);
});

it("rejects extra FileHandle arguments before dispatching Linux operations", async () => {
  const operations: AssistanceOperation[] = [];
  const fs = createAsyncFiles(operation => {
    operations.push(operation);
    return Promise.resolve(operation.kind === "open" ? { kind: "opened", fd: 9 } : { kind: "unit" });
  }, () => "/workspace", createAsyncContext(), () => () => {});
  const handle = await fs.promises.open("file", "w");
  for (const [method, args] of [
    [handle.sync, ["unsupported"]], [handle.writeFile, ["data", "utf8", "ignored"]],
    [handle.chmod, [0o600, "ignored"]], [handle.close.bind(handle), ["ignored"]],
  ] as const) {
    await expect(Reflect.apply(method, handle, args)).rejects.toThrow(TypeError);
  }
  expect(operations.map(operation => operation.kind)).toEqual(["open"]);
  await handle.close();
});

it("delivers native access errors and preserves callback context and constants identity", async () => {
  const context = createAsyncContext();
  const storage = new context.AsyncLocalStorage<string>();
  const operations: AssistanceOperation[] = [];
  const fs = createAsyncFiles(operation => {
    operations.push(operation);
    return Promise.resolve(operation.kind === "access" && operation.path === "denied"
      ? { kind: "error", errno: 13, code: "EACCES", syscall: "access", path: "denied", destination: null }
      : { kind: "unit" });
  }, () => "/workspace", context, () => () => {});
  const sync = createSyncFiles(() => ({ kind: "unit" }), () => "/workspace");
  expect(fs.promises.constants).toBe(sync.constants);
  await expect(fs.promises.access("denied", fs.promises.constants.W_OK)).rejects.toMatchObject({ code: "EACCES", path: "denied", syscall: "access" });
  const done = Promise.withResolvers<unknown[]>();
  storage.run("access", () => fs.access("value", (...args: unknown[]) => { done.resolve([...args, storage.getStore()]); }));
  expect(await done.promise).toEqual([null, "access"]);
  expect(operations).toEqual([{ kind: "access", path: "denied", mode: 2 }, { kind: "access", path: "value", mode: 0 }]);
});
