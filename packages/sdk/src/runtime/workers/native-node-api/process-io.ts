import { VMError } from "../../errors.js";
import { JS_PROCESS_PROTOCOL_VERSION, LinuxError, noValue, operation, protocol, Writer } from "../../js-process/codec.js";
import { files } from "../../js-process/file-operations.js";
import type { LinuxClient } from "../../js-process/transport.js";
import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import type { ProcessRuntimeIO } from "../assistance/process-io.js";
import type { ExceptionOrigin } from "../assistance/node-exceptions.js";
import { NativeChildLaunchFailure, NativeChildrenIO } from "./children.js";
import type { NativeChildSpec } from "../../../js-process-types.js";
import { createNativeFileService, nodeError } from "./files.js";
import { linuxErrnoCode } from "../../linux-errno.js";
import { unavailableNodeApi } from "../assistance/node-capability.js";
import { networkInterfaces } from "./network-interfaces.js";
import { nodeResult } from "../assistance/node-file-operations.js";

/** The Linux transport implements the shared runtime port without broker identities. */
export class NativeProcessIO implements ProcessRuntimeIO {
  readonly copyOpenMode = 10;
  readonly #files;
  readonly #children;
  readonly #halt = new Int32Array(new SharedArrayBuffer(4));
  #activities = 0;
  #waiting: PromiseWithResolvers<undefined> | undefined;
  #schedule: (callback: () => void) => void = queueMicrotask;
  #input: Parameters<ProcessRuntimeIO["setInput"]>[0] | undefined;
  #signals: Parameters<ProcessRuntimeIO["setSignals"]>[0] | undefined;
  readonly #pendingSignals = new Set<"INT" | "TERM" | "HUP">();
  #failed = false;
  #exception: ((error: unknown, origin: ExceptionOrigin, promise?: Promise<unknown>) => boolean) | undefined;
  constructor(readonly client: LinuxClient, readonly events: { post(event: unknown): void; failed(error: unknown): void; externalPending(): boolean; exiting?(code: number): void; signalExit?(signal: 1 | 2 | 9 | 15): void; readonly fork?: { readonly control: MessagePort; readonly executable: string } }, readonly stdio: readonly [number, number, number] = [0, 1, 2]) {
    this.#files = createNativeFileService(client);
    this.#children = new NativeChildrenIO(client, error => this.fail(error), callback => this.#schedule(callback), events.fork);
  }
  setCallbackScheduler(schedule: (callback: () => void) => void): void { this.#schedule = schedule; }
  networkInterfaces(): ReturnType<typeof networkInterfaces> { return networkInterfaces(this.client); }
  signalProcess(pid: number, signal: number): void {
    if (pid <= 0) return unavailableNodeApi("process.kill(process group)");
    if (signal < 0 || signal > 64) throw Object.assign(new Error("kill EINVAL"), { code: "EINVAL", errno: -22, syscall: "kill" });
    try { this.client.sync(operation(62, new Writer().u32(pid).u8(signal), noValue)); }
    catch (error) {
      if (!(error instanceof LinuxError)) throw error;
      const code = linuxErrnoCode(error.errno);
      throw Object.assign(new Error(`kill ${code}`), { code, errno: -error.errno, syscall: "kill" });
    }
  }
  setExceptionHandler(handler: (error: unknown, origin: ExceptionOrigin, promise?: Promise<unknown>) => boolean): void {
    if (this.#exception !== undefined) protocol("Process exception owner is already set"); this.#exception = handler;
  }
  applicationException(error: unknown, origin: ExceptionOrigin = "uncaughtException", promise?: Promise<unknown>, deliver: (handler: () => void) => void = handler => { handler(); }): void {
    this.#schedule(() => { deliver(() => { if (this.#exception?.(error, origin, promise) !== true) this.fail(error); }); });
  }
  setInput(input: Parameters<ProcessRuntimeIO["setInput"]>[0]): void { if (this.#input !== undefined) protocol("Input owner already set"); this.#input = input; }
  setChildEvents(events: Parameters<ProcessRuntimeIO["setChildEvents"]>[0]): void { this.#children.setEvents(events); }
  setSignals(signals: Parameters<ProcessRuntimeIO["setSignals"]>[0]): void {
    if (this.#signals !== undefined) protocol("Signal owner already set"); this.#signals = signals;
    for (const pending of this.#pendingSignals) this.#schedule(() => signals(pending));
    this.#pendingSignals.clear();
  }
  receiveSignal(signal: 1 | 2 | 15): void {
    const name = signal === 1 ? "HUP" : signal === 2 ? "INT" : "TERM", signals = this.#signals;
    if (signals === undefined) this.#pendingSignals.add(name); else this.#schedule(() => signals(name));
  }
  setForkEvents(events: Parameters<ProcessRuntimeIO["setForkEvents"]>[0]): void { this.#children.setForkEvents(events); }
  callSync(input: AssistanceOperation): AssistanceResult {
    try { return input.kind === "spawn" ? this.spawnSync(input) : input.kind === "signal" ? this.#children.signalSync(input) : this.#files.callSync(input); }
    catch (error) { return nodeError(error, input); }
  }
  spawnSync(input: Extract<AssistanceOperation, { kind: "spawn" }>, stdio?: NonNullable<NativeChildSpec["stdio"]>): AssistanceResult {
    try { return this.#children.spawn(input, stdio); }
    catch (error) { return nodeError(error, input); }
  }
  captureSync(...args: Parameters<NonNullable<ProcessRuntimeIO["captureSync"]>>) {
    try { return this.#children.captureSync(...args); }
    catch (error) {
      if (!(error instanceof NativeChildLaunchFailure)) throw error;
      return nodeResult({ ...nodeError(error, args[0]), syscall: error.stage === "path-search" ? "spawn-path-search" : "spawn" });
    }
  }
  async call(input: AssistanceOperation, referenced = true, signal?: AbortSignal): Promise<AssistanceResult> {
    if (signal !== undefined && input.kind !== "socket-connect-local") throw new VMError("FEATURE_NOT_AVAILABLE", "Per-operation cancellation is only qualified for socket connect");
    const release = referenced ? this.retain() : () => undefined;
    try {
      const result = input.kind === "spawn" ? this.#children.spawn(input)
        : input.kind === "stdin" || input.kind === "close-stdin" || input.kind === "signal" || input.kind === "ack" ? await this.#children.call(input) : await this.#files.call(input, signal);
      return await new Promise<AssistanceResult>(resolve => { this.#schedule(() => resolve(result)); });
    } catch (error) { return nodeError(error, input); }
    finally { release(); }
  }
  output(stream: "stdout" | "stderr", bytes: Uint8Array): void {
    const release = this.retain();
    try { for (let offset = 0; offset < bytes.byteLength;) { const part = bytes.subarray(offset, offset + 65536), count = this.client.sync(files.write(this.stdio[stream === "stdout" ? 1 : 2], part)); if (count === 0) protocol("Output made no progress"); offset += count; } }
    finally { release(); }
  }
  retain(): () => void {
    if (this.#failed) throw new VMError("ABORTED", "JavaScript process is retired");
    if (this.#activities >= 256) throw new VMError("QUOTA_EXCEEDED", "JavaScript runtime I/O capacity exhausted");
    this.#activities++; let released = false;
    return () => { if (released) protocol("JavaScript activity was released twice"); released = true; this.#activities--; this.changed(); };
  }
  get hasPending(): boolean { return this.#activities !== 0 || this.events.externalPending(); }
  changed(): void { if (!this.hasPending) { this.#waiting?.resolve(undefined); this.#waiting = undefined; } }
  async drain(): Promise<void> { while (this.hasPending) { this.#waiting ??= Promise.withResolvers<undefined>(); await this.#waiting.promise; } }
  ready(readRequested: Promise<undefined>, closed: AbortSignal): void {
    const isClosed = (): boolean => closed.aborted;
    if (isClosed()) return;
    const stopped = Promise.withResolvers<undefined>();
    const stop = () => stopped.resolve(undefined);
    closed.addEventListener("abort", stop, { once: true });
    const read = async () => {
      try {
        // An unused stdin must leave terminal typeahead in its Linux open description.
        await Promise.race([readRequested, stopped.promise]);
        while (!this.#failed && !isClosed()) {
          let bytes: Uint8Array;
          try { bytes = await this.client.call(files.read(this.stdio[0], 65536), closed); }
          catch (error) {
            if (isClosed() && (error === closed.reason || error instanceof LinuxError && error.errno === 4)) return;
            throw error;
          }
          if (isClosed()) return;
          if (this.#input === undefined) protocol("JavaScript input owner is absent");
          await this.#input(bytes.byteLength === 0 ? null : bytes);
          if (bytes.byteLength === 0) return;
        }
      } finally { closed.removeEventListener("abort", stop); }
    };
    void read().catch((error: unknown) => this.fail(error));
  }
  fail(error: unknown): void {
    if (this.#failed) return; this.#failed = true;
    this.events.failed(error);
  }
  terminate(code: number): never { this.events.exiting?.(code); this.events.post({ version: JS_PROCESS_PROTOCOL_VERSION, type: "exit", code }); return this.halt(); }
  signalExit(signal: Parameters<ProcessRuntimeIO["signalExit"]>[0]): void { if (this.events.signalExit === undefined) protocol("Native signal exit owner is absent"); this.events.signalExit(signal); }
  halt(): never {
    // Bound this private wait so Chromium can finish an external Worker.terminate().
    for (;;) Atomics.wait(this.#halt, 0, 0, 100);
  }
  forkSync(request: Parameters<ProcessRuntimeIO["forkSync"]>[0]): ReturnType<ProcessRuntimeIO["forkSync"]> { return this.#children.forkSync(request); }
  async forkInput(child: number, bytes: Uint8Array<ArrayBuffer> | null): Promise<AssistanceResult> {
    if (bytes === null) return this.call({ kind: "close-stdin", child });
    for (let offset = 0; offset < bytes.length;) {
      const result = await this.call({ kind: "stdin", child, bytes: bytes.subarray(offset) });
      if (result.kind === "error") return result;
      if (result.kind !== "written" || result.count === 0) protocol("Native fork stdin made no progress");
      offset += result.count;
    }
    return { kind: "unit" };
  }
  forkSignal(child: number, signal: Parameters<ProcessRuntimeIO["forkSignal"]>[1]): AssistanceResult {
    const input = { kind: "signal", child, signal } as const;
    try { return this.#children.signalSync(input); } catch (error) { return nodeError(error, input); }
  }
  forkOutputAck(child: number, chunk: number): void { this.#children.ackFork(child, chunk); }
}
