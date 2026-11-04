import { exactKeys, integer, record } from "../../decode.js";
import { decodeSerializedError, deserializeError, VMError } from "../../errors.js";
import { decodeCommandNotice, encodeCommandExit, encodeCommandIo, encodeCommandNoticeRequest, encodeCommandSignalExit, type ModuleCommandProgram, type UserspaceCommandHostRequest } from "../../userspace-command-abi.js";
import { decodeJSCompletion, encodeJSRequest, type JSCompletion } from "../../js-process/native-abi.js";
import { JS_MAILBOX_BYTES, JS_MAX_OPERATION, JS_PROCESS_PROTOCOL_VERSION, jsMailboxAttention, protocol, Writer } from "../../js-process/codec.js";
import { createAttentionCounter, type AttentionCounter, type AttentionWatch } from "../../host-attention.js";
import { AttentionNotices, browserAttentionNoticesWorker, type AttentionNoticesWorker } from "../attention-notices.js";
import { callUserspaceU32 as call } from "../userspace-exports.js";
import { readFileRecord } from "../userspace-files.js";
import { localWorkerProcess, isolatedWorkerProcess, type WorkerProcess } from "./worker-process.js";
import { writeWorkerMailbox } from "../../js-process/worker-mailbox.js";
import { decodeLateFailure, decodeLateFailureNotice, encodeLateFailureReport, lateFailureOf, lateFailureSentence, type LateFailure, type LateFailureNotice } from "../../js-process/late-failure.js";
import type { RunnerCommandLaunch, RunnerHostLaunch, RunnerLaunch, RunnerVerifiedFile } from "../../js-process/launch.js";
import { MODULE_BROKER_VERSION } from "../../protocol/module-frame.js";
import { isolationUnavailable } from "../../protocol/module-isolation.js";
import { copyKey, type CopyKey } from "../../protocol/userspace-module-files.js";
import { parseLaunchArgument } from "../../../wasm/runner/descriptor.js";
import { moduleReach, moduleReachCode } from "../../../wasm/reach.js";
import { tlsPin } from "../../../wasm/net/tls-file.js";
import { isTrappableSignal } from "../../js-process/signals.js";
import { TaskSignals } from "./task-signals.js";
import type { ModuleLease } from "./module-leases.js";

interface Runtime { readonly instance: WebAssembly.Instance; readonly memory: WebAssembly.Memory }
interface Ports {
  readonly runtime: Runtime; readonly interceptor?: string; readonly nativeExecution?: MessagePort;
  /** ADR 0028: the VM's module frame broker, once the page has opened the frame; every module process runs behind it. */
  readonly moduleFrame?: () => MessagePort | undefined;
  /** Watches a process's request count, so the execution worker's guest slices end to receive its requests. */
  readonly attention?: { watch(counter: AttentionCounter): AttentionWatch };
  /** Starts the worker that counts a native process's notices (default: the browser's). */
  readonly startNotices?: () => AttentionNoticesWorker;
  /** Persists the record Rust returned for a late failure and announces it (ADR 0026). */
  readonly knowledge?: { remember(notice: LateFailureNotice, failure: LateFailure): void };
  /** ADR 0027: the VM's registration owner, which resolves a module command to the copies its registration verified. */
  readonly commands?: { launch(program: ModuleCommandProgram): RunnerCommandLaunch | undefined };
  active(): boolean; wake(): void;
}
/** How the execution worker learns that one process posted Linux requests it has not received yet. */
interface TaskAttention { delivered(): void; close(): void; readonly noticePort: MessagePort | null }
const NO_ATTENTION: TaskAttention = { delivered: () => {}, close: () => {}, noticePort: null };
/** Where a process's worker runs: a same-origin worker of the page, the native execution origin, or the module frame. */
type Isolation = "local" | "native" | "module";
interface Running {
  readonly request: UserspaceCommandHostRequest; readonly worker: WorkerProcess; readonly port: MessagePort; readonly isolation: Isolation;
  readonly header: Int32Array; readonly body: Uint8Array;
  /** JS process protocol 5: the signal buffer of a local process (engine ADR 0027); a broker owns an isolated one's. */
  readonly signals: TaskSignals | undefined;
  readonly pending: Map<number, boolean>; sequence: number; closing: boolean; stop(): void;
  /** Ends the process with status 125 and a diagnostic line, as a failed worker does. */
  fail(error: unknown): void;
}
/** Notices one reconcile takes at most; the rest stay pending work for the next. */
const NOTICES_PER_RECONCILE = 64;

