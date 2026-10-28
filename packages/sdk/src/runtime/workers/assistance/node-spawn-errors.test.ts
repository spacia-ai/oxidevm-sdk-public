import { expect, it } from "vitest";
import { VMError } from "../../errors.js";
import { createNodeExec } from "./node-exec.js";

const unused = () => { throw new Error("Asynchronous spawn must not handle synchronous launch failures"); };
const failures = [
  { code: "ENOENT", errno: -2, detail: "no such file or directory" },
  { code: "EACCES", errno: -13, detail: "permission denied" },
  { code: "ENOTDIR", errno: -20, detail: "not a directory" },
  { code: "ELOOP", errno: -40, detail: "too many symbolic links encountered" },
];
function thrown(invoke: () => unknown): unknown { try { invoke(); return undefined; } catch (error) { return error; } }

it.each(failures)("preserves Node $code launch fields and execFileSync's self-reference", ({ code, errno }) => {
  const native = Object.assign(new Error(`${code}: spawn`), { errno, code, syscall: "spawn" });
  const api = createNodeExec(unused, () => { throw native; });
  const expected = { message: `spawnSync ./tool ${code}`, errno, code, syscall: "spawnSync ./tool", path: "./tool", spawnargs: ["literal a b"] };
  const result = api.spawnSync("./tool", ["literal a b"]);
  expect(result).toMatchObject({ error: expected, pid: 0, status: null, signal: null, output: null, stdout: undefined, stderr: undefined });
  const failure = thrown(() => api.execFileSync("./tool", ["literal a b"]));
  expect(failure).toMatchObject({ ...expected, pid: 0, status: null, signal: null, output: null, stdout: undefined, stderr: undefined });
  if (!(failure instanceof Error)) throw new Error("Missing launch exception");
  const self: unknown = Reflect.get(failure, "error"); expect(self).toBe(failure);
  expect(Object.keys(failure).sort()).toEqual(["code", "errno", "error", "output", "path", "pid", "signal", "spawnargs", "status", "stderr", "stdout", "syscall"]);
});

it.each(failures)("retains Bun $code messages, undefined identity fields and null streams", ({ code, errno, detail }) => {
  const native = Object.assign(new Error(`${code}: spawn`), { errno, code, syscall: "spawn" });
  const api = createNodeExec(unused, () => { throw native; }, {}, undefined, "bun");
  const expected = { message: `${code}: ${detail}, posix_spawn './tool'`, errno, code, syscall: "spawnSync ./tool", path: "./tool", spawnargs: ["literal a b"] };
  const result = api.spawnSync("./tool", ["literal a b"]);
  expect(result).toMatchObject({ error: expected, pid: undefined, status: undefined, signal: null, output: [null, null, null], stdout: null, stderr: null });
  const failure = thrown(() => api.execFileSync("./tool", ["literal a b"]));
  expect(failure).toMatchObject({ ...expected, pid: undefined, status: undefined, signal: null, output: [null, null, null], stdout: null, stderr: null });
  if (!(failure instanceof Error)) throw new Error("Missing launch exception");
  const self: unknown = Reflect.get(failure, "error"); expect(self).toBeUndefined();
  expect(Object.keys(failure).sort()).toEqual(["code", "errno", "output", "path", "pid", "signal", "spawnargs", "status", "stderr", "stdout", "syscall"]);
});

it("distinguishes a Rust PATH miss from a failed Bun launch with the same errno and filename", () => {
  for (const [syscall, message] of [["spawn-path-search", 'Executable not found in $PATH: "tool"'], ["spawn", "ENOENT: no such file or directory, posix_spawn 'tool'"]]) {
    const native = Object.assign(new Error("native launch failed"), { errno: -2, code: "ENOENT", syscall });
    const api = createNodeExec(unused, () => { throw native; }, {}, undefined, "bun");
    expect(api.spawnSync("tool")).toMatchObject({ error: { message, errno: -2, code: "ENOENT", syscall: "spawnSync tool" } });
    expect(thrown(() => api.execFileSync("tool"))).toMatchObject({ message, errno: -2, code: "ENOENT", syscall: "spawnSync tool" });
  }
});

