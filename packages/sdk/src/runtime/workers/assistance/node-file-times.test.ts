import { describe, expect, it } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createFileOperations } from "./node-file-operations.js";
import { createAsyncFiles, createSyncFiles } from "./node-files.js";
import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";

function thrown(work: () => unknown): unknown {
  try { work(); } catch (error) { return error; }
  throw new Error("Expected a failure");
}
function recording(reply: (operation: AssistanceOperation) => AssistanceResult = () => ({ kind: "unit" })) {
  const operations: AssistanceOperation[] = [];
  const call = (operation: AssistanceOperation): AssistanceResult => { operations.push(operation); return reply(operation); };
  return { operations, sync: createSyncFiles(call, () => "/workspace"),
    asynchronous: createAsyncFiles(operation => Promise.resolve(call(operation)), () => "/workspace", createAsyncContext(), () => () => {}) };
}

// Each expectation below was read from Node 24.18 on Linux (`fs.utimesSync` followed by `lstatSync(…, { bigint: true })`).
describe("node:fs file times", () => {
  it("converts seconds as Node and libuv do: truncated nanoseconds, numeric strings, dates", () => {
    const operations = createFileOperations(() => "/", false);
    const time = (value: unknown) => {
      const operation = operations.utimes("/file", value, value).next().value;
      if (operation?.kind !== "utime") throw new Error("Expected a utime operation");
      expect(operation.mtime).toBe(operation.atime);
      return operation.atime;
    };
    expect(time(1.123456789)).toBe(1_123_456_789n);
    // The double nearest 1700000000.123 lies below it; libuv truncates, so does this.
    expect(time(1700000000.123)).toBe(1_700_000_000_122_999_906n);
    expect(time(new Date(1_700_000_000_123))).toBe(1_700_000_000_122_999_906n);
    expect(time(0)).toBe(0n);
    expect(time(0.9999999)).toBe(999_999_900n);
    expect(time(1e10)).toBe(10_000_000_000_000_000_000n);
    expect(time("1.5")).toBe(1_500_000_000n);
    expect(time("")).toBe(0n);
    expect(time(" 12 ")).toBe(12_000_000_000n);
    expect(time("0x10")).toBe(16_000_000_000n);
    // Only a negative number means "now"; a negative string or date is a time before the epoch.
    expect(time(-1.5)).toBe("now");
    expect(time("-1.5")).toBe(-1_500_000_000n);
    expect(time(new Date(-1500))).toBe(-1_500_000_000n);
    // libuv: an infinite time is UTIME_NOW and a NaN one UTIME_OMIT; only these spellings reach it.
    expect(time("Infinity")).toBe("now");
    expect(time("-Infinity")).toBe("now");
    expect(time(new Date(Number.NaN))).toBe("omit");
  });

  it("refuses every other time with ERR_INVALID_ARG_TYPE before anything is sent", () => {
    const { operations, sync } = recording();
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1n, null, undefined, {}, true, [5], "abc", "NaN"]) {
      expect(thrown(() => { sync.utimesSync("/file", value, 1); })).toMatchObject({ name: "TypeError", code: "ERR_INVALID_ARG_TYPE" });
      expect(thrown(() => { sync.lutimesSync("/file", 1, value); })).toMatchObject({ name: "TypeError", code: "ERR_INVALID_ARG_TYPE" });
      expect(thrown(() => { sync.futimesSync(3, value, 1); })).toMatchObject({ name: "TypeError", code: "ERR_INVALID_ARG_TYPE" });
    }
    expect(thrown(() => Reflect.apply(sync.utimesSync, sync, ["/file"]))).toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
    expect(thrown(() => { sync.futimesSync(3, "x", 1); })).toMatchObject({ message: expect.stringContaining("\"atime\"") as unknown });
    expect(thrown(() => { sync.futimesSync(3, 1, {}); })).toMatchObject({ message: expect.stringContaining("\"mtime\"") as unknown });
    expect(thrown(() => { sync.utimesSync(5, 1, 1); })).toBeInstanceOf(TypeError);
    expect(thrown(() => { sync.futimesSync("3", 1, 1); })).toBeInstanceOf(RangeError);
    expect(thrown(() => { sync.futimesSync(-1, 1, 1); })).toBeInstanceOf(RangeError);
    // Seconds beyond a signed 64-bit word: Linux answers EINVAL to Node, so this does without asking.
    expect(thrown(() => { sync.utimesSync("/file", 2 ** 64, 1); })).toMatchObject({ code: "EINVAL", errno: -22, syscall: "utime", path: "/file" });
    expect(thrown(() => { sync.futimesSync(3, 1, "-1e19"); })).toMatchObject({ code: "EINVAL", errno: -22, syscall: "futime" });
    expect(operations).toEqual([]);
  });

  it("sends the path form, the link form and the descriptor form as their own operations", () => {
    const { operations, sync } = recording();
    sync.utimesSync("./file", 1.5, new Date(2000));
    sync.lutimesSync("link", 5.000001, 6.5);
    sync.futimesSync(7, 7.25, -1);
    expect(operations).toEqual([
      { kind: "utime", path: "./file", atime: 1_500_000_000n, mtime: 2_000_000_000n },
      { kind: "lutime", path: "link", atime: 5_000_001_000n, mtime: 6_500_000_000n },
      { kind: "futime", fd: 7, atime: 7_250_000_000n, mtime: "now" },
    ]);
  });

  it("names Linux failures by Node's syscall names and keeps the caller's path", () => {
    const { sync } = recording(operation => ({ kind: "error", code: operation.kind === "futime" ? "EBADF" : "ENOENT", errno: operation.kind === "futime" ? 9 : 2,
      syscall: operation.kind, path: "path" in operation ? operation.path : null, destination: null }));
    expect(thrown(() => { sync.utimesSync("nope", 1, 1); })).toMatchObject({ code: "ENOENT", errno: -2, syscall: "utime", path: "nope" });
    expect(thrown(() => { sync.lutimesSync("nope", 1, 1); })).toMatchObject({ code: "ENOENT", errno: -2, syscall: "lutime", path: "nope" });
    expect(thrown(() => { sync.futimesSync(999, 1, 1); })).toMatchObject({ code: "EBADF", errno: -9, syscall: "futime" });
    expect(thrown(() => { sync.utimesSync("", 1, 1); })).toMatchObject({ code: "ENOENT", syscall: "utime", path: "" });
  });

  it("offers the callback forms: argument errors throw at once, Linux failures reach the callback", async () => {
    const { operations, asynchronous } = recording(operation => operation.kind === "lutime"
      ? { kind: "error", code: "ENOENT", errno: 2, syscall: "lutime", path: operation.path, destination: null } : { kind: "unit" });
    expect(thrown(() => { asynchronous.utimes("/file", "x", 1, () => {}); })).toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
    expect(thrown(() => Reflect.apply(asynchronous.futimes, asynchronous, [3, 1, 1]))).toBeInstanceOf(TypeError);
    const results: unknown[][] = [];
    for (const start of [
      (done: (...values: unknown[]) => void) => { asynchronous.utimes("/file", 1, 2, done); },
      (done: (...values: unknown[]) => void) => { asynchronous.futimes(4, 3, 4, done); },
      (done: (...values: unknown[]) => void) => { asynchronous.lutimes("gone", 5, 6, done); },
    ]) results.push(await new Promise<unknown[]>(resolve => { start((...values) => { resolve(values); }); }));
    expect(results[0]).toEqual([null]);
    expect(results[1]).toEqual([null]);
    expect(results[2]).toEqual([expect.objectContaining({ code: "ENOENT", syscall: "lutime", path: "gone" })]);
    expect(operations.map(operation => operation.kind)).toEqual(["utime", "futime", "lutime"]);
  });

  it("offers fs.promises.utimes and lutimes and FileHandle.utimes, and no promise futimes, as Node", async () => {
    const { operations, asynchronous } = recording(operation => operation.kind === "open" ? { kind: "opened", fd: 9 } : { kind: "unit" });
    await expect(asynchronous.promises.utimes("/file", 1, 2)).resolves.toBeUndefined();
    await expect(asynchronous.promises.lutimes("/link", new Date(3000), "4")).resolves.toBeUndefined();
    await expect(asynchronous.promises.utimes("/file", "x", 2)).rejects.toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
    const handle = await asynchronous.promises.open("/file", "r+");
    await expect(handle.utimes(9.5, 10.5)).resolves.toBeUndefined();
    await expect(handle.utimes("x", 1)).rejects.toMatchObject({ code: "ERR_INVALID_ARG_TYPE", message: expect.stringContaining("\"atime\"") as unknown });
    expect(Reflect.get(asynchronous.promises, "futimes")).toBeUndefined();
    expect(operations.filter(operation => operation.kind !== "open")).toEqual([
      { kind: "utime", path: "/file", atime: 1_000_000_000n, mtime: 2_000_000_000n },
      { kind: "lutime", path: "/link", atime: 3_000_000_000n, mtime: 4_000_000_000n },
      { kind: "futime", fd: 9, atime: 9_500_000_000n, mtime: 10_500_000_000n },
    ]);
  });
});
