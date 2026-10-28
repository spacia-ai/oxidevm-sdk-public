import { describe, expect, it } from "vitest";
import { createSyncFiles } from "./node-files.js";
import type { AssistanceOperation } from "../../protocol/assistance.js";

it("retains caller path spelling in Linux errors and leaves relative resolution to the guest", () => {
  const fs = createSyncFiles(operation => {
    if (operation.kind !== "rename") throw new Error("unexpected operation");
    return { kind: "error", code: "ENOENT", errno: 2, syscall: "rename", path: operation.path, destination: operation.destination };
  }, () => "/workspace");
  for (const [path, dest] of [["./missing", "next"], ["/workspace/missing", "/workspace/next"]]) {
    let failure: unknown;
    try { fs.renameSync(path, dest); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ path, dest, code: "ENOENT" });
  }
});

describe("Linux-backed synchronous filesystem adapter", () => {
  it("does not turn empty file paths into the current directory", () => {
    const operations: AssistanceOperation[] = [];
    const fs = createSyncFiles(operation => {
      operations.push(operation);
      return { kind: "path", path: "/workspace" };
    }, () => "/workspace");
    for (const [operation, syscall] of [
      [() => fs.statSync(""), "stat"],
      [() => fs.readFileSync(""), "open"],
      [() => fs.readdirSync(""), "scandir"],
      [() => fs.symlinkSync("", "link"), "symlink"],
    ] as const) {
      let failure: unknown;
      try { operation(); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "ENOENT", syscall, path: "" });
    }
    expect(operations).toEqual([]);
    expect(fs.realpathSync("")).toBe("/workspace");
    expect(operations).toEqual([{ kind: "realpath", path: "/workspace" }]);
  });

  it("rejects unsupported metadata and directory options before guest I/O", () => {
    const operations: AssistanceOperation[] = [];
    const fs = createSyncFiles(operation => { operations.push(operation); return { kind: "unit" }; }, () => "/workspace");
    expect(() => Reflect.apply(fs.statSync, fs, ["file", { bigint: true }])).toThrow(/Unsupported/);
    expect(() => Reflect.apply(fs.readdirSync, fs, ["dir", { recursive: true }])).toThrow(/Unsupported/);
    expect(() => Reflect.apply(fs.rmdirSync, fs, ["dir", { recursive: true }])).toThrow(/Unsupported/);
    expect(() => Reflect.apply(fs.readlinkSync, fs, ["link", "buffer"])).toThrow(/Unsupported/);
    expect(() => { Reflect.apply(fs.writeFileSync, fs, ["file", "data", undefined, "a"]); }).toThrow(/Unsupported/);
    expect(() => { Reflect.apply(fs.unlinkSync, fs, ["file", { force: true }]); }).toThrow(/Unsupported/);
    expect(operations).toEqual([]);
  });
  it("loops bounded writes over partial completion and closes after completion", () => {
    const operations: AssistanceOperation[] = [];
    const fs = createSyncFiles(operation => {
      operations.push(operation);
      if (operation.kind === "open") return { kind: "opened", fd: 1 };
      if (operation.kind === "write") return { kind: "written", count: Math.min(10000, operation.bytes.length) };
      return { kind: "unit" };
    }, () => "/workspace");
    fs.writeFileSync("data", new Uint8Array(70000));
    expect(operations[0]).toEqual({ kind: "open", path: "data", flags: 2, mode: 0o666 });
    const writes = operations.filter(operation => operation.kind === "write");
    expect(writes).toHaveLength(7);
    expect(writes.every(operation => operation.bytes.length <= 65536)).toBe(true);
    expect(operations.at(-1)).toEqual({ kind: "close", fd: 1 });
  });

  it("preserves Linux errors without replaying writes and still closes the descriptor", () => {
    const operations: AssistanceOperation[] = [];
    const fs = createSyncFiles(operation => {
      operations.push(operation);
      if (operation.kind === "open") return { kind: "opened", fd: 1 };
      if (operation.kind === "write") return { kind: "error", errno: 28, code: "ENOSPC", syscall: "write", path: "/workspace/data", destination: null };
      return { kind: "unit" };
    }, () => "/workspace");
    let failure: unknown;
    try { fs.writeFileSync("data", "value"); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ errno: -28, code: "ENOSPC", syscall: "write", path: "/workspace/data" });
    expect(operations.map(operation => operation.kind)).toEqual(["open", "write", "close"]);
  });

  it("reads until EOF and leaves positional reads from advancing the guest offset", () => {
    const operations: AssistanceOperation[] = [];
    let reads = 0;
    const fs = createSyncFiles(operation => {
      operations.push(operation);
      if (operation.kind === "open") return { kind: "opened", fd: 9 };
      if (operation.kind === "read") return { kind: "data", bytes: new TextEncoder().encode(reads++ === 0 ? "linux" : "") };
      return { kind: "unit" };
    }, () => "/workspace");
    expect(fs.readFileSync("entry", "utf8")).toBe("linux");
    expect(operations.map(operation => operation.kind)).toEqual(["open", "read", "read", "close"]);
    fs.readSync(9, new Uint8Array(10), 2, 5, 17);
    expect(operations.at(-1)).toEqual({ kind: "read", fd: 9, length: 5, offset: 17n });
    expect(() => fs.readFileSync("entry", "not-an-encoding")).toThrow(/encoding/);
  });

  it("preserves mode, ownership and timestamps from Linux metadata", () => {
    const fs = createSyncFiles(() => ({ kind: "stat", stat: {
      dev: 1n, ino: 2n, nlink: 1n, size: 19n, blocks: 8n,
      mode: 0o100600, uid: 1000, gid: 1000, blksize: 4096,
      atimeNs: 1000000n, mtimeNs: 2500000n, ctimeNs: 3000000n, details: null,
    } }), () => "/workspace");
    const stat = fs.statSync("file");
    if (stat === undefined) throw new Error("Missing existing file metadata");
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.uid).toBe(1000);
    expect(stat.size).toBe(19);
    expect(stat.mtimeMs).toBe(2.5);
    expect(stat.mtime.getTime()).toBe(3);
    expect(stat.isFile()).toBe(true);
    expect(stat.isDirectory()).toBe(false);
  });

  it.each([null, -123456789n, 1790106993328914800n])("retains rdev and Node date rounding with birth time %s", birthtimeNs => {
    const fs = createSyncFiles(() => ({ kind: "stat", stat: {
      dev: 1n, ino: 2n, nlink: 1n, size: 0n, blocks: 0n,
      mode: 0o020666, uid: 0, gid: 0, blksize: 4096,
      atimeNs: 1500000n, mtimeNs: -1500000n, ctimeNs: 1790106993328914800n,
      details: { rdev: 259n, birthtimeNs },
    } }), () => "/workspace");
    const stat = fs.statSync("device");
    if (stat === undefined) throw new Error("Missing existing device metadata");
    expect(stat.rdev).toBe(259);
    expect(stat.atime.getTime()).toBe(2);
    expect(stat.mtime.getTime()).toBe(-1);
    expect(stat.ctimeMs).toBe(1790106993328.9148);
    // Managed Node preserves the seconds/nanoseconds conversion's exact float.
    expect(stat.birthtimeMs).toBe(birthtimeNs === null ? 0 : birthtimeNs < 0n ? -123.45678899999996 : 1790106993328.9148);
    expect(stat.birthtime?.getTime()).toBe(birthtimeNs === null ? 0 : birthtimeNs < 0n ? -123 : 1790106993329);
    expect(stat.isCharacterDevice()).toBe(true);
  });
});