/** A module launch as it crosses into the frame: the copies without compiled modules, which never cross the frame
 * boundary, and each artifact's copy key, so the broker compiles each core module once per VM (ADR 0028). */
function crossing(launch: RunnerLaunch): { readonly launch: RunnerLaunch; readonly keys: Readonly<Record<string, CopyKey>>; readonly tls: CopyKey | null; readonly reach: number } {
  const parsed = parseLaunchArgument(launch.descriptor), pins = parsed.artifacts, keys: Record<string, CopyKey> = {}, artifacts: Record<string, RunnerVerifiedFile> = {};
  for (const [name, file] of Object.entries(launch.artifacts)) {
    const pin = pins[name];
    if (pin === undefined) protocol("A module copy is not pinned by its launch description");
    keys[name] = copyKey(pin); artifacts[name] = { blob: file.blob, module: null };
  }
  // The broker checks the reach first (ADR 0029, defence in depth) and compiles the TLS module once per frame by its key.
  const reach = moduleReach(parsed.manifest.requires.host);
  return { launch: { ...launch, artifacts, tls: launch.tls === null ? null : { blob: launch.tls.blob, module: null } }, keys, tls: launch.tls === null ? null : copyKey(tlsPin()), reach: moduleReachCode(reach) };
}

function esbuildWorker(): string {
  const url = new URL("../../../../assets/compilers/esbuild.worker.js", import.meta.url);
  url.searchParams.set("module", new URL("../../../../assets/compilers/esbuild.wasm", import.meta.url).href);
  return url.href;
}

