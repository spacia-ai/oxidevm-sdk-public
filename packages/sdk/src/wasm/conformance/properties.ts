import type { ProcessExit, ProcessHandle } from "../../contracts.js";
import { MODULE_EXIT, MODULE_EXIT_REASONS } from "../exit-codes.js";
import type { EndpointDecl } from "../manifest-types.js";
import { MAX_MESSAGE_LENGTH, WASM_TEST_PROPERTIES, type WasmPropertyResult, type WasmPropertyStatus, type WasmTestProperty } from "./report.js";

/** What the properties need to know about the module under test. */
export interface ConformanceSubject {
  readonly kind: "command" | "service";
  readonly endpoints: Readonly<Record<string, EndpointDecl>>;
}

/** A started module. `stderr` resolves with everything it wrote once the process has exited. */
export interface StartedModule {
  readonly process: ProcessHandle;
  readonly stderr: Promise<string>;
}

/** The page's operations, injected so the property logic runs without a browser or an engine. */
export interface ConformancePorts {
  /** Starts the genuine release or a copy with one altered adapter byte; rejects exactly as `spawnModule` does. */
  start(copy: "genuine" | "tampered"): Promise<StartedModule>;
  /** Ends standard input and waits up to `graceMs` before killing, like `stopModule`. */
  stop(process: ProcessHandle, graceMs: number): Promise<ProcessExit>;
  /** Captures a restore point of the VM. */
  capture(): Promise<void>;
  /** Opens and closes one connection to each endpoint; returns the names that could not be reached. */
  probe(endpoints: Readonly<Record<string, EndpointDecl>>): Promise<readonly string[]>;
  now(): number;
}

export interface ConformanceLimits {
  /** How long a command may run before it is killed and fails `exit-range`. */
  readonly commandMs: number;
}

/** A service gets five seconds to drain and ten to close after end of input; the margin absorbs scheduling. */
export const STOP_BUDGET_MS = 20_000;

interface RunnerRecord { readonly oxidevm: string; readonly kind?: string; readonly fault?: string; readonly message?: string; readonly capabilities?: readonly string[] }

/** Undeclared capabilities and the last fault, read from the runner's JSON records on standard error. */
export function runnerDiagnostics(stderr: string): { readonly undeclared: readonly string[]; readonly failure: RunnerRecord | undefined } {
  const undeclared = new Set<string>();
  let failure: RunnerRecord | undefined;
  for (const line of stderr.split("\n")) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const entry = Object.fromEntries(Object.entries(parsed));
    const capabilities = Array.isArray(entry["capabilities"]) ? Array.from<unknown>(entry["capabilities"]).filter((value): value is string => typeof value === "string") : [];
    if (entry["kind"] === "undeclared-capability" || entry["fault"] === "undeclared-capability") for (const capability of capabilities) undeclared.add(capability);
    if (entry["oxidevm"] === "error") {
      failure = {
        oxidevm: "error",
        ...(typeof entry["kind"] === "string" ? { kind: entry["kind"] } : {}),
        ...(typeof entry["fault"] === "string" ? { fault: entry["fault"] } : {}),
        ...(typeof entry["message"] === "string" ? { message: entry["message"] } : {}),
      };
    }
  }
  return { undeclared: [...undeclared].sort(), failure };
}

