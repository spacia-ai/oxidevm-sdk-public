import { exactKeys, integer, record } from "../../decode.js";
import { decodeSerializedError, deserializeError, VMError } from "../../errors.js";
import { encodeCommandExit, encodeCommandIo, type UserspaceCommandHostRequest } from "../../userspace-command-abi.js";
import { decodeJSCompletion, encodeJSRequest, type JSCompletion } from "../../js-process/native-abi.js";
import { JS_MAILBOX_BYTES, JS_MAX_OPERATION, JS_PROCESS_PROTOCOL_VERSION, jsMailboxAttention, protocol, Writer } from "../../js-process/codec.js";
import { createAttentionCounter, type AttentionCounter, type AttentionWatch } from "../../host-attention.js";
import { AttentionNotices, browserAttentionNoticesWorker, type AttentionNoticesWorker } from "../attention-notices.js";
import { callUserspaceU32 as call } from "../userspace-exports.js";
import { readFileRecord } from "../userspace-files.js";
import { localWorkerProcess, isolatedWorkerProcess, type WorkerProcess } from "./worker-process.js";
import { writeWorkerMailbox } from "../../js-process/worker-mailbox.js";
import { decodeLateFailure, decodeLateFailureNotice, encodeLateFailureReport, lateFailureOf, lateFailureSentence, type LateFailure, type LateFailureNotice } from "../../js-process/late-failure.js";

interface Runtime { readonly instance: WebAssembly.Instance; readonly memory: WebAssembly.Memory }
interface Ports {
  readonly runtime: Runtime; readonly interceptor?: string; readonly nativeExecution?: MessagePort;
  /** Watches a process's request count, so the execution worker's guest slices end to receive its requests. */
  readonly attention?: { watch(counter: AttentionCounter): AttentionWatch };
  /** Starts the worker that counts a native process's notices (default: the browser's). */
  readonly startNotices?: () => AttentionNoticesWorker;
  /** Persists the record Rust returned for a late failure and announces it (ADR 0026). */
  readonly knowledge?: { remember(notice: LateFailureNotice, failure: LateFailure): void };
  active(): boolean; wake(): void;
}
/** How the execution worker learns that one process posted Linux requests it has not received yet. */
interface TaskAttention { delivered(): void; close(): void; readonly noticePort: MessagePort | null }
const NO_ATTENTION: TaskAttention = { delivered: () => {}, close: () => {}, noticePort: null };
interface Running {
  readonly request: UserspaceCommandHostRequest; readonly worker: WorkerProcess; readonly port: MessagePort;
  readonly header: Int32Array; readonly body: Uint8Array;
  readonly pending: Map<number, boolean>; sequence: number; closing: boolean; stop(): void;
}

function esbuildWorker(): string {
  const url = new URL("../../../../assets/compilers/esbuild.worker.js", import.meta.url);
  url.searchParams.set("module", new URL("../../../../assets/compilers/esbuild.wasm", import.meta.url).href);
  return url.href;
}

