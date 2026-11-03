import { describe, expect, it } from "vitest";
import type { ProcessExit, ProcessHandle } from "../../contracts.js";
import { VMError } from "../../runtime/errors.js";
import { decodeProcessId } from "../../values.js";
import type { EndpointDecl } from "../manifest-types.js";
import { runProperties, runnerDiagnostics, type ConformancePorts, type ConformanceSubject, type StartedModule } from "./properties.js";
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
      probe: () => Promise.resolve(this.behaviour.refused ?? []),
    };
  }
}

async function run(subject: ConformanceSubject, behaviour: FakeBehaviour): Promise<ReadonlyMap<WasmTestProperty, WasmPropertyResult>> {
  const results = await runProperties(subject, new World(behaviour).ports(), { commandMs: 50 });
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
    const results = await run(COMMAND, { genuine: () => ({ kind: "exited", code: 2 }) });
    expect(statuses(results)).toEqual({ integrity: "passed", "exit-range": "passed", ready: "not-applicable", endpoints: "not-applicable", "duplicate-start": "not-applicable", "snapshot-refused": "not-applicable", "eof-stop": "not-applicable", restart: "not-applicable", "kill-recover": "not-applicable", "declared-host": "passed", "network-direct": "passed", "network-declared": "passed", "network-offline": "not-applicable" });
  });

  it("fail exit-range, and only exit-range, when main returns a status above 119", async () => {
    const results = await run(COMMAND, { genuine: () => ({ kind: "exited", code: 123 }), stderr: record({ oxidevm: "error", v: 1, kind: "adapter", fault: "exit-status", message: "tool: main must return an integer exit status from 0 to 119" }) });
    expectFailed(results, "exit-range", "exit-status fault");
    expect([...results.values()].filter(result => result.status === "failed").map(result => result.property)).toEqual(["exit-range"]);
  });

  it("fail declared-host, and only declared-host, when the adapter reaches for an undeclared capability", async () => {
    const stderr = [record({ oxidevm: "warning", v: 1, kind: "undeclared-capability", member: "process", capabilities: ["process.info", "process.spawn"] }), record({ oxidevm: "error", v: 1, kind: "adapter", fault: "undeclared-capability", capabilities: ["process.info", "process.spawn"], message: "x" })].join("\n");
    const results = await run(COMMAND, { genuine: () => ({ kind: "exited", code: 123 }), stderr });
    expectFailed(results, "declared-host", "process.info, process.spawn");
    expect(results.get("exit-range")?.status).toBe("not-applicable");
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
    expect(statuses(results)).toEqual({ integrity: "passed", "exit-range": "not-applicable", ready: "passed", endpoints: "passed", "duplicate-start": "passed", "snapshot-refused": "passed", "eof-stop": "passed", restart: "passed", "kill-recover": "passed", "declared-host": "passed", "network-direct": "passed", "network-declared": "passed", "network-offline": "not-applicable" });
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

  it("network-offline passes a service that stays ready offline, and fails one that does not", async () => {
    expect(statuses(await run({ ...SERVICE, reach: "internet" }, {}))["network-offline"]).toBe("passed");
    expectFailed(await run({ ...SERVICE, reach: "internet" }, { refused: ["tcp"] }), "network-offline", "stopped serving");
    expectFailed(await run({ ...SERVICE, reach: "vm" }, { genuine: () => new VMError("GUEST_CRASH", "kv crashed") }), "network-offline", "did not become ready");
  });
});
