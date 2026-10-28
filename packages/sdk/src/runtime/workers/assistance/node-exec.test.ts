import { describe, expect, it } from "vitest";
import { EventEmitter } from "./node-streams.js";
import { createNodeExec } from "./node-exec.js";
import { createNativeChildren } from "./node-children.js";
import { createAsyncContext } from "./async-context.js";
import { promisify } from "node:util";

function fakeSpawn(record: unknown[]) {
  return (...args: unknown[]) => {
    record.push(args);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: null, pid: 42, exitCode: null, signalCode: null, killed: false, kill: () => true });
    queueMicrotask(() => {
      child.stdout.emit("data", new TextEncoder().encode("hello "));
      child.stdout.emit("data", new TextEncoder().encode("world\n"));
      child.stderr.emit("data", new TextEncoder().encode("warn\n"));
      const argv = Array.isArray(args[1]) ? args[1] : []; child.emit("close", argv[1] === "/bin/false" ? 1 : 0, null);
    });
    return child;
  };
}

describe("child_process.exec", () => {
  it("executes a file directly with literal arguments and buffers both output streams", async () => {
    const calls: unknown[] = [];
    const api = createNodeExec(fakeSpawn(calls));
    const result = await new Promise<unknown[]>(resolve => {
      api.execFile("/bin/tool", ["a b", "$(literal)"], { cwd: "/workspace" }, (...values: unknown[]) => { resolve(values); });
    });
    expect(calls).toEqual([["/bin/tool", ["a b", "$(literal)"], { cwd: "/workspace", env: undefined }]]);
    expect(result).toEqual([null, "hello world\n", "warn\n"]);
  });

  it("delivers execFile spawn errors through the existing native child owner", async () => {
    const children = createNativeChildren({ setChildEvents() {},
      callSync: () => ({ kind: "error", errno: 2, code: "ENOENT", syscall: "spawn", path: "/missing", destination: null }),
      call: () => Promise.resolve({ kind: "unit" }),
    }, createAsyncContext(), {});
    const api = createNodeExec(children.spawn);
    const values = await new Promise<unknown[]>(resolve => { api.execFile("/missing", (...args: unknown[]) => { resolve(args); }); });
    expect(values).toMatchObject([{ code: "ENOENT", path: "/missing" }, "", ""]);
    await children.idle();
    expect(children.hasPending).toBe(false);
  });

  it("preserves stdout and stderr when promisified and rejects unsupported options before spawn", async () => {
    const calls: unknown[] = [], api = createNodeExec(fakeSpawn(calls));
    expect(await Reflect.apply(promisify(api.execFile), undefined, ["/bin/tool", undefined, { cwd: "/workspace" }])).toEqual({ stdout: "hello world\n", stderr: "warn\n" });
    expect(calls[0]).toEqual(["/bin/tool", [], { cwd: "/workspace", env: undefined }]);
    for (const options of [{ shell: true }, { timeout: 1000 }, { encoding: "buffer" }]) {
      expect(() => api.execFile("/bin/tool", [], options)).toThrow();
    }
    expect(calls).toHaveLength(1);
  });

  it("runs the command through the shell and hands the callback the buffered output", async () => {
    const record: unknown[] = [];
    const { exec } = createNodeExec(fakeSpawn(record));
    const result = await new Promise<[unknown, unknown, unknown]>(resolve => { exec("echo hi", { cwd: "/w" }, (error: unknown, stdout: unknown, stderr: unknown) => { resolve([error, stdout, stderr]); }); });
    expect(result).toEqual([null, "hello world\n", "warn\n"]);
    expect(record[0]).toEqual(["/bin/sh", ["-c", "echo hi"], { cwd: "/w", env: undefined }]);
  });

  it("reports a non-zero exit as an Error carrying the code and output, and refuses the synchronous variants", async () => {
    const { exec, execSync, spawnSync, execFileSync } = createNodeExec(fakeSpawn([]));
    const error = await new Promise<unknown>(resolve => { exec("/bin/false", (failure: unknown) => { resolve(failure); }); });
    expect(error).toMatchObject({ code: 1, cmd: "/bin/false", killed: false });
    for (const refuse of [execSync, spawnSync, execFileSync]) expect(() => refuse("x")).toThrow(/synchronous child processes are not supported/u);
  });
});