it("accepts Node file options and string descriptor writes used by TypeScript", () => {
  const calls: AssistanceOperation[] = [];
  const fs = createSyncFiles(operation => {
    calls.push(operation);
    if (operation.kind === "open") return { kind: "opened", fd: 9 };
    if (operation.kind === "write") return { kind: "written", count: operation.bytes.length };
    if (operation.kind === "read") return { kind: "data", bytes: new Uint8Array() };
    return { kind: "unit" };
  }, () => "/workspace");
  expect(fs.readFileSync("empty", { encoding: "utf8", flag: "r" })).toBe("");
  fs.writeFileSync("created", "AB", { encoding: "utf16le", flag: "wx", mode: 0o640, flush: true });
  expect(calls).toContainEqual({ kind: "open", path: "created", flags: 4, mode: 0o640 });
  expect(calls).toContainEqual({ kind: "write", fd: 9, bytes: Uint8Array.of(65, 0, 66, 0), offset: null });
  expect(calls).toContainEqual({ kind: "fsync", fd: 9 });
  expect(fs.writeSync(9, "hello", undefined, "utf8")).toBe(5);
  expect(calls.at(-1)).toEqual({ kind: "write", fd: 9, bytes: Uint8Array.of(104, 101, 108, 108, 111), offset: null });
});

it("returns undefined only for absent stat entries when TypeScript requests it", () => {
  const fs = createSyncFiles(operation => {
    if (operation.kind !== "stat") throw new Error("Unexpected operation");
    return { kind: "error", errno: operation.path === "private" ? 13 : 2, code: operation.path === "private" ? "EACCES" : "ENOENT", syscall: "stat", path: operation.path, destination: null };
  }, () => "/workspace");
  expect(fs.statSync("missing", { throwIfNoEntry: false })).toBeUndefined();
  expect(() => fs.statSync("missing")).toThrow(/ENOENT/u);
  expect(() => fs.statSync("private", { throwIfNoEntry: false })).toThrow(/EACCES/u);
});

it("delegates access flags to Linux after Node mode validation", () => {
  const operations: AssistanceOperation[] = [];
  const fs = createSyncFiles(operation => { operations.push(operation); return { kind: "unit" }; }, () => "/workspace");
  expect(fs.constants).toMatchObject({ F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 });
  fs.accessSync("./value", 6.9);
  fs.accessSync("./value", null);
  expect(operations).toEqual([{ kind: "access", path: "./value", mode: 6 }, { kind: "access", path: "./value", mode: 0 }]);
  for (const mode of [8, -1, NaN, Infinity]) expect(() => fs.accessSync("./value", mode)).toThrow(RangeError);
  expect(() => fs.accessSync("./value", "4")).toThrow(TypeError);
});