it("captures Bun's initial lookup PATH while passing the live environment to the child", () => {
  const calls: unknown[] = [], env = { PATH: "/initial" };
  const api = createNodeExec(unused, (...args) => { calls.push(args); return { pid: 8, status: 0, signal: null, stdout: new Uint8Array(), stderr: new Uint8Array() }; }, env, undefined, "bun");
  env.PATH = "/later";
  for (const invoke of [() => api.spawnSync("tool"), () => api.execFileSync("tool")]) invoke();
  expect(calls).toEqual(Array.from({ length: 2 }, () => [{ kind: "spawn", command: "tool", args: [], cwd: ".", env: { PATH: "/later" } }, new Uint8Array(), 1024 * 1024, { runtime: "bun", path: "/initial" }]));
  api.spawnSync("tool", [], { env: {} });
  expect(calls.at(-1)).toEqual([{ kind: "spawn", command: "tool", args: [], cwd: ".", env: {} }, new Uint8Array(), 1024 * 1024, { runtime: "bun", path: "/usr/local/bin:/bin:/usr/bin" }]);
  api.spawnSync("tool", [], { env: { PATH: "" } });
  expect(calls.at(-1)).toEqual([{ kind: "spawn", command: "tool", args: [], cwd: ".", env: { PATH: "" } }, new Uint8Array(), 1024 * 1024, { runtime: "bun", path: "/usr/local/bin:/bin:/usr/bin" }]);
  api.spawnSync("tool", [], { env: { PATH: "relative:first" }, cwd: "other" });
  expect(calls.at(-1)).toEqual([{ kind: "spawn", command: "tool", args: [], cwd: "other", env: { PATH: "relative:first" } }, new Uint8Array(), 1024 * 1024, { runtime: "bun", path: "relative:first" }]);
  api.spawnSync("/bin/tool");
  expect(calls.at(-1)).toEqual([{ kind: "spawn", command: "/bin/tool", args: [], cwd: ".", env: { PATH: "/later" } }, new Uint8Array(), 1024 * 1024, { runtime: "bun" }]);
});

it("keeps unqualified Bun error descriptions explicit", () => {
  const native = Object.assign(new Error("native launch failed"), { errno: -5, code: "EIO", syscall: "spawn" });
  const api = createNodeExec(unused, () => { throw native; }, {}, undefined, "bun");
  for (const invoke of [() => api.spawnSync("./tool"), () => api.execFileSync("./tool")]) expect(thrown(invoke)).toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
});

it("never translates transport failures or unrelated Linux failures into launch errors", () => {
  for (const runtime of ["node", "bun"] as const) for (const native of [new VMError("PROTOCOL_ERROR", "retired peer"), Object.assign(new Error("read failed"), { errno: -2, code: "ENOENT", syscall: "read" })]) {
    const api = createNodeExec(unused, () => { throw native; }, {}, undefined, runtime);
    for (const invoke of [() => api.spawnSync("./tool"), () => api.execFileSync("./tool")]) expect(thrown(invoke)).toBe(native);
  }
});

it.each(["node", "bun"] as const)("preserves %s capture overflow errors across all synchronous methods", runtime => {
  const api = createNodeExec(unused, () => ({ pid: 9, status: null, signal: 15, stdout: Uint8Array.of(65, 66, 67, 68, 69), stderr: new Uint8Array(), error: "ENOBUFS" }), {}, undefined, runtime);
  const message = runtime === "node" ? "spawnSync /bin/sh ENOBUFS" : "spawnSync /bin/sh ENOBUFS (stdout or stderr buffer reached maxBuffer size limit)";
  const result = api.spawnSync("/bin/sh", ["-c", "printf ABCDE"], { maxBuffer: 3 });
  expect(result).toMatchObject({ error: { name: runtime === "node" ? "Error" : "SystemError", message, errno: -105, code: "ENOBUFS", path: "/bin/sh", spawnargs: ["-c", "printf ABCDE"] }, pid: 9, status: null, signal: "SIGTERM" });
  for (const invoke of [() => api.execFileSync("/bin/sh", ["-c", "printf ABCDE"], { maxBuffer: 3 }), () => api.execSync("printf ABCDE", { maxBuffer: 3 })]) {
    const error = thrown(invoke); if (!(error instanceof Error)) throw new Error("Missing overflow exception");
    expect(error).toMatchObject({ message, errno: -105, code: "ENOBUFS", pid: 9, status: null, signal: "SIGTERM", path: "/bin/sh", spawnargs: ["-c", "printf ABCDE"] });
    expect(error.constructor.name).toBe(runtime === "node" ? "Error" : "SystemError");
    expect(Object.hasOwn(error, "name")).toBe(false);
    const self: unknown = Reflect.get(error, "error"); expect(self).toBe(runtime === "node" ? error : undefined);
  }
});
