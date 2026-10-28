import { exactKeys, integer, record } from "../../decode.js";
import { decodeSerializedError, deserializeError, VMError } from "../../errors.js";
import { descriptor, LinuxError, operation, protocol, Reader, Writer, type JSProcessIdentity, type LinuxResult } from "../../js-process/codec.js";
import { files } from "../../js-process/file-operations.js";
import type { LinuxClient } from "../../js-process/transport.js";
import { encodeNativeEvalSource, type NativeThreadIdentity } from "../../userspace-command-abi.js";
import { decodeForkExecArgv } from "../../protocol/assistance-fork.js";
import type { AsyncContext } from "../assistance/async-context.js";
import { nodeEnvironment } from "../assistance/node-children.js";
import { createNodePath } from "../assistance/node-path.js";
import { createNodeWorkerThreads, type WorkerThreadProcess, type WorkerThreadRuntime } from "../assistance/node-worker-threads.js";
import { bindAsyncEvents, createInputStream, createOutputStream, EventEmitter, type Readable, type Writable } from "../assistance/node-streams.js";
import type { ProcessScheduler } from "../assistance/process-scheduler.js";
import type { NativeBridge } from "./bridge.js";
import { decodeWorkerException, encodeWorkerException } from "./worker-exception.js";
import { createNodePorts } from "./message-port.js";
import { NATIVE_TASK_CONTROL_VERSION, type NativeThreadMetadata } from "./thread-metadata.js";

const PlatformChannel = globalThis.MessageChannel;
interface Services { readonly client: LinuxClient; readonly bridge: NativeBridge; readonly identity: JSProcessIdentity; readonly control: MessagePort; readonly thread: NativeThreadIdentity | null; readonly metadata: NativeThreadMetadata | null; readonly autoSelectFamily?: SharedArrayBuffer }
interface Task {
  readonly id: bigint; readonly tid: number; readonly emitter: EventEmitter; readonly port: InstanceType<ReturnType<typeof createNodePorts>["MessagePort"]>;
  readonly stdout: Readable; readonly stderr: Readable; readonly stdin: Writable | null;
  readonly closed: PromiseWithResolvers<undefined>; readonly drained: Promise<void>;
  exit: Promise<number>; referenced: boolean; ended: boolean; terminating: boolean;
}
function unit(result: LinuxResult): void { if (result.value !== 0n || result.bytes.length !== 0) protocol("Invalid native worker unit reply"); }
function exitCode(result: LinuxResult): number { if (result.bytes.length !== 0) protocol("Invalid native worker exit payload"); return integer(Number(result.value), "native worker exit", 0, 255); }

