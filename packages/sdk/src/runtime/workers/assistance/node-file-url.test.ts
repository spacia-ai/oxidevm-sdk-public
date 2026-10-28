import { accessSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { AssistanceOperation } from "../../protocol/assistance.js";
import { createAsyncContext } from "./async-context.js";
import { createAsyncFiles, createSyncFiles } from "./node-files.js";

it.each(["file:///workspace/package.json", "file:///workspace/a%20%23%3F%25/%CF%80", "file://localhost/workspace/a?ignored#ignored"])(
  "accepts file URL paths in synchronous, promise and callback filesystem calls: %s", async href => {
    const operations: AssistanceOperation[] = [];
    const call = (operation: AssistanceOperation) => { operations.push(operation); return { kind: "unit" } as const; };
    const sync = createSyncFiles(call, () => "/workspace");
    const async = createAsyncFiles(operation => Promise.resolve(call(operation)), () => "/workspace", createAsyncContext(), () => () => {});
    const url = new URL(href), path = fileURLToPath(url);
    sync.accessSync(url);
    await async.promises.access(url);
    const done = Promise.withResolvers<unknown>();
    async.access(url, (error: unknown) => { done.resolve(error); });
    expect(await done.promise).toBe(null);
    expect(operations).toEqual(Array.from({ length: 3 }, () => ({ kind: "access", path, mode: 0 })));
    expect(url.href).toBe(href.replace("file://localhost/", "file:///"));
  },
);

it("reads URL inputs and normalizes both rename paths without interpreting file URL strings", () => {
  const operations: AssistanceOperation[] = [];
  const fs = createSyncFiles(operation => {
    operations.push(operation);
    if (operation.kind === "open") return { kind: "opened", fd: 1 };
    if (operation.kind === "read") return { kind: "data", bytes: new Uint8Array() };
    return { kind: "unit" };
  }, () => "/workspace");
  expect(fs.readFileSync(new URL("file:///workspace/package.json"), "utf8")).toBe("");
  expect(operations[0]).toEqual({ kind: "open", path: "/workspace/package.json", flags: 0, mode: 0o666 });
  fs.renameSync(new URL("file:///workspace/a%20b"), new URL("file:///workspace/c%23d"));
  expect(operations.at(-1)).toEqual({ kind: "rename", path: "/workspace/a b", destination: "/workspace/c#d" });
  fs.accessSync("file:///workspace/literal");
  expect(operations.at(-1)).toEqual({ kind: "access", path: "file:///workspace/literal", mode: 0 });
});

it.each(["https://example.com/path", "file://remote/workspace/a", "file:///workspace/a%2Fb"])(
  "rejects invalid filesystem URLs before Linux I/O with Node's error code: %s", async href => {
    const operations: AssistanceOperation[] = [];
    const call = (operation: AssistanceOperation) => { operations.push(operation); return { kind: "unit" } as const; };
    const sync = createSyncFiles(call, () => "/workspace");
    const async = createAsyncFiles(operation => Promise.resolve(call(operation)), () => "/workspace", createAsyncContext(), () => () => {});
    const url = new URL(href);
    let expected: unknown;
    try { accessSync(url); } catch (error) { expected = error; }
    if (!(expected instanceof TypeError) || !("code" in expected)) throw new Error("Expected Node's file URL validation error");
    let actual: unknown;
    try { sync.accessSync(url); } catch (error) { actual = error; }
    expect(actual).toMatchObject({ code: expected.code });
    await expect(async.promises.access(url)).rejects.toMatchObject({ code: expected.code });
    expect(() => async.access(url, () => {})).toThrow(TypeError);
    expect(sync.existsSync(url)).toBe(false);
    expect(operations).toEqual([]);
  },
);

it("rejects NUL bytes decoded from file URLs before Linux I/O", () => {
  const fs = createSyncFiles(() => { throw new Error("Unexpected Linux I/O"); }, () => "/workspace");
  expect(() => fs.accessSync(new URL("file:///workspace/a%00b"))).toThrow(TypeError);
});