/** Worker lifetime and transport only. Rust owns process identity and Linux services. */
export class JsProcessWorkers {
  readonly #running = new Map<bigint, Running>();
  readonly #launches = new Map<number, string>();
  #notices: AttentionNotices | undefined;
  #token = 0;
  constructor(readonly ports: Ports) {}
  register(worker: string): number {
    const url = new URL(worker);
    if (url.origin !== self.location.origin || !["http:", "https:"].includes(url.protocol) || !self.crossOriginIsolated) throw new VMError("FEATURE_NOT_AVAILABLE", "JS processes require same-origin workers and cross-origin isolation");
    const token = integer(++this.#token, "worker launch token", 1, 0xffff_ffff); this.#launches.set(token, url.href); return token;
  }
  retireLaunch(token: number): void { this.#launches.delete(token); }
  #native(name: string, bytes?: Uint8Array): Uint8Array<ArrayBuffer> {
    const { runtime } = this.ports;
    if (bytes !== undefined) {
      if (call(runtime.instance, "oxidevm_userspace_staging_resize", bytes.byteLength) !== 0) protocol("JS staging allocation failed");
      new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), bytes.byteLength).set(bytes);
    }
    if (call(runtime.instance, name, ...(bytes === undefined ? [] : [bytes.byteLength])) !== 0) protocol(`Native JS operation ${name} failed`);
    return readFileRecord(runtime);
  }
  #active(request: UserspaceCommandHostRequest): boolean { return this.ports.active() && this.#native("oxidevm_userspace_command", encodeCommandIo(request, 0))[0] === 1; }
  assertIdle(): void {
    if (this.#native("oxidevm_userspace_command", encodeCommandIo({ generation: 0n, id: 0n }, 4))[0] !== 0) throw new VMError("FEATURE_NOT_AVAILABLE", "Snapshots and suspend cannot capture a live JS process", { reason: "js-process-active" });
  }
  retireInactive(): void {
    for (const task of this.#running.values()) if (!this.#active(task.request)) task.stop();
  }
  reconcile(): void {
    this.retireInactive();
    for (let count = 0; count < 40 && this.ports.active(); count++) {
      const bytes = this.#native("oxidevm_userspace_js_next"); if (bytes.byteLength === 0) break;
      const reply = decodeJSCompletion(bytes), task = this.#running.get(reply.id);
      if (task === undefined || task.request.generation !== reply.generation) continue;
      if (task.request.pid !== reply.pid) protocol("JS completion process mismatch");
      this.#reply(task, reply);
    }
    this.retireInactive();
  }
  dispose(): void { for (const task of this.#running.values()) task.stop(); this.#launches.clear(); this.#notices?.dispose(); this.#notices = undefined; }
  /** A same-origin worker counts its posted requests in the shared mailbox. A native process's broker,
   * on another origin, sends one notice per request to the notices worker, which counts them here. */
  #attention(request: UserspaceCommandHostRequest, mailbox: SharedArrayBuffer): TaskAttention {
    const watcher = this.ports.attention;
    if (watcher === undefined) return NO_ATTENTION;
    if (request.program.kind !== "native-node") {
      const watch = watcher.watch(jsMailboxAttention(mailbox));
      return { delivered: () => { watch.delivered(); }, close: () => { watch.close(); }, noticePort: null };
    }
    const counter = createAttentionCounter();
    const notices = counter === null ? undefined : (this.#notices ??= new AttentionNotices(this.ports.startNotices ?? browserAttentionNoticesWorker)).open(counter);
    if (counter === null || notices === undefined) return NO_ATTENTION;
    const watch = watcher.watch(counter);
    return { delivered: () => { watch.delivered(); }, close: () => { watch.close(); notices.release(); }, noticePort: notices.port };
  }
  #exit(request: UserspaceCommandHostRequest, code: number): void {
    if (!this.#active(request)) return;
    const bytes = encodeCommandExit(request, code), { runtime } = this.ports;
    if (call(runtime.instance, "oxidevm_userspace_staging_resize", bytes.byteLength) !== 0) protocol("JS exit staging failed");
    new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), bytes.byteLength).set(bytes);
    if (call(runtime.instance, "oxidevm_userspace_host_complete", bytes.byteLength) !== 0) protocol("JS exit completion failed");
    this.ports.wake();
  }
  /** Rust records a late failure of a live launch; the next run of the program uses Linux. */
  #remember(request: UserspaceCommandHostRequest, failure: LateFailure): boolean {
    if (!this.#active(request)) return false;
    let notice: LateFailureNotice;
    try { notice = decodeLateFailureNotice(this.#native("oxidevm_userspace_command", encodeLateFailureReport(request, failure))); }
    catch { return false; }
    this.ports.knowledge?.remember(notice, failure);
    return true;
  }
  #diagnostic(request: UserspaceCommandHostRequest, sequence: number, error: unknown): void {
    if (!this.#active(request)) return;
    const failure = lateFailureOf(error);
    const message = error instanceof Error ? error.message.slice(0, 1024) : "unknown worker failure";
    const line = failure !== undefined && this.#remember(request, failure) ? lateFailureSentence(failure) : `JS process failed: ${message}`;
    const payload = new Writer().u64(2).blob(new TextEncoder().encode(`${line}\n`)).finish();
    // This independent write uses the same Rust service. Its result is retired with the exit.
    // Never retry a failed or ambiguous application operation.
    try { this.#native("oxidevm_userspace_js_submit", encodeJSRequest(request, sequence, 1, payload)); } catch { /* Failure reporting cannot prevent retirement. */ }
  }
  #reply(task: Running, reply: JSCompletion): void {
    const sync = task.pending.get(reply.sequence); if (sync === undefined) protocol("Unexpected JS completion sequence"); task.pending.delete(reply.sequence);
    if (sync) {
      writeWorkerMailbox(task.header, task.body, reply.sequence, reply.errno, reply.value, reply.payload);
    } else task.port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "reply", sequence: reply.sequence, errno: reply.errno, value: reply.value, payload: reply.payload });
  }
  #request(task: Running, input: unknown): void {
    const value = record(input, "JS Linux request"); exactKeys(value, ["version", "type", "sequence", "sync", "operation", "payload"]);
    if (value["version"] !== JS_PROCESS_PROTOCOL_VERSION || value["type"] !== "request" || typeof value["sync"] !== "boolean" || !(value["payload"] instanceof Uint8Array) || value["payload"].byteLength > 16 * 1024 ** 2 + 128) protocol("Malformed JS Linux request");
    if (task.request.program.kind === "native-node" && value["sync"]) protocol("Native shared memory must remain on its execution origin");
    const sequence = integer(value["sequence"], "JS request sequence", 1, 0x7fff_ffff), operation = integer(value["operation"], "JS operation", 0, JS_MAX_OPERATION);
    if (sequence !== task.sequence + 1 || task.closing || task.pending.size >= 38) protocol("Invalid JS operation sequence or lifecycle");
    task.sequence = sequence; task.pending.set(sequence, value["sync"]);
    const response = this.#native("oxidevm_userspace_js_submit", encodeJSRequest(task.request, sequence, operation, value["payload"]));
    if (response.byteLength !== 4) protocol("Invalid JS admission result");
    const errno = new DataView(response.buffer).getUint32(0, true);
    if (errno !== 0) this.#reply(task, { ...task.request, sequence, errno, value: 0n, payload: new Uint8Array() });
    this.reconcile(); this.ports.wake();
  }
  run(request: UserspaceCommandHostRequest, signal: AbortSignal): Promise<void> {
    if (!this.ports.active() || signal.aborted) return Promise.resolve();
    let worker: WorkerProcess, mailbox: SharedArrayBuffer, attention: TaskAttention = NO_ATTENTION;
    try {
      const url = request.program.kind === "typescript" ? this.ports.interceptor : request.program.kind === "esbuild" ? esbuildWorker() : request.program.kind === "worker" ? this.#launches.get(Number(request.program.token)) : undefined;
      if (request.program.kind === "worker") this.#launches.delete(Number(request.program.token));
      mailbox = new SharedArrayBuffer(request.program.kind === "native-node" ? 16 : JS_MAILBOX_BYTES);
      if (request.program.kind === "native-node") {
        if (this.ports.nativeExecution === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Native execution origin is unavailable");
        attention = this.#attention(request, mailbox);
        worker = isolatedWorkerProcess(this.ports.nativeExecution, request.pid, attention.noticePort);
      } else {
        if (url === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "JS worker launch is unavailable");
        worker = localWorkerProcess(url, request.pid);
        attention = this.#attention(request, mailbox);
      }
    } catch (error) { attention.close(); this.#diagnostic(request, 1, error); this.#exit(request, 125); return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel(); let finished = false;
      const stop = () => {
        if (finished) return; finished = true; attention.close(); worker.stop();
        // Wake a synchronous mailbox wait after requesting worker termination.
        Atomics.notify(task.header, 0);
        channel.port1.close(); signal.removeEventListener("abort", stop); this.#running.delete(request.id); resolve();
      };
      const fatal = (error: unknown) => { reject(error instanceof Error ? error : new VMError("VM_FAULT", "JS process transport failed")); stop(); };
      const fail = (error: unknown) => {
        if (finished || task.closing) return;
        task.closing = true; this.#diagnostic(request, ++task.sequence, error); worker.stop();
        try { this.#exit(request, 125); this.reconcile(); } catch (failure) { fatal(failure); }
      };
      const task: Running = { request, worker, port: channel.port1, header: new Int32Array(mailbox, 0, 4), body: new Uint8Array(mailbox, 16), pending: new Map(), sequence: 0, closing: false, stop };
      channel.port1.onmessage = event => {
        attention.delivered();
        try { if (!finished && !task.closing && this.#active(request)) this.#request(task, event.data); } catch (error) { fail(error); }
      };
      channel.port1.onmessageerror = () => { attention.delivered(); fail(new VMError("PROTOCOL_ERROR", "JS Linux request could not be decoded")); };
      channel.port1.start();
      worker.listen(input => {
        if (finished || task.closing) return;
        try {
          const value = record(input, "JS process result"); if (value["version"] !== JS_PROCESS_PROTOCOL_VERSION) protocol("JS process version mismatch");
          if (value["type"] === "failure") { exactKeys(value, ["version", "type", "error"]); throw deserializeError(decodeSerializedError(value["error"])); }
          // The process printed its own explanation and exits; Rust remembers the program.
          if (value["type"] === "late-failure") { exactKeys(value, ["version", "type", "failure"]); this.#remember(request, decodeLateFailure(value["failure"])); return; }
          exactKeys(value, ["version", "type", "code"]); if (value["type"] !== "exit") protocol("Unknown JS process result");
          const code = integer(value["code"], "JS exit status", 0, 255);
          task.closing = true; this.#exit(request, code); this.reconcile();
        } catch (error) { if (task.closing) fatal(error); else fail(error); }
      }, fail);
      signal.addEventListener("abort", stop, { once: true }); this.#running.set(request.id, task);
      try { worker.send({ version: JS_PROCESS_PROTOCOL_VERSION, type: "start", port: channel.port2,
        ...(request.program.kind === "native-node" ? {} : { mailbox }),
        ...(request.program.kind === "native-node" ? { program: request.program, generation: request.generation, id: request.id } : {}) }, [channel.port2]); }
      catch (error) { fail(error); }
    });
  }
}