/** This owner adapts Rust tasks and process channels to Node's Worker surface. */
export class NativeWorkers implements WorkerThreadRuntime {
  readonly module: Readonly<Record<string, unknown>>;
  readonly #ports;
  readonly #tasks = new Map<bigint, Task>();
  readonly #environment = new Map<unknown, unknown>();
  readonly #parentPort;
  #waiting: PromiseWithResolvers<undefined> | undefined;
  #disposed = false;
  constructor(readonly services: Services, readonly context: AsyncContext, readonly scheduler: ProcessScheduler, readonly process: WorkerThreadProcess) {
    this.#ports = createNodePorts(context, callback => scheduler.enqueue(callback), () => this.#changed());
    const metadata = services.metadata;
    this.#parentPort = metadata === null ? null : this.#ports.wrap(metadata.port);
    let data: unknown = null;
    if (metadata !== null) {
      const input = record(this.#ports.receive(metadata.data), "worker environment data"); exactKeys(input, ["workerData", "environmentData"]);
      const environment = input["environmentData"]; if (!(environment instanceof Map)) protocol("Invalid worker environment map");
      for (const [key, value] of environment) this.#environment.set(key, value);
      data = input["workerData"];
    }
    const start = (filename: unknown, options: object, emitter: EventEmitter) => this.#start(filename, options, emitter);
    const changed = () => this.#changed();
    class Worker extends EventEmitter {
      readonly #task: Task;
      constructor(filename: unknown, options: unknown = {}) {
        super(); bindAsyncEvents(this, context);
        if (typeof options !== "object" || options === null) throw new TypeError("Worker options must be an object");
        this.#task = start(filename, options, this);
      }
      get threadId(): number { return this.#task.ended ? -1 : this.#task.tid; }
      get stdout(): Readable { return this.#task.stdout; }
      get stderr(): Readable { return this.#task.stderr; }
      get stdin(): Writable | null { return this.#task.stdin; }
      get resourceLimits(): Readonly<Record<string, never>> { return {}; }
      postMessage(value: unknown, transfers?: unknown): void { this.#task.port.postMessage(value, transfers); }
      ref(): this { this.#task.referenced = true; this.#task.port.ref(); changed(); return this; }
      unref(): this { this.#task.referenced = false; this.#task.port.unref(); changed(); return this; }
      terminate(): Promise<number> {
        const task = this.#task;
        if (!task.ended && !task.terminating) { task.terminating = true; task.stdout.resume(); task.stderr.resume(); services.client.sync(operation(65542, new Writer().u64(task.id), unit)); }
        return task.exit;
      }
      getHeapSnapshot(): never { throw new VMError("FEATURE_NOT_AVAILABLE", "Worker heap snapshots are unavailable"); }
    }
    this.module = {
      ...createNodeWorkerThreads(globalThis), Worker,
      MessagePort: this.#ports.MessagePort, MessageChannel: this.#ports.MessageChannel,
      receiveMessageOnPort: this.#ports.receiveMessageOnPort,
      markAsUncloneable: this.#ports.markAsUncloneable, markAsUntransferable: this.#ports.markAsUntransferable, isMarkedAsUntransferable: this.#ports.isMarkedAsUntransferable,
      isMainThread: services.thread === null, threadId: services.thread?.tid ?? 0,
      parentPort: this.#parentPort, workerData: data,
      getEnvironmentData: (key: unknown) => this.#environment.get(key),
      setEnvironmentData: (key: unknown, value?: unknown) => { if (value === undefined) this.#environment.delete(key); else this.#environment.set(key, value); },
    };
    services.control.onmessage = (event: MessageEvent<unknown>) => {
      const input = record(event.data, "native worker lifecycle");
      if (input["version"] !== NATIVE_TASK_CONTROL_VERSION || typeof input["child"] !== "bigint") protocol("Invalid native worker lifecycle identity");
      const task = this.#tasks.get(input["child"]); if (task === undefined) { if (this.#disposed) return; protocol("Stale native worker lifecycle"); }
      switch (input["type"]) {
        case "online": exactKeys(input, ["version", "type", "child"]); scheduler.enqueue(() => { task.emitter.emit("online"); }); break;
        case "error": exactKeys(input, ["version", "type", "child", "error"]); { const error = deserializeError(decodeSerializedError(input["error"])); scheduler.enqueue(() => { task.emitter.emit("error", error); }); } break;
        case "exception": exactKeys(input, ["version", "type", "child", "error"]); { const error = decodeWorkerException(input["error"], this.#ports); scheduler.enqueue(() => { task.emitter.emit("error", error); }); } break;
        case "closed": exactKeys(input, ["version", "type", "child"]); task.closed.resolve(undefined); break;
        default: protocol("Unknown native worker lifecycle event");
      }
    }; services.control.start();
  }
  serializeException(error: unknown): unknown {
    try { return encodeWorkerException(error, this.#ports); }
    catch { return encodeWorkerException(Object.assign(new Error("Could not serialize the worker error"), { code: "ERR_WORKER_UNSERIALIZABLE_ERROR" }), this.#ports); }
  }
  #entry(filename: unknown): string {
    let value: string;
    if (filename instanceof URL) { if (filename.protocol !== "file:" || filename.hostname !== "") throw new TypeError("Worker URL must name a guest file"); value = decodeURIComponent(filename.pathname); }
    else if (typeof filename === "string" && /^(?:\/|\.\.?\/)/u.test(filename)) value = filename;
    else throw Object.assign(new TypeError("Worker filename must be an absolute or relative guest path"), { code: "ERR_WORKER_PATH" });
    return createNodePath(() => this.process.cwd()).resolve(value);
  }
  /** Rust refuses source-text workers outside qualification builds; Linux runs them (ADR 0026). */
  #prepare<T>(evaluated: boolean, prepare: () => T): T {
    try { return prepare(); }
    catch (error: unknown) {
      if (evaluated && error instanceof LinuxError && error.errno === 95) throw new VMError("FEATURE_NOT_AVAILABLE", "Worker threads from source text are unavailable", { lateFailure: "eval-worker", subject: "" });
      throw error;
    }
  }
  #start(filename: unknown, options: object, emitter: EventEmitter): Task {
    if (this.#disposed || this.#tasks.size >= 31) throw new VMError("QUOTA_EXCEEDED", "Native worker capacity exhausted");
    const field = (name: string): unknown => Reflect.get(options, name);
    const limits = field("resourceLimits"), tracking = field("trackUnmanagedFds");
    if ((tracking !== undefined && tracking !== true) || field("env") === this.module["SHARE_ENV"] || field("name") !== undefined || (limits !== undefined && (typeof limits !== "object" || limits === null || Object.keys(limits).length !== 0))) throw new VMError("FEATURE_NOT_AVAILABLE", "This worker execution option is not qualified");
    const evaluated = Boolean(field("eval"));
    const source = evaluated ? new Writer().blob(encodeNativeEvalSource(filename)) : new Writer().path(this.#entry(filename));
    const argv = field("argv") ?? [];
    if (!Array.isArray(argv) || argv.length > 4096) throw new TypeError("Invalid Worker argv");
    const args = argv.map((value: unknown) => String(value)), execArgv = decodeForkExecArgv(field("execArgv") ?? this.process.execArgv);
    const env = nodeEnvironment(field("env"), this.process.env);
    const cloned = this.#ports.clone({ workerData: field("workerData"), environmentData: this.#environment }, field("transferList"));
    const prepared = this.#prepare(evaluated, () => this.services.client.sync(operation(evaluated ? 65546 : 65540, source.strings(args).strings(Object.entries(env).map(([key, value]) => `${key}=${value}`)), result => {
      if (result.value <= 0n || result.bytes.length !== 40) protocol("Invalid prepared worker channels");
      const reader = new Reader(result.bytes), control = [reader.u32(), reader.u32(), reader.u32(), reader.u32()], stdio = [reader.u32(), reader.u32(), reader.u32(), reader.u32(), reader.u32(), reader.u32()]; reader.end();
      if (new Set([...control, ...stdio]).size !== 10 || [...control, ...stdio].some(fd => fd < 3 || fd > 0x7fff_ffff)) protocol("Invalid private worker descriptors");
      return { id: result.value, control, stdin: descriptor(stdio[1]), stdout: descriptor(stdio[2]), stderr: descriptor(stdio[4]) };
    })));
    const channel = new PlatformChannel(), port = this.#ports.wrap(channel.port1);
    try {
      const tid = this.services.bridge.createEnvironment(prepared.control);
      this.services.client.sync(operation(65541, new Writer().u64(prepared.id).u32(tid), result => { if (result.value !== BigInt(tid) || result.bytes.length !== 0) protocol("Native worker TID mismatch"); }));
      const output = createInputStream(this.context), errors = createInputStream(this.context);
      const pump = async (fd: number, input: ReturnType<typeof createInputStream>) => { for (;;) { const bytes = await this.services.client.call(files.read(fd, 65536)); await input.receive(bytes.length === 0 ? null : bytes); if (bytes.length === 0) return; } };
      const stdin = field("stdin") === true ? createOutputStream(async bytes => {
        let offset = 0; while (offset < bytes.length) { const count = await this.services.client.call(files.write(prepared.stdin, bytes.subarray(offset, offset + 65536))); if (count === 0) protocol("Worker stdin made no progress"); offset += count; }
      }, this.context, async () => { await this.services.client.call(files.close(prepared.stdin)); }) : null;
      if (stdin === null) this.services.client.sync(files.close(prepared.stdin));
      const task: Task = { id: prepared.id, tid, emitter, port, stdout: output.stream, stderr: errors.stream, stdin, closed: Promise.withResolvers<undefined>(),
        drained: Promise.all([pump(prepared.stdout, output), pump(prepared.stderr, errors)]).then(() => undefined), exit: Promise.resolve(0), referenced: true, ended: false, terminating: false };
      this.#tasks.set(task.id, task);
      port.on("message", value => { emitter.emit("message", value); }); port.on("messageerror", error => { emitter.emit("messageerror", error); });
      if (field("stdout") !== true) task.stdout.pipe(this.process.stdout, { end: false });
      if (field("stderr") !== true) task.stderr.pipe(this.process.stderr, { end: false });
      this.services.control.postMessage({ version: NATIVE_TASK_CONTROL_VERSION, type: "prepare", child: task.id, metadata: { port: channel.port2, data: cloned.value, execArgv, transfers: cloned.transfers, autoSelectFamily: this.services.autoSelectFamily ?? null } }, [channel.port2, ...cloned.transfers]);
      task.exit = this.#wait(task); void task.exit.catch((error: unknown) => this.scheduler.enqueue(() => { emitter.emit("error", error); }));
      return task;
    } catch (error) {
      this.#tasks.delete(prepared.id);
      port.close(); channel.port2.close();
      this.services.client.sync(operation(65542, new Writer().u64(prepared.id), unit));
      void this.services.client.call(operation(65543, new Writer().u64(prepared.id), exitCode)).then(() => this.services.client.call(operation(65544, new Writer().u64(prepared.id), exitCode))).catch((error: unknown) => this.scheduler.enqueue(() => { emitter.emit("error", error); }));
      throw error;
    }
  }
  async #wait(task: Task): Promise<number> {
    const code = await this.services.client.call(operation(65543, new Writer().u64(task.id), exitCode));
    await task.closed.promise; await task.drained;
    await this.services.client.call(operation(65544, new Writer().u64(task.id), exitCode));
    task.ended = true; task.port.close(); task.stdin?.destroy(); this.#tasks.delete(task.id);
    this.scheduler.enqueue(() => { task.emitter.emit("exit", code); this.#changed(); });
    return code;
  }
  #changed(): void { if (!this.hasPending) { this.#waiting?.resolve(undefined); this.#waiting = undefined; } }
  get hasPending(): boolean { return !this.#disposed && ([...this.#tasks.values()].some(task => !task.ended && task.referenced) || this.#ports.hasReferences || (this.#parentPort?.hasPendingOutput ?? false)); }
  async idle(): Promise<void> { while (this.hasPending) { this.#waiting ??= Promise.withResolvers<undefined>(); await this.#waiting.promise; } }
  dispose(): void { this.#disposed = true; this.#ports.dispose(); this.services.control.close(); this.#changed(); }
}
