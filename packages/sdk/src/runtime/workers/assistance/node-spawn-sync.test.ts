import { Buffer } from "buffer";
import { expect, it } from "vitest";
import { VMError } from "../../errors.js";
import { createNodeExec } from "./node-exec.js";
import type { CapturedProcess, ProcessRuntimeIO } from "./process-io.js";

type Capture = NonNullable<ProcessRuntimeIO["captureSync"]>;
const success: CapturedProcess = { pid: 3, status: 0, signal: null, stdout: Uint8Array.of(65, 0, 66), stderr: Uint8Array.of(67) };
const unused = () => { throw new Error("The asynchronous child owner must not implement spawnSync"); };

it("captures literal arguments, copied input and the current environment through the native owner", () => {
  const calls: unknown[] = [], inherited = { PATH: "/bin", VALUE: "before" }, forwarded: Uint8Array[] = [];
  const capture: Capture = (...args) => { calls.push(args); return success; };
  const api = createNodeExec(unused, capture, inherited, bytes => { forwarded.push(bytes); }); inherited.VALUE = "after";
  const result = api.spawnSync("/bin/tool", ["a b", "$(literal)"], { input: "input", cwd: "/workspace", maxBuffer: 7 });
  expect(result).toEqual({
    pid: 3, status: 0, signal: null, output: [null, Buffer.from([65, 0, 66]), Buffer.from([67])], stdout: Buffer.from([65, 0, 66]), stderr: Buffer.from([67]),
  });
  expect(Object.keys(result)).toEqual(["status", "signal", "output", "pid", "stdout", "stderr"]);
  expect(calls).toEqual([[{ kind: "spawn", command: "/bin/tool", args: ["a b", "$(literal)"], cwd: "/workspace", env: inherited }, new TextEncoder().encode("input"), 7]]);
  expect(forwarded).toEqual([]);
});

it("returns nonzero exits and signals with encoded output instead of throwing", () => {
  let result: CapturedProcess = { ...success, status: 7 };
  const api = createNodeExec(unused, () => result);
  expect(api.spawnSync("tool", { encoding: "utf8" })).toEqual({ pid: 3, status: 7, signal: null, output: [null, "A\0B", "C"], stdout: "A\0B", stderr: "C" });
  result = { ...success, status: null, signal: 15 };
  expect(api.spawnSync("tool", [], { encoding: "utf-8" })).toMatchObject({ pid: 3, status: null, signal: "SIGTERM", stdout: "A\0B", stderr: "C" });
});

it("returns Linux spawn and capture-limit errors while preserving transport failures", () => {
  const missing = Object.assign(new Error("ENOENT: spawn"), { errno: -2, code: "ENOENT", syscall: "spawn" });
  const result = createNodeExec(unused, () => { throw missing; }).spawnSync("/missing", ["literal"]);
  expect(result).toMatchObject({
    pid: 0, status: null, signal: null, output: null, stdout: undefined, stderr: undefined,
    error: { message: "spawnSync /missing ENOENT", errno: -2, code: "ENOENT", syscall: "spawnSync /missing", path: "/missing", spawnargs: ["literal"] },
  });
  expect(Object.keys(result)).toEqual(["error", "status", "signal", "output", "pid", "stdout", "stderr"]);
  expect(createNodeExec(unused, () => ({ ...success, status: null, signal: 15, error: "ENOBUFS" })).spawnSync("tool")).toMatchObject({
    pid: 3, status: null, signal: "SIGTERM", stdout: Buffer.from([65, 0, 66]), error: { errno: -105, code: "ENOBUFS", syscall: "spawnSync tool" },
  });
  const failed = new VMError("PROTOCOL_ERROR", "retired transport");
  expect(() => createNodeExec(unused, () => { throw failed; }).spawnSync("tool")).toThrow(failed);
});

it("rejects unqualified options and invalid values before effects and keeps missing transports explicit", () => {
  let calls = 0; const api = createNodeExec(unused, () => { calls++; return success; });
  for (const options of [{ timeout: 1 }, { shell: true }, { stdio: "inherit" }, { encoding: "hex" }, { maxBuffer: Infinity }, { maxBuffer: 0 }, { windowsHide: 1 }]) {
    expect(() => api.spawnSync("tool", [], options)).toThrow();
  }
  expect(() => api.spawnSync("tool", [null])).toThrow(TypeError); expect(calls).toBe(0);
  expect(() => createNodeExec(unused).spawnSync("tool")).toThrow(/synchronous child processes are not supported/u);
});
