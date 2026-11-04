import { describe, expect, it } from "vitest";
import type { ProcessExit, ProcessHandle } from "../../contracts.js";
import { VMError } from "../../runtime/errors.js";
import { decodeProcessId } from "../../values.js";
import type { EndpointDecl } from "../manifest-types.js";
import { runProperties, runnerDiagnostics, type ConformanceOutcome, type ConformancePorts, type ConformanceSubject, type StartedModule } from "./properties.js";
import { decodeWasmTestReport, WASM_TEST_PROPERTIES, type WasmPropertyResult, type WasmTestProperty } from "./report.js";

const ENDPOINTS: Readonly<Record<string, EndpointDecl>> = { rpc: { kind: "unix", path: "/workspace/_oxidevm/kv.sock", protocol: "kv/1" }, tcp: { kind: "tcp", port: 5432, protocol: "kv/1" } };
const SERVICE: ConformanceSubject = { kind: "service", endpoints: ENDPOINTS, reach: "none" };
const COMMAND: ConformanceSubject = { kind: "command", endpoints: {}, reach: "none" };
const record = (value: Readonly<Record<string, unknown>>): string => JSON.stringify(value);

interface FakeBehaviour {
  /** What a genuine start does: a process that exits with this, or a rejection. */
  readonly genuine?: (attempt: number, world: World) => ProcessExit | "running" | VMError;
  readonly tampered?: ProcessExit | VMError;
  readonly stderr?: string;
  readonly ignoresEof?: boolean;
  readonly duplicateAllowed?: boolean;
  readonly captureWhileRunning?: boolean;
  readonly refused?: readonly string[];
  /** What the endpoint probe throws instead of answering. */
  readonly probeError?: VMError;
}

class World {
  running = 0;
  attempts = 0;
  constructor(readonly behaviour: FakeBehaviour) {}

  process(exit: ProcessExit | "running", stderr: string, onEof: () => ProcessExit | undefined): StartedModule {
    const settled = Promise.withResolvers<ProcessExit>();
    let alive = exit === "running";
    if (alive) this.running += 1;
    const end = (value: ProcessExit): void => { if (alive) { alive = false; this.running -= 1; } settled.resolve(value); };
    if (exit !== "running") end(exit);
    const process: ProcessHandle = {
      kind: "process", pid: decodeProcessId(41),
      stdin: new WritableStream({ close: () => { const value = onEof(); if (value !== undefined) end(value); } }),
      stdout: new ReadableStream({ start: controller => { controller.close(); } }),
      stderr: new ReadableStream({ start: controller => { controller.close(); } }),
      exit: settled.promise,
      kill: () => { end({ kind: "signaled", signal: "SIGKILL", signalNumber: 9 }); return Promise.resolve(); },
    };
    return { process, stderr: settled.promise.then(() => stderr) };
  }

  ports(): ConformancePorts {
    let clock = 0;
    return {
      now: () => (clock += 5),
      start: copy => {
        if (copy === "tampered") {
          const tampered = this.behaviour.tampered ?? new VMError("GUEST_CRASH", "tool did not start: integrity", { reason: "wasm-module-integrity" });
          return tampered instanceof VMError ? Promise.reject(tampered) : Promise.resolve(this.process(tampered, "", () => undefined));
        }
        this.attempts += 1;
        if (this.running > 0 && !(this.behaviour.duplicateAllowed ?? false)) return Promise.reject(new VMError("QUOTA_EXCEEDED", "kv is already running", { reason: "wasm-module-busy" }));
        const outcome = this.behaviour.genuine?.(this.attempts, this) ?? "running";
        if (outcome instanceof VMError) return Promise.reject(outcome);
        return Promise.resolve(this.process(outcome, this.behaviour.stderr ?? "", () => (this.behaviour.ignoresEof ?? false) ? undefined : { kind: "exited", code: 0 }));
      },
      stop: async (process: ProcessHandle) => {
        await process.stdin.close().catch(() => undefined);
        const done = await Promise.race([process.exit, Promise.resolve(undefined)]);
        if (done !== undefined) return done;
        await process.kill("SIGKILL");
        return process.exit;
      },
      capture: () => this.running > 0 && !(this.behaviour.captureWhileRunning ?? false)
        ? Promise.reject(new VMError("FEATURE_NOT_AVAILABLE", "cannot capture a live JS process"))
        : Promise.resolve(),
      probe: () => this.behaviour.probeError === undefined ? Promise.resolve(this.behaviour.refused ?? []) : Promise.reject(this.behaviour.probeError),
    };
  }
}