function clip(text: string): string {
  return text.length <= MAX_MESSAGE_LENGTH ? text : `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

function field(error: unknown, key: "code" | "message"): string | undefined {
  if (typeof error !== "object" || error === null || !(key in error)) return undefined;
  const value: unknown = Reflect.get(error, key);
  return typeof value === "string" ? value : undefined;
}

function reason(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("detail" in error)) return undefined;
  const detail: unknown = Reflect.get(error, "detail");
  if (typeof detail !== "object" || detail === null) return undefined;
  const value: unknown = Reflect.get(detail, "reason");
  return typeof value === "string" ? value : undefined;
}

function explain(error: unknown): string {
  const code = field(error, "code"), message = field(error, "message") ?? "the operation failed";
  return clip(code === undefined ? message : `${code}: ${message}`);
}

function describe(exit: ProcessExit): string {
  return exit.kind === "exited" ? `exit status ${String(exit.code)}` : `signal ${String(exit.signalNumber)}`;
}

async function within<T>(work: Promise<T>, ms: number, onTimeout: () => Promise<void>): Promise<T | "expired"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">(resolve => { timer = setTimeout(() => { resolve("expired"); }, ms); });
  try {
    const outcome = await Promise.race([work, expired]);
    if (outcome === "expired") await onTimeout();
    return outcome;
  } finally { clearTimeout(timer); }
}

class Results {
  private readonly entries = new Map<WasmTestProperty, WasmPropertyResult>();
  private readonly undeclared = new Set<string>();
  constructor(private readonly ports: ConformancePorts) {}

  set(property: WasmTestProperty, status: WasmPropertyStatus, started: number, message?: string): void {
    const elapsedMs = Math.max(0, Math.round(this.ports.now() - started));
    this.entries.set(property, message === undefined || status === "passed" ? { property, status, elapsedMs } : { property, status, message: clip(message), elapsedMs });
  }

  skip(properties: readonly WasmTestProperty[], message: string): void {
    for (const property of properties) if (!this.entries.has(property)) this.set(property, "not-applicable", this.ports.now(), message);
  }

  /** Remembers what one finished run wrote, and returns its runner records. */
  async read(started: StartedModule): Promise<ReturnType<typeof runnerDiagnostics>> {
    const diagnostics = runnerDiagnostics(await started.stderr);
    for (const capability of diagnostics.undeclared) this.undeclared.add(capability);
    return diagnostics;
  }

  finish(): readonly WasmPropertyResult[] {
    const started = this.ports.now();
    if (this.undeclared.size === 0) this.set("declared-host", "passed", started);
    else this.set("declared-host", "failed", started, `the adapter reached for undeclared capabilities: ${[...this.undeclared].sort().join(", ")}; declare them in requires.host`);
    return WASM_TEST_PROPERTIES.map(property => this.entries.get(property) ?? { property, status: "not-applicable", message: "not reached", elapsedMs: 0 });
  }
}

const SERVICE_ONLY: readonly WasmTestProperty[] = ["ready", "endpoints", "duplicate-start", "snapshot-refused", "eof-stop", "restart", "kill-recover"];

async function integrity(subject: ConformanceSubject, ports: ConformancePorts, results: Results): Promise<void> {
  const started = ports.now();
  try {
    const tampered = await ports.start("tampered");
    const exit = await within(tampered.process.exit, STOP_BUDGET_MS, () => tampered.process.kill("SIGKILL").catch(() => undefined));
    if (exit !== "expired" && exit.kind === "exited" && exit.code === MODULE_EXIT.integrity) results.set("integrity", "passed", started);
    else results.set("integrity", "failed", started, `the copy with an altered adapter byte ran: ${exit === "expired" ? "it did not exit" : describe(exit)}`);
    await results.read(tampered);
  } catch (error: unknown) {
    if (reason(error) === MODULE_EXIT_REASONS.integrity) results.set("integrity", "passed", started);
    else results.set("integrity", "failed", started, `the altered copy was not refused for its integrity: ${explain(error)}`);
  }
  if (subject.kind === "service") results.set("exit-range", "not-applicable", ports.now(), "a service is stopped, not run to completion");
}

async function command(ports: ConformancePorts, results: Results, limits: ConformanceLimits): Promise<void> {
  results.skip(SERVICE_ONLY, "a command module runs to completion; the service properties do not apply");
  const started = ports.now();
  let run: StartedModule;
  try { run = await ports.start("genuine"); }
  catch (error: unknown) { results.set("exit-range", "failed", started, `the command did not start: ${explain(error)}`); return; }
  const exit = await within(run.process.exit, limits.commandMs, () => run.process.kill("SIGKILL").catch(() => undefined));
  const { failure } = await results.read(run);
  if (exit === "expired") { results.set("exit-range", "failed", started, `the command did not exit within ${String(limits.commandMs)} ms and was killed`); return; }
  if (exit.kind !== "exited") { results.set("exit-range", "failed", started, `the command ended by ${describe(exit)}`); return; }
  if (exit.code <= MODULE_EXIT.adapterMax) { results.set("exit-range", "passed", started); return; }
  if (failure?.fault === "undeclared-capability") { results.set("exit-range", "not-applicable", started, "the adapter faulted on an undeclared capability; see declared-host"); return; }
  const detail = failure === undefined ? describe(exit) : `${describe(exit)}, ${failure.fault ?? failure.kind ?? "runner"} fault: ${failure.message ?? ""}`;
  results.set("exit-range", "failed", started, `the command must exit 0-${String(MODULE_EXIT.adapterMax)}; it ended with ${detail}`);
}

async function stoppedCleanly(ports: ConformancePorts, run: StartedModule, results: Results): Promise<string | undefined> {
  const exit = await ports.stop(run.process, STOP_BUDGET_MS);
  await results.read(run);
  if (exit.kind === "exited" && exit.code === 0) return undefined;
  return exit.kind === "signaled" ? `it did not exit within ${String(STOP_BUDGET_MS / 1000)} s of end of input and was killed` : `it exited with ${describe(exit)} after end of input`;
}

/**
 * Starts the service again, checks its endpoints and stops it; returns why it did not serve, if it did not.
 * How it stops is `eof-stop`'s concern alone, so one broken rule fails one property.
 */
async function cycle(subject: ConformanceSubject, ports: ConformancePorts, results: Results): Promise<string | undefined> {
  const run = await ports.start("genuine");
  const refused = await ports.probe(subject.endpoints);
  await stoppedCleanly(ports, run, results);
  return refused.length > 0 ? `no connection to ${refused.join(", ")}` : undefined;
}

async function service(subject: ConformanceSubject, ports: ConformancePorts, results: Results): Promise<void> {
  let started = ports.now(), first: StartedModule;
  try { first = await ports.start("genuine"); results.set("ready", "passed", started); }
  catch (error: unknown) {
    results.set("ready", "failed", started, `the service did not become ready: ${explain(error)}`);
    results.skip(SERVICE_ONLY, "the service never became ready");
    return;
  }
  started = ports.now();
  const refused = await ports.probe(subject.endpoints);
  results.set("endpoints", refused.length === 0 ? "passed" : "failed", started, `no connection to ${refused.join(", ")}`);
  started = ports.now();
  try {
    const second = await ports.start("genuine");
    await stoppedCleanly(ports, second, results);
    results.set("duplicate-start", "failed", started, "a second instance started beside the first; it must be refused with exit status 124");
  } catch (error: unknown) {
    if (field(error, "code") === "QUOTA_EXCEEDED") results.set("duplicate-start", "passed", started);
    else results.set("duplicate-start", "failed", started, `the second start failed for another reason: ${explain(error)}`);
  }
  const snapshotStarted = ports.now();
  let refusedWhileRunning: string | undefined = "a restore point was captured while the module ran";
  try { await ports.capture(); }
  catch (error: unknown) { refusedWhileRunning = field(error, "code") === "FEATURE_NOT_AVAILABLE" ? undefined : `capturing while it ran failed for another reason: ${explain(error)}`; }
  started = ports.now();
  const stopFailure = await stoppedCleanly(ports, first, results);
  results.set("eof-stop", stopFailure === undefined ? "passed" : "failed", started, stopFailure ?? "");
  let afterStop: string | undefined;
  try { await ports.capture(); } catch (error: unknown) { afterStop = `capturing after the stop failed: ${explain(error)}`; }
  const snapshotFailure = refusedWhileRunning ?? afterStop;
  results.set("snapshot-refused", snapshotFailure === undefined ? "passed" : "failed", snapshotStarted, snapshotFailure ?? "");
  started = ports.now();
  try {
    const failure = await cycle(subject, ports, results);
    results.set("restart", failure === undefined ? "passed" : "failed", started, failure ?? "");
  } catch (error: unknown) { results.set("restart", "failed", started, `the second start failed: ${explain(error)}`); }
  started = ports.now();
  try {
    const victim = await ports.start("genuine");
    await victim.process.kill("SIGKILL");
    await victim.process.exit;
    await results.read(victim);
    const failure = await cycle(subject, ports, results);
    results.set("kill-recover", failure === undefined ? "passed" : "failed", started, failure ?? "");
  } catch (error: unknown) { results.set("kill-recover", "failed", started, `starting after a kill failed: ${explain(error)}`); }
}

/** Runs every property of the catalog against one module and returns them in catalog order. */
export async function runProperties(subject: ConformanceSubject, ports: ConformancePorts, limits: ConformanceLimits): Promise<readonly WasmPropertyResult[]> {
  const results = new Results(ports);
  await integrity(subject, ports, results);
  if (subject.kind === "command") await command(ports, results, limits);
  else await service(subject, ports, results);
  return results.finish();
}
