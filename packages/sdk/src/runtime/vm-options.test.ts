import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { createRuntimeVM } from "./index.js";
import { validateRuntimeVMOptions, validateSpawnSpec, validateDependencyPreparation } from "./vm-options.js";

const options = { mode: "system", workspaceId: "assistance-test", memoryMiB: 256, network: "local", vcpus: 1 } as const;
const userspace = { mode: "userspace", workspaceId: "userspace", memoryMiB: 256, network: "local" } as const;

it("gives public guest commands a standard Linux PATH and preserves explicit PATH choices", () => {
  const command = { command: "python3", env: { PYTHONUTF8: "1" } };
  expect(validateSpawnSpec(command, true).env).toEqual({ PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/workspace", PYTHONUTF8: "1" });
  expect(validateSpawnSpec({ command: "python3", env: { PATH: "/workspace/bin" } }, true).env).toEqual({ PATH: "/workspace/bin", HOME: "/workspace" });
  expect(validateSpawnSpec({ command: "python3", env: { PATH: "" } }, true).env).toEqual({ PATH: "", HOME: "/workspace" });
  expect(validateSpawnSpec(command).env).toEqual({ PYTHONUTF8: "1" });
});

it("makes the actual native Node home lookup use the public guest workspace", () => {
  const env = validateSpawnSpec({ command: "pnpm" }, true).env;
  const home = execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:os').homedir())"], { env, encoding: "utf8", timeout: 10_000, maxBuffer: 4096 });
  expect(home).toBe("/workspace");
});

it("preserves explicit guest homes, including an intentionally empty HOME", () => {
  const input = { command: "pnpm", env: { HOME: "/workspace/custom-home" } };
  const env = validateSpawnSpec(input, true).env;
  const home = execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:os').homedir())"], { env, encoding: "utf8", timeout: 10_000, maxBuffer: 4096 });
  expect(home).toBe(input.env.HOME);
  expect(validateSpawnSpec({ command: "pnpm", env: { HOME: "" } }, true).env["HOME"]).toBe("");
  expect(input.env).toEqual({ HOME: "/workspace/custom-home" });
  expect(validateSpawnSpec({ command: "pnpm" }).env).toEqual({});
});

it("admits only explicit Userspace identity and root persistence selections", () => {
  expect(validateRuntimeVMOptions(userspace)).toEqual(userspace);
  for (const initialUser of ["user", "root"]) {
    for (const rootPersistence of ["ephemeral", "persistent"]) {
      expect(validateRuntimeVMOptions({ ...userspace, initialUser, rootPersistence }))
        .toEqual({ ...userspace, initialUser, rootPersistence });
    }
  }
  for (const invalid of [
    { initialUser: "admin" }, { initialUser: 0 }, { rootPersistence: "memory" },
    { rootPersistence: true }, { initialUser: null }, { rootPersistence: null },
    { rootPersistence: "persistent", ephemeral: true },
  ]) expect(() => validateRuntimeVMOptions({ ...userspace, ...invalid })).toThrow();
  for (const field of [{ initialUser: "root" }, { rootPersistence: "persistent" }]) {
    expect(() => validateRuntimeVMOptions({ ...options, ...field })).toThrow();
  }
});

it("accepts previewIsolation with a preview origin and refuses it alone", () => {
  expect(validateRuntimeVMOptions({ ...userspace, previewOrigin: "https://fedora.tail133191.ts.net:8443", previewIsolation: "shared" }))
    .toMatchObject({ previewIsolation: "shared" });
  expect(validateRuntimeVMOptions({ ...options, previewOrigin: "https://preview.example", previewIsolation: "per-session" }))
    .toMatchObject({ previewIsolation: "per-session" });
  expect(validateRuntimeVMOptions({ ...userspace, previewOrigin: "https://preview.example" })).not.toHaveProperty("previewIsolation");
  expect(() => validateRuntimeVMOptions({ ...userspace, previewIsolation: "shared" })).toThrow("previewIsolation requires previewOrigin");
  expect(() => validateRuntimeVMOptions({ ...userspace, previewOrigin: "https://p.example", previewIsolation: "private" }))
    .toThrow("previewIsolation must be 'per-session' or 'shared'");
});
it("accepts the router module's URL for System only", () => {
  expect(validateRuntimeVMOptions({ ...options, netstackWasmUrl: "/assets/router.wasm" })).toMatchObject({ netstackWasmUrl: "/assets/router.wasm" });
  expect(validateRuntimeVMOptions(options)).not.toHaveProperty("netstackWasmUrl");
  expect(() => validateRuntimeVMOptions({ ...options, netstackWasmUrl: 7 })).toThrow();
  expect(() => validateRuntimeVMOptions({ ...userspace, netstackWasmUrl: "/assets/router.wasm" })).toThrow();
});
const assistance = { executionOrigin: "https://execution.example", manifestUrl: "https://execution.example/manifest.json" };

it("validates preparation defaults and workspace-relative paths without accepting installation policy", () => {
  expect(validateDependencyPreparation(undefined)).toEqual({ cwd: "/", frozenLockfile: true });
  expect(validateDependencyPreparation({ cwd: "apps/site", frozenLockfile: false })).toEqual({ cwd: "/apps/site", frozenLockfile: false });
  const signal = new AbortController().signal;
  expect(validateDependencyPreparation({ signal }).signal).toBe(signal);
  for (const value of [null, [], { cwd: "../outside" }, { cwd: "a\\b" }, { frozenLockfile: "false" },
    { signal: {} }, { ignoreScripts: true }, { approveBuildScript: () => "allow" }]) {
    expect(() => validateDependencyPreparation(value)).toThrow();
  }
});

it("keeps approval callbacks in validated SDK options and rejects invalid decisions", async () => {
  const approval = vi.fn(() => Promise.resolve<unknown>("allow"));
  const configured = validateRuntimeVMOptions({ ...options, assistance: { ...assistance, approveBuildScript: approval } });
  if (configured.mode !== "system" || configured.assistance?.approveBuildScript === undefined) throw new Error("missing approval callback");
  const request = { name: "pkg", version: "1.0.0", integrity: "sha512-content", signal: new AbortController().signal };
  await expect(configured.assistance.approveBuildScript(request)).resolves.toBe("allow");
  expect(approval).toHaveBeenCalledWith(request);
  approval.mockResolvedValue("yes");
  await expect(configured.assistance.approveBuildScript(request)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  for (const value of [null, true, "allow", {}]) {
    expect(() => validateRuntimeVMOptions({ ...options, assistance: { ...assistance, approveBuildScript: value } })).toThrow();
  }
});

it("cancels unanswered approvals and ignores a late allow decision", async () => {
  const reply = Promise.withResolvers<unknown>();
  const callback = vi.fn(() => reply.promise);
  const optionsWithCallback = validateRuntimeVMOptions({ ...options, assistance: { ...assistance, approveBuildScript: callback } });
  if (optionsWithCallback.mode !== "system" || optionsWithCallback.assistance?.approveBuildScript === undefined) throw new Error("missing callback");
  const controller = new AbortController();
  const request = { name: "pkg", version: "1.0.0", integrity: "sha512-content", signal: controller.signal };
  const pending = optionsWithCallback.assistance.approveBuildScript(request);
  const outcome = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  controller.abort();
  await outcome;
  reply.resolve("allow");
  await expect(optionsWithCallback.assistance.approveBuildScript(request)).rejects.toMatchObject({ code: "ABORTED" });
  expect(callback).toHaveBeenCalledTimes(1);
});

it("does not convert callback failures or synchronous cancellation into approval", async () => {
  const controller = new AbortController();
  const failure = new Error("approval callback failed");
  for (const callback of [() => { throw failure; }, () => Promise.reject(failure), () => { controller.abort(); throw failure; }]) {
    const configured = validateRuntimeVMOptions({ ...options, assistance: { ...assistance, approveBuildScript: callback } });
    if (configured.mode !== "system" || configured.assistance?.approveBuildScript === undefined) throw new Error("missing callback");
    await expect(configured.assistance.approveBuildScript({ name: "pkg", version: "1", integrity: "sha512-content", signal: controller.signal })).rejects.toBeDefined();
  }
});

it("decodes assistance only for system VMs and rejects unsafe or ambiguous origins", () => {
  expect(validateRuntimeVMOptions({ ...options, assistance })).toEqual({ ...options, assistance });
  for (const value of [
    { ...assistance, extra: true },
    { ...assistance, executionOrigin: "http://execution.example" },
    { ...assistance, executionOrigin: "https://execution.example/path" },
    { ...assistance, manifestUrl: "https://other.example/manifest.json" },
    { ...assistance, manifestUrl: "https://user:secret@execution.example/manifest.json" },
  ]) expect(() => validateRuntimeVMOptions({ ...options, assistance: value })).toThrow();
  expect(() => validateRuntimeVMOptions({ ...options, assistance, previewOrigin: assistance.executionOrigin })).toThrow();
  expect(() => validateRuntimeVMOptions({ mode: "userspace", workspaceId: "test", memoryMiB: 256, network: "local", assistance })).toThrow();
});

it("retains guest execution by default and validates the closed execution selection", () => {
  expect(validateSpawnSpec({ command: "node" }).execution).toBeUndefined();
  expect(validateSpawnSpec({ command: "node", execution: { kind: "guest" } }).execution).toEqual({ kind: "guest" });
  const execution = { kind: "assisted-node", profile: "node24-next16-v1" };
  expect(validateSpawnSpec({ command: "node", args: ["./main.mjs", "--app-flag"], cwd: "/app", execution })).toMatchObject({ cwd: "/app", execution });
  for (const spec of [
    { command: "node", args: [] }, { command: "node", args: ["-e", "1"] },
    { command: "node", args: ["-"] }, { command: "bun", args: ["./main.js"] },
    { command: "node", args: ["./main.js"], terminal: { rows: 24, columns: 80 } },
  ]) expect(() => validateSpawnSpec({ ...spec, execution })).toThrow();
  expect(() => validateSpawnSpec({ command: "node", execution: { ...execution, profile: "unknown" } })).toThrow();
  expect(() => validateSpawnSpec({ command: "node", execution: { kind: "guest", profile: "unknown" } })).toThrow();
});

it("ordinary SDK admission fails before constructing a worker", async () => {
  const worker = vi.fn(() => { throw new Error("worker must not start"); });
  vi.stubGlobal("Worker", worker);
  try {
    await expect(createRuntimeVM({ ...options, assistance })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
    expect(worker).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});