async function outcome(subject: ConformanceSubject, behaviour: FakeBehaviour): Promise<ConformanceOutcome> {
  return runProperties(subject, new World(behaviour).ports(), { commandMs: 50 });
}

async function run(subject: ConformanceSubject, behaviour: FakeBehaviour): Promise<ReadonlyMap<WasmTestProperty, WasmPropertyResult>> {
  const completed = await outcome(subject, behaviour);
  if (completed.kind !== "completed") throw new Error(`the run was refused: ${completed.refusal.message}`);
  const results = completed.properties;
  expect(results.map(result => result.property)).toEqual(WASM_TEST_PROPERTIES);
  // Every outcome is a valid report entry.
  decodeWasmTestReport({ schemaVersion: 1, result: results.some(result => result.status === "failed") ? "failed" : "passed", module: { id: "m", version: "1", kind: subject.kind, release: "r" }, sdkVersion: "0", engineRelease: "e", browser: { name: "chromium", version: "1" }, image: { manifestSHA256: "a" }, properties: results });
  return new Map(results.map(result => [result.property, result]));
}

function expectFailed(results: ReadonlyMap<WasmTestProperty, WasmPropertyResult>, property: WasmTestProperty, text: string): void {
  expect(results.get(property)?.status).toBe("failed");
  expect(results.get(property)?.message ?? "").toContain(text);
}

const statuses = (results: ReadonlyMap<WasmTestProperty, WasmPropertyResult>): Readonly<Record<string, string>> =>
  Object.fromEntries([...results].map(([property, result]) => [property, result.status]));

describe("command modules", () => {
  it("pass integrity, exit-range and declared-host, and skip the service properties", async () => {
    const results = await run(COMMAND, { genuine: () => ({ kind: "exited", code: 2 }), stderr: "tool: usage: tool <a> <b>\n" });
    expect(statuses(results)).toEqual({ integrity: "passed", "exit-range": "passed", ready: "not-applicable", endpoints: "not-applicable", "duplicate-start": "not-applicable", "snapshot-refused": "not-applicable", "eof-stop": "not-applicable", restart: "not-applicable", "kill-recover": "not-applicable", "declared-host": "passed", "network-direct": "passed", "network-declared": "passed", "network-offline": "passed" });
  });

  it("fail exit-range and network-offline when main returns a status above 119 when main returns a status above 119", async () => {
    const results = await run(COMMAND, { genuine: () => ({ kind: "exited", code: 123 }), stderr: record({ oxidevm: "error", v: 1, kind: "adapter", fault: "exit-status", message: "tool: main must return an integer exit status from 0 to 119" }) });
    expectFailed(results, "exit-range", "exit-status fault");
    expectFailed(results, "network-offline", "exit status 123");
    expect([...results.values()].filter(result => result.status === "failed").map(result => result.property)).toEqual(["exit-range", "network-offline"]);
  });

  it("fail declared-host, and only declared-host, when the adapter reaches for an undeclared capability", async () => {
    const stderr = [record({ oxidevm: "warning", v: 1, kind: "undeclared-capability", member: "process", capabilities: ["process.info", "process.spawn"] }), record({ oxidevm: "error", v: 1, kind: "adapter", fault: "undeclared-capability", capabilities: ["process.info", "process.spawn"], message: "x" })].join("\n");
    const results = await run(COMMAND, { genuine: () => ({ kind: "exited", code: 123 }), stderr });
    expectFailed(results, "declared-host", "process.info, process.spawn");
    expect(results.get("exit-range")?.status).toBe("not-applicable");
    expect(results.get("network-offline")?.status).toBe("not-applicable");
    expect([...results.values()].filter(result => result.status === "failed").map(result => result.property)).toEqual(["declared-host"]);
  });

  it("fail integrity when the altered copy ends with any status but 121", async () => {
    const results = await run(COMMAND, { tampered: { kind: "exited", code: 123 }, genuine: () => ({ kind: "exited", code: 0 }) });
    expectFailed(results, "integrity", "exit status 123");
  });

  it("fail integrity when the altered copy runs", async () => {
    const results = await run(COMMAND, { tampered: { kind: "exited", code: 0 }, genuine: () => ({ kind: "exited", code: 0 }) });
    expectFailed(results, "integrity", "exit status 0");
  });

  it("fail exit-range when the command never ends, and kill it", async () => {
    const results = await run(COMMAND, { genuine: () => "running" });
    expectFailed(results, "exit-range", "did not exit within 50 ms");
  });
});

