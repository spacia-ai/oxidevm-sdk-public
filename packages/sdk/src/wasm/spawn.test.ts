import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinuxSignal, PipeJSProcessSpec, ProcessExit, ProcessHandle } from "../contracts.js";
import { decodeProcessId } from "../values.js";
import { VMError } from "../runtime/errors.js";
import type { RunnerHostLaunch } from "../runtime/js-process/launch.js";
import { moduleHandle } from "./handle.js";
import { COMMAND_DECLARATION, SERVICE_DECLARATION, buildRelease, type Release } from "./runner/fixtures.test-support.js";
import { parseLaunchArgument } from "./runner/descriptor.js";
import { spawnModule, stopModule, type ModuleVM } from "./spawn.js";

/** The VM's owner record, which starts the runner with its launch in the start message (engine ADR 0027). */
const owner = vi.hoisted(() => ({ start: vi.fn<(vm: object, spec: PipeJSProcessSpec, launch: RunnerHostLaunch) => Promise<ProcessHandle>>() }));
vi.mock("../vm-adapter.js", () => ({ spawnOwnedModuleProcess: owner.start }));

afterEach(() => { vi.useRealTimers(); owner.start.mockReset(); });

const encoder = new TextEncoder();
const pid = decodeProcessId(42);

/** A process whose output and exit the test controls. */
function fakeProcess() {
  const holders: Record<"stdout" | "stderr", { controller?: ReadableStreamDefaultController<Uint8Array> }> = { stdout: {}, stderr: {} };
  const make = (name: "stdout" | "stderr") => new ReadableStream<Uint8Array>({ start(controller) { holders[name].controller = controller; } });
  const exit = Promise.withResolvers<ProcessExit>();
  const stdinClosed = Promise.withResolvers<undefined>();
  const kills: (LinuxSignal | undefined)[] = [];
  const handle: ProcessHandle = {
    kind: "process", pid, stdout: make("stdout"), stderr: make("stderr"), exit: exit.promise,
    stdin: new WritableStream<Uint8Array>({ close() { stdinClosed.resolve(undefined); } }),
    kill: signal => { kills.push(signal); finish({ kind: "signaled", signal: "SIGKILL", signalNumber: 9 }); return Promise.resolve(); },
  };
  /** A process that ends has its output pipes closed after the data already written. */
  function finish(result: ProcessExit): void {
    exit.resolve(result);
    for (const holder of Object.values(holders)) { try { holder.controller?.close(); } catch { /* already closed */ } }
  }
  return {
    handle, kills, stdinClosed: stdinClosed.promise,
    out: (text: string) => { holders.stdout.controller?.enqueue(encoder.encode(text)); },
    err: (text: string) => { holders.stderr.controller?.enqueue(encoder.encode(text)); },
    exits: (code: number) => { finish({ kind: "exited", code }); },
    exitsBySignal: () => { finish({ kind: "signaled", signal: "SIGSEGV", signalNumber: 11 }); },
  };
}

/** A VM whose owner starts `process`. Its public `spawnJS` never runs: a launch description in argv would reach `/proc/<pid>/cmdline`. */
function fakeVM(process: ProcessHandle) {
  const specs: PipeJSProcessSpec[] = [], launches: RunnerHostLaunch[] = [];
  const vm: ModuleVM = { spawnJS: () => Promise.reject(new Error("spawnModule must not start through the public spawnJS")) };
  owner.start.mockImplementation((target, spec, launch) => {
    if (target !== vm) return Promise.reject(new Error("started through another VM"));
    specs.push(spec); launches.push(launch); return Promise.resolve(process);
  });
  return { vm, specs, launches };
}

const handleFor = (release: Release) => moduleHandle(release.manifest, { release: release.descriptor.release, adapter: release.descriptor.adapter, artifacts: release.descriptor.artifacts });
const READY = (info: unknown = { version: "1" }, id = 42) => `${JSON.stringify({ oxidevm: "ready", v: 1, pid: id, info })}\n`;
const serviceRelease = () => buildRelease({ adapter: "export default () => ({ protocols: {} });", declaration: SERVICE_DECLARATION, options: {}, workspaceId: "ws" });
const commandRelease = () => buildRelease({ adapter: "export default () => ({ main: () => 0 });", declaration: { ...COMMAND_DECLARATION, options: { mode: { type: "enum", values: ["a", "b"], default: "a" } } } });

