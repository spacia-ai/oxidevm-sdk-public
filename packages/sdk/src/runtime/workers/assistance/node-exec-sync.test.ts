import { Buffer } from "buffer";
import { expect, it } from "vitest";
import { createExecFileSync } from "./node-exec-sync.js";
import { createNodeExec } from "./node-exec.js";
import type { CapturedProcess, ProcessRuntimeIO } from "./process-io.js";

it("validates synchronous options before spawning and inherits the current environment", () => {
  const calls: unknown[] = [], inherited = { PATH: "/bin", VALUE: "before" };
  const capture: NonNullable<ProcessRuntimeIO["captureSync"]> = (...args) => {
    calls.push(args); return { pid: 2, status: 0, signal: null, stdout: Uint8Array.of(65, 0, 66), stderr: new Uint8Array() };
  };
  const exec = createExecFileSync(capture, inherited);
  inherited.VALUE = "after";
  expect(exec("/bin/tool", ["literal a b"], { input: "abc", windowsHide: true })).toEqual(Buffer.from([65, 0, 66]));
  expect(calls[0]).toEqual([{ kind: "spawn", command: "/bin/tool", args: ["literal a b"], cwd: ".", env: { PATH: "/bin", VALUE: "after" } }, new TextEncoder().encode("abc"), 1024 * 1024]);
  for (const option of [{ timeout: 1 }, { stdio: "inherit" }, { shell: true }, { maxBuffer: Infinity }, { maxBuffer: 0 }, { encoding: "hex" }, { input: new Uint8Array(16 * 1024 * 1024 + 1) }]) expect(() => exec("tool", [], option)).toThrow();
  expect(calls).toHaveLength(1);
});

it("preserves synchronous status, signals, bounded output and binary error properties", () => {
  const bytes = new TextEncoder().encode("output"), stderr = new TextEncoder().encode("warning");
  let result: CapturedProcess = { pid: 3, status: 2, signal: null, stdout: bytes, stderr };
  const exec = createExecFileSync(() => result, {});
  const failure = (options?: unknown): unknown => { try { exec("tool", options); throw new Error("Expected child failure"); } catch (error) { return error; } };
  expect(failure()).toMatchObject({ pid: 3, status: 2, signal: null, stdout: Buffer.from(bytes), stderr: Buffer.from(stderr) });
  result = { ...result, status: null, signal: 15, error: "ENOBUFS" };
  expect(failure({ encoding: "utf8" })).toMatchObject({ code: "ENOBUFS", errno: -105, status: null, signal: "SIGTERM", stdout: "output", stderr: "warning" });
});

it("forwards original stderr bytes before decoding execFileSync output", () => {
  const raw = Uint8Array.of(255), forwarded: Uint8Array[] = [];
  const exec = createExecFileSync(() => ({ pid: 4, status: 0, signal: null, stdout: Uint8Array.of(65), stderr: raw }), {}, bytes => { forwarded.push(bytes); });
  expect(exec("tool", [], { encoding: "utf8" })).toBe("A"); expect(forwarded).toEqual([raw]);
});

it("executes synchronous shell commands through the existing native capture owner", () => {
  const calls: unknown[] = [];
  const capture: NonNullable<ProcessRuntimeIO["captureSync"]> = (...args) => {
    calls.push(args); return { pid: 8, status: 0, signal: null, stdout: Uint8Array.of(65, 0, 66), stderr: new Uint8Array() };
  };
  const api = createNodeExec(() => { throw new Error("Asynchronous spawn must not implement execSync"); }, capture, { PATH: "/bin" });
  const command = "printf '%s' 'literal a b'; printf '%s' \"$VALUE\"";
  expect(api.execSync(command, { input: "input", cwd: "/tmp", env: { VALUE: "set" }, encoding: "utf8" })).toBe("A\0B");
  expect(calls).toEqual([[{ kind: "spawn", command: "/bin/sh", args: ["-c", command], cwd: "/tmp", env: { VALUE: "set" } }, new TextEncoder().encode("input"), 1024 * 1024]]);
});

it("uses the original shell command in errors and preserves signal-only message formatting", () => {
  const warning = new TextEncoder().encode("warning\n");
  let result: CapturedProcess = { pid: 8, status: 7, signal: null, stdout: Uint8Array.of(65), stderr: warning };
  const api = createNodeExec(() => undefined, () => result);
  expect(() => api.execSync("printf partial; exit 7")).toThrow("Command failed: printf partial; exit 7\nwarning\n");
  result = { ...result, status: null, signal: 15, stderr: new Uint8Array() };
  for (const invoke of [() => api.execSync("kill -TERM $$"), () => api.execFileSync("/bin/tool", [])]) {
    let failure: unknown;
    try { invoke(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ status: null, signal: "SIGTERM", stdout: Buffer.from([65]), stderr: Buffer.from([]) });
    expect(failure instanceof Error && failure.message.endsWith("\n")).toBe(false);
  }
});

it("suppresses parent stderr only for explicitly piped synchronous stdio", () => {
  const raw = Uint8Array.of(255), forwarded: Uint8Array[] = [], calls: unknown[] = [];
  const capture: NonNullable<ProcessRuntimeIO["captureSync"]> = (...args) => { calls.push(args); return { pid: 8, status: 0, signal: null, stdout: Uint8Array.of(65), stderr: raw }; };
  const api = createNodeExec(() => undefined, capture, {}, bytes => { forwarded.push(bytes); });
  for (const stdio of ["pipe", ["pipe", "pipe", "pipe"]]) {
    expect(api.execSync("printf A", { stdio })).toEqual(Buffer.from([65]));
    expect(api.execFileSync("tool", [], { stdio })).toEqual(Buffer.from([65]));
    expect(api.spawnSync("tool", [], { stdio })).toMatchObject({ status: 0, stderr: Buffer.from(raw) });
  }
  expect(forwarded).toEqual([]); expect(calls).toHaveLength(6);
  api.execSync("printf A"); expect(forwarded).toEqual([raw]);
});

it("rejects unqualified synchronous shell options before native effects", () => {
  let calls = 0;
  const api = createNodeExec(() => undefined, () => { calls++; return { pid: 8, status: 0, signal: null, stdout: new Uint8Array(), stderr: new Uint8Array() }; });
  for (const options of [{ timeout: 1 }, { shell: "/bin/bash" }, { stdio: "inherit" }, { stdio: ["pipe", "inherit", "pipe"] }, { maxBuffer: 0 }]) expect(() => api.execSync("true", options)).toThrow();
  expect(() => api.execSync(1)).toThrow(TypeError); expect(calls).toBe(0);
});