describe("service modules", () => {
  it("pass every property when the service follows the runner contract", async () => {
    const results = await run(SERVICE, {});
    expect(statuses(results)).toEqual({ integrity: "passed", "exit-range": "not-applicable", ready: "passed", endpoints: "passed", "duplicate-start": "passed", "snapshot-refused": "passed", "eof-stop": "passed", restart: "passed", "kill-recover": "passed", "declared-host": "passed", "network-direct": "passed", "network-declared": "passed", "network-offline": "passed" });
  });

  it("fail eof-stop, and only eof-stop, when the service ignores end of input", async () => {
    const results = await run(SERVICE, { ignoresEof: true });
    expectFailed(results, "eof-stop", "was killed");
    expect([...results.values()].filter(result => result.status === "failed").map(result => result.property)).toEqual(["eof-stop"]);
  });

  it("mark the dependent properties not applicable, not passed, when the service never becomes ready", async () => {
    const results = await run(SERVICE, { genuine: () => new VMError("PROTOCOL_ERROR", "The module's ready line is not JSON", { reason: "wasm-module-ready" }) });
    expectFailed(results, "ready", "ready line is not JSON");
    for (const property of ["endpoints", "duplicate-start", "snapshot-refused", "eof-stop", "restart", "kill-recover"] as const) {
      expect(results.get(property)?.status).toBe("not-applicable");
      expect(results.get(property)?.message).toBe("the service never became ready");
    }
  });

  it("fail duplicate-start when a second instance starts beside the first", async () => {
    const results = await run(SERVICE, { duplicateAllowed: true });
    expectFailed(results, "duplicate-start", "exit status 124");
  });

  it("fail snapshot-refused when a restore point is captured while the module runs", async () => {
    const results = await run(SERVICE, { captureWhileRunning: true });
    expectFailed(results, "snapshot-refused", "captured while the module ran");
  });

  it("fail endpoints when an endpoint does not accept a connection", async () => {
    const results = await run(SERVICE, { refused: ["tcp"] });
    expect(results.get("endpoints")).toMatchObject({ status: "failed", message: "no connection to tcp" });
  });

  it("fail kill-recover when a start after a kill does not become ready", async () => {
    const results = await run(SERVICE, { genuine: attempt => attempt === 5 ? new VMError("GUEST_CRASH", "kv did not start: address in use", { reason: "wasm-module-busy" }) : "running" });
    expectFailed(results, "kill-recover", "address in use");
    expect(results.get("restart")?.status).toBe("passed");
  });
});

