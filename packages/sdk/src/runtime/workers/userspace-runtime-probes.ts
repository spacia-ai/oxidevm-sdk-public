import { decodeGuestProcessWireEvent } from "../protocol/agent.js";
import { PROTOCOL_VERSION } from "../protocol/common.js";
import {
  decodeRuntimeProbeRequest, encodeRuntimeProbeReport, encodeRuntimeProbeTake, parseRuntimeProbeOutput,
  RUNTIME_PROBE_DEADLINE_MS, RUNTIME_PROBE_MAX_OUTPUT,
  decodeAccelerationBackgroundPending, encodeAccelerationBackgroundPoll,
  type RuntimeProbeEnding, type RuntimeProbeReport,
} from "../js-process/runtime-probe.js";

/** "unavailable": the probe's port broke, which says nothing about the binary. */
export interface RuntimeProbeRun { readonly stdout: Uint8Array; readonly ending: RuntimeProbeEnding | "unavailable" }
export interface RuntimeProbePorts {
  /** Rust's command operations, through the runtime instance. */
  command(bytes: Uint8Array<ArrayBuffer>): Uint8Array;
  /** Runs `path` in Linux; rejects when the process cannot start. */
  run(sha256: string, path: string, signal: AbortSignal): Promise<RuntimeProbeRun>;
  /** Services Rust's pending knowledge change even after the last guest process ended. */
  settled?(): void;
  failed?(error: unknown): void;
}
const MAX_RUNNING = 2;

/**
 * ADR 0026, 1.5: runs the runtime probes Rust asks for, each in Linux on a fixed script, and
 * hands Rust what they printed. It decides nothing: Rust checks the build, remembers it and asks
 * for the table to be persisted. A save or suspend ends running probes without a verdict, and
 * none start until it ends; so does a probe that could not start, which says nothing about the
 * binary (a passing process limit), and a later launch asks again.
 */
export class UserspaceRuntimeProbes {
  readonly #running = new Map<string, { readonly controller: AbortController; readonly done: Promise<void> }>();
  #suspended = false;
  #disposed = false;
  #background: ReturnType<typeof setInterval> | undefined;
  #backgroundDisabled = false;
  constructor(readonly ports: RuntimeProbePorts, readonly limit = MAX_RUNNING) {}

  pump(): void {
    if (this.#disposed || this.#suspended) return;
    if (!this.#backgroundDisabled) this.#background ??= setInterval(() => {
      if (this.#disposed || this.#suspended) return;
      try {
        const pending = decodeAccelerationBackgroundPending(this.ports.command(encodeAccelerationBackgroundPoll(BigInt(Math.floor(performance.now())))));
        if (pending === "disabled") { this.#backgroundDisabled = true; this.#stopBackground(); }
        else if (pending) this.ports.settled?.();
      } catch (error) { this.ports.failed?.(error); }
    }, 500);
    while (this.#running.size < this.limit) {
      const request = decodeRuntimeProbeRequest(this.ports.command(encodeRuntimeProbeTake()));
      if (request === undefined) return;
      const controller = new AbortController(), { sha256 } = request;
      const done = this.#probe(sha256, request.path, controller.signal).finally(() => {
        this.#running.delete(sha256);
        if (!this.#disposed) {
          try { this.ports.settled?.(); } catch (error) { this.ports.failed?.(error); }
        }
      });
      this.#running.set(sha256, { controller, done });
    }
  }

  async #probe(sha256: string, path: string, signal: AbortSignal): Promise<void> {
    let report: RuntimeProbeReport = { kind: "cancelled" };
    try {
      const run = await this.ports.run(sha256, path, signal);
      if (!signal.aborted && run.ending !== "unavailable") report = parseRuntimeProbeOutput(run.stdout, run.ending);
    } catch { /* It could not start: cancelled. */ }
    if (this.#disposed) return;
    try { this.ports.command(encodeRuntimeProbeReport(sha256, report)); }
    catch { /* A restored instance no longer knows the probe; a later launch asks again. */ }
  }

  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.all(Array.from(this.#running.values(), entry => entry.done));
  }

  async suspend(): Promise<void> {
    this.#suspended = true;
    this.#stopBackground();
    for (const entry of this.#running.values()) entry.controller.abort();
    await this.idle();
  }

  resume(): void { this.#suspended = false; this.pump(); }

  dispose(): void {
    this.#disposed = true;
    this.#suspended = true;
    this.#stopBackground();
    for (const entry of this.#running.values()) entry.controller.abort();
  }

  #stopBackground(): void {
    if (this.#background !== undefined) clearInterval(this.#background);
    this.#background = undefined;
  }
}

/** Reads a probe process's port: stdout up to the bound, each chunk acknowledged as it arrives,
 * until the process exits. A deadline, an overflow or a cancellation kills it first. */
export function collectRuntimeProbe(port: MessagePort, sessionId: number, kill: () => void, signal: AbortSignal, deadline = RUNTIME_PROBE_DEADLINE_MS): Promise<RuntimeProbeRun> {
  return new Promise(resolve => {
    const chunks: Uint8Array[] = [];
    let size = 0, killing = false, finished = false, reason: "timeout" | "overflow" | undefined;
    let stopping: ReturnType<typeof setTimeout> | undefined;
    const halt = (why: "timeout" | "overflow" | undefined) => {
      if (killing) return;
      killing = true; reason = why;
      try { kill(); } catch { finish("unavailable"); }
      if (!finished) stopping = setTimeout(() => { finish(reason ?? "unavailable"); }, 1_000);
    };
    const unavailable = () => {
      if (finished) return;
      if (!killing) { killing = true; try { kill(); } catch { /* The transport is already lost. */ } }
      finish("unavailable");
    };
    const onAbort = () => { halt(undefined); };
    const timer = setTimeout(() => { halt("timeout"); }, deadline);
    function finish(ending: RuntimeProbeRun["ending"]): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer); if (stopping !== undefined) clearTimeout(stopping);
      signal.removeEventListener("abort", onAbort);
      port.onmessage = null; port.onmessageerror = null; port.close();
      const stdout = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { stdout.set(chunk, offset); offset += chunk.byteLength; }
      resolve({ stdout, ending });
    }
    port.onmessage = (event: MessageEvent<unknown>) => {
      let message: ReturnType<typeof decodeGuestProcessWireEvent>;
      try { message = decodeGuestProcessWireEvent(event.data); } catch { unavailable(); return; }
      if (message.sessionId !== sessionId) { unavailable(); return; }
      if (message.type === "stdout" || message.type === "stderr") {
        try { port.postMessage({ version: PROTOCOL_VERSION, sessionId, type: "output-ack", sequence: message.sequence }); }
        catch { unavailable(); return; }
        if (message.type === "stdout" && !killing) {
          if (size + message.data.byteLength > RUNTIME_PROBE_MAX_OUTPUT) halt("overflow");
          else { chunks.push(message.data); size += message.data.byteLength; }
        }
        return;
      }
      finish(message.type === "exit" ? reason ?? message.termination : "unavailable");
    };
    port.onmessageerror = unavailable;
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