describe("spawning a command module", () => {
  it("passes the descriptor in the runner's start message and only the command's own arguments, working directory and environment as the process's", async () => {
    const release = await commandRelease(), process = fakeProcess(), { vm, specs, launches } = fakeVM(process.handle);
    const signal = new AbortController().signal;
    const handle = handleFor(release);
    const started = await spawnModule(vm, handle, { args: ["in.md", "out.html"], cwd: "/workspace", env: { MODE: "fast" }, options: { mode: "b" }, signal });
    expect(started).toBe(process.handle);
    expect(specs).toHaveLength(1);
    const spec = specs[0];
    expect(spec).toMatchObject({ cwd: "/workspace", env: { MODE: "fast" }, signal });
    expect(spec?.worker.pathname.endsWith("/assets/module-runner/runner.worker.js")).toBe(true);
    // argv, and so /proc/<pid>/cmdline, holds the caller's arguments and nothing of the descriptor or its options.
    expect(spec?.args).toEqual(["in.md", "out.html"]);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.kind).toBe("host");
    const descriptor = parseLaunchArgument(launches[0]?.descriptor);
    expect(descriptor.options).toEqual({ mode: "b" });
    expect(descriptor.manifest.id).toBe("tool");
    expect(descriptor.adapter.url).toBe(release.descriptor.adapter.url);
  });

  it("sends defaults explicitly and starts with no options and no arguments at all", async () => {
    const release = await commandRelease(), { vm, specs, launches } = fakeVM(fakeProcess().handle);
    await spawnModule(vm, handleFor(release));
    expect(parseLaunchArgument(launches[0]?.descriptor).options).toEqual({ mode: "a" });
    expect(specs[0]?.args).toEqual([]);
  });


  it("rejects bad options, a corrupt handle and a bad signal before starting anything", async () => {
    const release = await commandRelease(), { vm, specs } = fakeVM(fakeProcess().handle);
    await expect(spawnModule(vm, handleFor(release), { options: { mode: "c" } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-module-options" } });
    await expect(spawnModule(vm, handleFor(release), { options: { extra: 1 } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const forged = moduleHandle(release.manifest, { ...handleFor(release).pins, adapter: { ...release.descriptor.adapter, sha256: "0".repeat(64) } });
    await expect(spawnModule(vm, forged)).rejects.toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-manifest-invalid" } });
    // @ts-expect-error the type already requires an AbortSignal; the run-time check is for callers without types
    await expect(spawnModule(vm, handleFor(release), { signal: "nope" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    // A caller without types may pass anything as the handle: it is refused as a module, not with a TypeError.
    const untyped: { spawn(vm: unknown, handle: unknown): Promise<unknown> } = { spawn: spawnModule };
    for (const handle of [null, {}, { manifest: release.manifest }]) await expect(untyped.spawn(vm, handle)).rejects.toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-manifest-invalid" } });
    expect(specs).toEqual([]);
  });
});

describe("spawning a service module", () => {
  it("resolves when the ready line arrives and exposes the declared endpoints and the adapter's info", async () => {
    const release = await serviceRelease(), process = fakeProcess(), { vm, launches } = fakeVM(process.handle);
    const pending = spawnModule(vm, handleFor(release), { workspaceId: "ws" });
    process.err("warming up\n");
    process.out(READY({ version: "18.6", ready: true }));
    const running = await pending;
    expect(running.endpoints?.["pg"]).toEqual({ kind: "tcp", port: 5432, protocol: "postgres-3.0" });
    expect(running.info).toEqual({ version: "18.6", ready: true });
    expect(running.pid).toBe(pid);
    expect(parseLaunchArgument(launches[0]?.descriptor).workspaceId).toBe("ws");
    // Both streams are still whole: the ready line and the earlier diagnostics reach the caller.
    const out = running.stdout.getReader(), err = running.stderr.getReader();
    expect(new TextDecoder().decode((await out.read()).value)).toBe(READY({ version: "18.6", ready: true }));
    expect(new TextDecoder().decode((await err.read()).value)).toBe("warming up\n");
    process.out("later\n");
    expect(new TextDecoder().decode((await out.read()).value)).toBe("later\n");
  });

  it("accepts a ready line delivered in pieces", async () => {
    const release = await serviceRelease(), process = fakeProcess(), { vm } = fakeVM(process.handle);
    const pending = spawnModule(vm, handleFor(release), { workspaceId: "ws" });
    const line = READY();
    process.out(line.slice(0, 10)); await Promise.resolve(); process.out(line.slice(10));
    await expect(pending).resolves.toMatchObject({ info: { version: "1" } });
  });

  it("requires a workspace id for an exclusive service", async () => {
    const release = await serviceRelease(), { vm, specs } = fakeVM(fakeProcess().handle);
    await expect(spawnModule(vm, handleFor(release), {})).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(specs).toEqual([]);
  });

  it("explains an early exit with the runner's own message and maps each status to its error", async () => {
    const release = await serviceRelease();
    const cases: readonly (readonly [number, string, string])[] = [
      [120, "GUEST_CRASH", "wasm-module-launch"], [121, "GUEST_CRASH", "wasm-module-integrity"], [122, "FEATURE_NOT_AVAILABLE", "wasm-module-prerequisite"],
      [123, "GUEST_CRASH", "wasm-module-adapter"], [124, "QUOTA_EXCEEDED", "wasm-module-busy"], [3, "GUEST_CRASH", "wasm-module-adapter"],
    ];
    for (const [status, code, reason] of cases) {
      const process = fakeProcess(), { vm } = fakeVM(process.handle);
      const pending = spawnModule(vm, handleFor(release), { workspaceId: "ws" });
      process.err(`${JSON.stringify({ oxidevm: "error", v: 1, kind: "x", message: "Missing: guest executable /usr/bin/python3", items: ["guest executable /usr/bin/python3"] })}\n`);
      process.exits(status);
      await expect(pending, String(status)).rejects.toMatchObject({ code, detail: { reason, status, missing: ["guest executable /usr/bin/python3"] }, message: expect.stringContaining("Missing: guest executable /usr/bin/python3") as unknown });
    }
  });

  it("reports a pinned file the runner could not fetch as CORE_LOAD_FAILED wasm-module-artifact", async () => {
    const release = await serviceRelease(), process = fakeProcess(), { vm } = fakeVM(process.handle);
    const pending = spawnModule(vm, handleFor(release), { workspaceId: "ws" });
    process.err(`${JSON.stringify({ oxidevm: "error", v: 1, kind: "launch", message: "Artifact db.wasm is unavailable (HTTP 404)", reason: "wasm-module-artifact" })}\n`);
    process.exits(120);
    await expect(pending).rejects.toMatchObject({ code: "CORE_LOAD_FAILED", detail: { reason: "wasm-module-artifact", status: 120 }, message: expect.stringContaining("Artifact db.wasm is unavailable (HTTP 404)") as unknown });
  });

  it("falls back to the end of standard error when the runner left no report, and handles a crash by signal", async () => {
    const release = await serviceRelease(), first = fakeProcess();
    const pending = spawnModule(fakeVM(first.handle).vm, handleFor(release), { workspaceId: "ws" });
    first.err("native crash details\n");
    first.exitsBySignal();
    await expect(pending).rejects.toMatchObject({ code: "GUEST_CRASH", detail: { status: -11 }, message: expect.stringContaining("native crash details") as unknown });
  });

  it("kills a service whose ready line is wrong, and reports a protocol failure", async () => {
    const release = await serviceRelease();
    const bad: readonly string[] = ["not json\n", READY({}, 7), `${JSON.stringify({ oxidevm: "ready", v: 2, pid: 42, info: {} })}\n`, READY({ nested: {} }), `${JSON.stringify({ oxidevm: "ready", v: 1, pid: 42, info: {}, extra: 1 })}\n`, "[]\n"];
    for (const line of bad) {
      const process = fakeProcess(), { vm } = fakeVM(process.handle);
      const pending = spawnModule(vm, handleFor(release), { workspaceId: "ws" });
      process.out(line);
      await expect(pending, line).rejects.toMatchObject({ code: "PROTOCOL_ERROR", detail: { reason: "wasm-module-ready" } });
      expect(process.kills).toEqual(["SIGKILL"]);
    }
  });

  it("kills the process when the startup deadline passes, using the manifest's limit when it has one", async () => {
    vi.useFakeTimers();
    const release = await buildRelease({ adapter: "export default () => ({ protocols: {} });", declaration: { ...SERVICE_DECLARATION, limits: { startupMs: 3000 } }, workspaceId: "ws" });
    const process = fakeProcess(), { vm } = fakeVM(process.handle);
    const pending = spawnModule(vm, handleFor(release), { workspaceId: "ws" });
    const outcome = expect(pending).rejects.toMatchObject({ code: "GUEST_CRASH", message: expect.stringContaining("not ready within 3000 ms") as unknown });
    await vi.advanceTimersByTimeAsync(2999);
    expect(process.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    await outcome;
    expect(process.kills).toEqual(["SIGKILL"]);
  });

  it("kills the process and reports ABORTED when the caller cancels while it starts", async () => {
    const release = await serviceRelease(), process = fakeProcess(), { vm } = fakeVM(process.handle);
    const controller = new AbortController();
    const pending = spawnModule(vm, handleFor(release), { workspaceId: "ws", signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: expect.stringMatching(/Abort|VMError/u) as unknown });
    expect(process.kills).toEqual(["SIGKILL"]);
  });
});

describe("stopping a module", () => {
  it("closes standard input and returns the exit when the module leaves on its own", async () => {
    const process = fakeProcess();
    const stopping = stopModule(process.handle);
    await process.stdinClosed;
    process.exits(0);
    await expect(stopping).resolves.toEqual({ kind: "exited", code: 0 });
    expect(process.kills).toEqual([]);
  });

  it("kills a module that ignores the request once the grace period is over", async () => {
    vi.useFakeTimers();
    const process = fakeProcess();
    const stopping = stopModule(process.handle, { graceMs: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(process.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    await expect(stopping).resolves.toMatchObject({ kind: "signaled", signalNumber: 9 });
    expect(process.kills).toEqual(["SIGKILL"]);
  });
});

describe("a VM that cannot start the runner", () => {
  it("passes the VM owner's own typed error through unchanged and never falls back to the public spawnJS", async () => {
    const release = await commandRelease();
    const failure = new VMError("FEATURE_NOT_AVAILABLE", "JS processes require self-hosted Userspace");
    const calls: PipeJSProcessSpec[] = [];
    const vm: ModuleVM = { spawnJS: spec => { calls.push(spec); return Promise.reject(new Error("unused")); } };
    owner.start.mockRejectedValue(failure);
    await expect(spawnModule(vm, handleFor(release))).rejects.toBe(failure);
    expect(owner.start).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(0);
  });
});