describe("runner diagnostics", () => {
  it("collects undeclared capabilities and the last fault, and ignores other output", () => {
    const stderr = ["plain text", "{not json", record({ oxidevm: "warning", v: 1, kind: "undeclared-capability", member: "fs", capabilities: ["files.sync"] }), record({ oxidevm: "error", v: 1, kind: "adapter", fault: "thrown", message: "boom" })].join("\n");
    expect(runnerDiagnostics(stderr)).toEqual({ undeclared: ["files.sync"], failure: { oxidevm: "error", kind: "adapter", fault: "thrown", message: "boom" } });
  });
});

// Engine ADR 0029, N-9: the VM under test is never connected, so every run of a module with a reach is an offline run.
describe("network properties", () => {
  const INTERNET: ConformanceSubject = { ...COMMAND, reach: "internet" };
  const failedOnly = (results: ReadonlyMap<WasmTestProperty, WasmPropertyResult>) => [...results.values()].filter(result => result.status === "failed").map(result => result.property);

  it("network-direct fails, and only it, when the module tried the browser's own network", async () => {
    expect(statuses(await run(COMMAND, { genuine: () => ({ kind: "exited", code: 0 }) }))["network-direct"]).toBe("passed");
    const results = await run(COMMAND, { genuine: () => ({ kind: "exited", code: 0 }), stderr: record({ oxidevm: "warning", v: 1, kind: "network-direct", api: "connect-src", target: "https://example.com/x" }) });
    expectFailed(results, "network-direct", "connect-src https://example.com/x");
    expect(failedOnly(results)).toEqual(["network-direct"]);
  });

  it("network-declared fails, and only it, when Rust refused a destination beyond the reach", async () => {
    const vmOnly: ConformanceSubject = { ...COMMAND, reach: "vm" };
    expect(statuses(await run(vmOnly, { genuine: () => ({ kind: "exited", code: 0 }) }))["network-declared"]).toBe("passed");
    const results = await run(vmOnly, { genuine: () => ({ kind: "exited", code: 0 }), stderr: record({ oxidevm: "warning", v: 1, kind: "network-reach", address: "93.184.215.14", port: 443, protocol: "tcp" }) });
    expectFailed(results, "network-declared", "tcp 93.184.215.14:443");
    expect(failedOnly(results)).toEqual(["network-declared"]);
  });

  it("network-offline passes a command that fails offline with one line and status 69, and fails a silent or crashing one", async () => {
    expect(statuses(await run(INTERNET, { genuine: () => ({ kind: "exited", code: 69 }), stderr: "tool: network unavailable: this VM is not connected to the internet\n" }))["network-offline"]).toBe("passed");
    expectFailed(await run(INTERNET, { genuine: () => ({ kind: "exited", code: 69 }) }), "network-offline", "without a line on standard error");
    const crashed = await run(INTERNET, { genuine: () => ({ kind: "exited", code: 123 }), stderr: record({ oxidevm: "error", v: 1, kind: "adapter", fault: "thrown", message: "TypeError: fetch failed" }) });
    expectFailed(crashed, "network-offline", "kit.net.describe");
    expectFailed(await run(INTERNET, { genuine: () => "running" }), "network-offline", "did not end within its bound");
  });

  // ISS-10: N-9 holds for every module, so a module without a reach is checked as well; the VM is local-only for it too.
  it("network-offline applies to a module that declares no reach", async () => {
    expect(statuses(await run(COMMAND, { genuine: () => ({ kind: "exited", code: 0 }) }))["network-offline"]).toBe("passed");
    expect(statuses(await run(COMMAND, { genuine: () => ({ kind: "exited", code: 1 }), stderr: "tool: no input\n" }))["network-offline"]).toBe("passed");
    expectFailed(await run(COMMAND, { genuine: () => ({ kind: "exited", code: 1 }) }), "network-offline", "without a line on standard error");
    expectFailed(await run(COMMAND, { genuine: () => "running" }), "network-offline", "did not end within its bound");
    expectFailed(await run(COMMAND, { genuine: () => new VMError("GUEST_CRASH", "tool did not start: adapter") }), "network-offline", "did not start");
    expect(statuses(await run(SERVICE, {}))["network-offline"]).toBe("passed");
    expectFailed(await run(SERVICE, { refused: ["rpc"] }), "network-offline", "stopped serving");
    expectFailed(await run(SERVICE, { genuine: () => new VMError("GUEST_CRASH", "kv crashed") }), "network-offline", "did not become ready");
  });

  it("network-offline passes a service that stays ready offline, and fails one that does not", async () => {
    expect(statuses(await run({ ...SERVICE, reach: "internet" }, {}))["network-offline"]).toBe("passed");
    expectFailed(await run({ ...SERVICE, reach: "internet" }, { refused: ["tcp"] }), "network-offline", "stopped serving");
    expectFailed(await run({ ...SERVICE, reach: "vm" }, { genuine: () => new VMError("GUEST_CRASH", "kv crashed") }), "network-offline", "did not become ready");
  });
});