/** Worker lifetime and transport only. Rust owns process identity and Linux services. */
export class JsProcessWorkers {
  readonly #running = new Map<bigint, Running>();
  /** Registered workers by token, with the module runner's launch when `spawnModule` registered one. */
  readonly #launches = new Map<number, { readonly url: string | undefined; readonly launch: RunnerHostLaunch | undefined; readonly lease: ModuleLease | undefined }>();
  #notices: AttentionNotices | undefined;
  #token = 0;
  constructor(readonly ports: Ports) {}
  register(worker: string): number {
    const url = new URL(worker);
    if (url.origin !== self.location.origin || !["http:", "https:"].includes(url.protocol)) throw new VMError("FEATURE_NOT_AVAILABLE", "JS processes require same-origin workers and cross-origin isolation");
    return this.#registered(url.href, undefined, undefined);
  }
  /** `spawnModule`'s start (ADR 0028): the SDK's module runner, in the module frame, with the copies the VM's store
   * verified, and the workspace lease of an exclusive service, which ends with the process. */
  registerModule(launch: RunnerHostLaunch, lease?: ModuleLease): number { return this.#registered(undefined, launch, lease); }
  #registered(url: string | undefined, launch: RunnerHostLaunch | undefined, lease: ModuleLease | undefined): number {
    try {
      if (!self.crossOriginIsolated) throw new VMError("FEATURE_NOT_AVAILABLE", "JS processes require same-origin workers and cross-origin isolation");
      const token = integer(++this.#token, "worker launch token", 1, 0xffff_ffff); this.#launches.set(token, { url, launch, lease }); return token;
    } catch (error) { lease?.release(); throw error; }
  }
  retireLaunch(token: number): void { this.#launches.get(token)?.lease?.release(); this.#launches.delete(token); }
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
    // Notices before completions: a request a caught signal interrupted reaches a worker whose signal buffer says why.
    this.#signalNotices();
    for (let count = 0; count < 40 && this.ports.active(); count++) {
      const bytes = this.#native("oxidevm_userspace_js_next"); if (bytes.byteLength === 0) break;
      const reply = decodeJSCompletion(bytes), task = this.#running.get(reply.id);
      if (task === undefined || task.request.generation !== reply.generation) continue;
      if (task.request.pid !== reply.pid) protocol("JS completion process mismatch");
      this.#reply(task, reply);
    }
    this.retireInactive();
  }
  /** ADR 0028: the VM's module frame is gone. Its module processes end with status 125; others run on. */
  moduleFrameLost(): void {
    for (const task of [...this.#running.values()]) if (task.isolation === "module") task.fail(isolationUnavailable("module-frame-lost", "The module frame is gone"));
  }
  dispose(): void { for (const task of this.#running.values()) task.stop(); for (const entry of this.#launches.values()) entry.lease?.release(); this.#launches.clear(); this.#notices?.dispose(); this.#notices = undefined; }
  /** Command operation 6 (ADR 0027): each signal Rust caught for a worker sets its words, and the worker gets one nudge. */
  #signalNotices(): void {
    for (const task of this.#running.values()) task.signals?.offerInterrupts();
    const nudged = new Set<Running>();
    for (let count = 0; count < NOTICES_PER_RECONCILE && this.ports.active(); count++) {
      const notice = decodeCommandNotice(this.#native("oxidevm_userspace_command", encodeCommandNoticeRequest()));
      if (notice === null) break;
      const task = this.#running.get(notice.id);
      if (task === undefined || task.request.generation !== notice.generation || task.closing) continue;
      if (task.request.pid !== notice.pid) protocol("Signal notice process mismatch");
      // A module process's broker owns its signal buffer: the notice travels on the service port, ahead of any completion.
      const details = { code: notice.code, sender: notice.sender, uid: notice.uid, value: notice.value };
      if (task.isolation === "module") { task.port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal-notice", signal: notice.signal, interrupt: notice.interrupt, ...details }); continue; }
      if (task.signals === undefined) protocol("A native JS process has no host signal dispositions");
      task.signals.deliver({ signal: notice.signal, interrupt: notice.interrupt, details }); nudged.add(task);
    }
    for (const task of nudged) task.port.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal" });
  }
  /** The worker ends its process killed by a signal (command operation 7); Rust reports the exit, so none follows. */
  #signaled(task: Running, value: Readonly<Record<string, unknown>>): void {
    exactKeys(value, ["version", "type", "signal"]);
    const signal = value["signal"];
    if (value["version"] !== JS_PROCESS_PROTOCOL_VERSION || !isTrappableSignal(signal) || task.isolation === "native") protocol("Malformed JS process signal exit");
    task.closing = true;
    if (this.#native("oxidevm_userspace_command", encodeCommandSignalExit(task.request, signal)).byteLength !== 0) protocol("Invalid JS process signal exit result");
    this.reconcile(); this.ports.wake();
  }
  /** A same-origin worker counts its posted requests in the shared mailbox. A broker on another origin (the native
   * execution origin, or the module frame) sends one notice per request to the notices worker, which counts them here. */
  #attention(isolation: Isolation, mailbox: SharedArrayBuffer): TaskAttention {
    const watcher = this.ports.attention;
    if (watcher === undefined) return NO_ATTENTION;
    if (isolation === "local") {
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
  #message(task: Running, input: unknown): void {
    const value = record(input, "JS Linux request");
    if (value["type"] === "signaled") this.#signaled(task, value); else this.#request(task, value);
  }
  #request(task: Running, value: Readonly<Record<string, unknown>>): void {
    exactKeys(value, ["version", "type", "sequence", "sync", "operation", "payload"]);
    if (value["version"] !== JS_PROCESS_PROTOCOL_VERSION || value["type"] !== "request" || typeof value["sync"] !== "boolean" || !(value["payload"] instanceof Uint8Array) || value["payload"].byteLength > 16 * 1024 ** 2 + 128) protocol("Malformed JS Linux request");
    if (task.isolation !== "local" && value["sync"]) protocol(task.isolation === "native" ? "Native shared memory must remain on its execution origin" : "Module shared memory must remain in the module frame");
    const sequence = integer(value["sequence"], "JS request sequence", 1, 0x7fff_ffff), operation = integer(value["operation"], "JS operation", 0, JS_MAX_OPERATION);
    if (sequence !== task.sequence + 1 || task.closing || task.pending.size >= 38) protocol("Invalid JS operation sequence or lifecycle");
    task.sequence = sequence; task.pending.set(sequence, value["sync"]);
    const response = this.#native("oxidevm_userspace_js_submit", encodeJSRequest(task.request, sequence, operation, value["payload"]));
    if (response.byteLength !== 4) protocol("Invalid JS admission result");
    const errno = new DataView(response.buffer).getUint32(0, true);
    if (errno !== 0) this.#reply(task, { ...task.request, sequence, errno, value: 0n, payload: new Uint8Array() });
    this.reconcile(); this.ports.wake();
  }
  /** ADR 0027: the copies of the command's registration. One turned off since Rust admitted the exec has nothing left to run. */
  #commandLaunch(program: ModuleCommandProgram): RunnerCommandLaunch {
    const launch = this.ports.commands?.launch(program);
    if (launch === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", `${program.name} is no longer turned on in this VM`);
    return launch;
  }
  run(request: UserspaceCommandHostRequest, signal: AbortSignal): Promise<void> {
    if (!this.ports.active() || signal.aborted) return Promise.resolve();
    const { program } = request, registered = program.kind === "worker" ? this.#launches.get(Number(program.token)) : undefined;
    // An exclusive service's workspace lease (ADR 0028) ends with its process, however it ends.
    const lease = registered?.lease;
    let worker: WorkerProcess, mailbox: SharedArrayBuffer, attention: TaskAttention = NO_ATTENTION, launch: RunnerLaunch | undefined, signals: TaskSignals | undefined, isolation: Isolation;
    try {
      if (program.kind === "worker") this.#launches.delete(Number(program.token));
      launch = program.kind === "module-command" ? this.#commandLaunch(program) : registered?.launch;
      isolation = program.kind === "native-node" ? "native" : launch === undefined ? "local" : "module";
      mailbox = new SharedArrayBuffer(isolation === "local" ? JS_MAILBOX_BYTES : 16);
      signals = isolation === "local" ? new TaskSignals() : undefined;
      if (isolation === "native") {
        if (this.ports.nativeExecution === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Native execution origin is unavailable");
        attention = this.#attention(isolation, mailbox);
        worker = isolatedWorkerProcess(this.ports.nativeExecution, request.pid, attention.noticePort);
      } else if (isolation === "module") {
        // ADR 0028: a module runs only in the VM's module frame; there is no page-origin fallback.
        const frame = this.ports.moduleFrame?.();
        if (frame === undefined) throw isolationUnavailable("module-frame-lost", "The module frame is gone");
        attention = this.#attention(isolation, mailbox);
        worker = isolatedWorkerProcess(frame, request.pid, attention.noticePort, MODULE_BROKER_VERSION);
      } else {
        const url = program.kind === "typescript" ? this.ports.interceptor : program.kind === "esbuild" ? esbuildWorker() : registered?.url;
        if (url === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "JS worker launch is unavailable");
        worker = localWorkerProcess(url, request.pid);
        attention = this.#attention(isolation, mailbox);
      }
    } catch (error) { lease?.release(); attention.close(); this.#diagnostic(request, 1, error); this.#exit(request, 125); return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel(); let finished = false;
      const stop = () => {
        if (finished) return; finished = true; lease?.release(); attention.close(); worker.stop();
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
      const task: Running = { request, worker, port: channel.port1, isolation, header: new Int32Array(mailbox, 0, 4), body: new Uint8Array(mailbox, 16), signals, pending: new Map(), sequence: 0, closing: false, stop, fail: error => { fail(error); } };
      channel.port1.onmessage = event => {
        attention.delivered();
        // A signal exit closes the task first, so its failure is the VM's, like a failed exit.
        try { if (!finished && !task.closing && this.#active(request)) this.#message(task, event.data); } catch (error) { if (task.closing) fatal(error); else fail(error); }
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
      try {
        if (isolation === "module" && launch !== undefined) worker.send({ version: JS_PROCESS_PROTOCOL_VERSION, type: "start", ...crossing(launch) }, [channel.port2]);
        else worker.send({ version: JS_PROCESS_PROTOCOL_VERSION, type: "start", port: channel.port2,
          ...(signals === undefined ? {} : { mailbox, signals: signals.buffer }),
          ...(request.program.kind === "native-node" ? { program: request.program, generation: request.generation, id: request.id } : {}) }, [channel.port2]);
      }
      catch (error) { fail(error); }
    });
  }
}