// A browser or image that cannot run the module at all refuses the run: no property passes or fails (wasm test exits 4).
describe("refused runs", () => {
  const isolation = (capability: string): VMError => new VMError("FEATURE_NOT_AVAILABLE", `Modules cannot run in this browser: ${capability} is unavailable`, { reason: "wasm-module-isolation-unavailable", capability });
  const missing = new VMError("FEATURE_NOT_AVAILABLE", "tool did not start: Missing: browser feature jspi", { reason: "wasm-module-prerequisite", status: 122, missing: ["browser feature jspi"] });

  it("refuses with the capability when the browser cannot isolate module workers, instead of failing integrity and exit-range", async () => {
    expect(await outcome(COMMAND, { tampered: isolation("blob-workers"), genuine: () => isolation("blob-workers") })).toEqual({
      kind: "refused", refusal: { code: "FEATURE_NOT_AVAILABLE", reason: "wasm-module-isolation-unavailable", capability: "blob-workers", message: "Modules cannot run in this browser: blob-workers is unavailable" },
    });
  });

  it("refuses a service whose module frame is lost on a later start, and one whose endpoint probe is refused", async () => {
    expect(await outcome(SERVICE, { genuine: attempt => attempt === 3 ? isolation("module-frame-lost") : "running" })).toMatchObject({ kind: "refused", refusal: { capability: "module-frame-lost" } });
    expect(await outcome(SERVICE, { probeError: isolation("frame-policy") })).toMatchObject({ kind: "refused", refusal: { capability: "frame-policy" } });
  });

  it("refuses with what is missing when the browser or image lacks a declared prerequisite", async () => {
    expect(await outcome(COMMAND, { genuine: () => missing })).toEqual({
      kind: "refused", refusal: { code: "FEATURE_NOT_AVAILABLE", reason: "wasm-module-prerequisite", missing: ["browser feature jspi"], message: "tool did not start: Missing: browser feature jspi" },
    });
    expect(await outcome({ ...SERVICE, reach: "internet" }, { genuine: () => missing })).toMatchObject({ kind: "refused", refusal: { reason: "wasm-module-prerequisite" } });
  });

  it("still fails, not refuses, for an error outside the closed refusal set", async () => {
    expectFailed(await run(COMMAND, { tampered: isolation("telepathy"), genuine: () => ({ kind: "exited", code: 0 }) }), "integrity", "FEATURE_NOT_AVAILABLE");
    expectFailed(await run(COMMAND, { genuine: () => new VMError("FEATURE_NOT_AVAILABLE", "tool did not start", { reason: "wasm-artifact-sync-read" }) }), "exit-range", "did not start");
    expect(statuses(await run(SERVICE, {}))["snapshot-refused"]).toBe("passed");
  });
});
