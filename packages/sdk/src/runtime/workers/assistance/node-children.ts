import type { ProcessScheduler } from "./process-scheduler.js";
import { record } from "../../decode.js";
import { VMError } from "../../errors.js";
import { ASSISTANCE_LIMITS, decodeAssistanceOperation } from "../../protocol/assistance.js";
import type { ProcessChildEvent } from "./process-io.js";
import type { AsyncContext } from "./async-context.js";
import type { ProcessRuntimeIO } from "./process-io.js";
import { nodeResult } from "./node-file-operations.js";
import { bindAsyncEvents, EventEmitter, Readable, createOutputStream, streamError, type Writable } from "./node-streams.js";

export type NativeChildHandle = EventEmitter & {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly killed: boolean;
  /** Null for a stream the application asked to ignore. */
  readonly stdin: Writable | null | undefined;
  readonly stdout: Readable | null | undefined;
  readonly stderr: Readable | null | undefined;
  readonly stdio: readonly [Writable | null, Readable | null, Readable | null] | undefined;
  kill(signal?: unknown): boolean;
  ref(): NativeChildHandle;
  unref(): NativeChildHandle;
};
/** Internal service children are always piped. */
export type PipedChildHandle = NativeChildHandle & { readonly stdin: Writable; readonly stdout: Readable; readonly stderr: Readable };
type StdioMode = "pipe" | "ignore" | "inherit";
interface ChildStdio { readonly stdin: StdioMode; readonly stdout: StdioMode; readonly stderr: StdioMode }

/** Native processes remain in the authenticated Linux task. This owner only
 * adapts their validated lifecycle/stdio events to the pinned Node mechanics. */
/** Node's `options.env` rule, shared by spawn and fork: an absent env inherits
 * the process's; an object's `undefined` values are dropped and every other
 * value is stringified, as Node's `${key}=${value}` does; null bytes and
 * non-objects are refused with Node's errors. The protocol decoder still
 * bounds keys, sizes and counts at the Linux boundary afterwards. */
export function nodeEnvironment(value: unknown, inherited: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (value === undefined) return inherited;
  if (typeof value !== "object" || value === null) throw Object.assign(new TypeError("The \"options.env\" property must be of type object"), { code: "ERR_INVALID_ARG_TYPE" });
  const entries: [string, string][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    const text = environmentText(entry);
    if (key.includes("\0") || text.includes("\0")) {
      throw Object.assign(new TypeError(`The argument 'options.env['${key}']' must be a string without null bytes`), { code: "ERR_INVALID_ARG_VALUE" });
    }
    entries.push([key, text]);
  }
  return Object.fromEntries(entries);
}
function environmentText(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (typeof entry === "number" || typeof entry === "boolean" || typeof entry === "bigint") return String(entry);
  if (typeof entry === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
  if (typeof entry === "function") return "[object Function]";
  if (entry === null || entry === undefined) return String(entry);
  const toString: unknown = Reflect.get(entry, "toString");
  const text: unknown = typeof toString === "function" ? Reflect.apply(toString, entry, []) : undefined;
  if (typeof text !== "string") throw new TypeError("Cannot convert object to primitive value");
  return text;
}

export function createNativeChildren(
  io: Pick<ProcessRuntimeIO, "call" | "callSync" | "setChildEvents" | "spawnSync">, context: AsyncContext,
  env: Readonly<Record<string, string>>,
  scheduler?: ProcessScheduler,
): { readonly ChildProcess: new () => NativeChildHandle; readonly spawn: (...args: unknown[]) => NativeChildHandle; readonly spawnService: (...args: unknown[]) => PipedChildHandle; readonly hasPending: boolean; idle(): Promise<void> } {
  const children = new Map<number, ChildProcess>();
  const nativeSpawn = Symbol("native child creation");
  const early: ProcessChildEvent[] = [];
  let starting = 0;
  let earlyBytes = 0;
  let waiting: PromiseWithResolvers<undefined> | undefined;
  function hasPending(): boolean { return starting !== 0 || [...children.values()].some(child => child.keepsAlive); }
  function changed(): void {
    if (!hasPending()) { waiting?.resolve(undefined); waiting = undefined; }
  }
  function defer(callback: () => void | Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const run = () => { try { resolve(callback()); } catch (error) { reject(streamError(error)); } };
      if (scheduler === undefined) queueMicrotask(run); else scheduler.nextTick(run);
    });
  }
  class ChildProcess extends EventEmitter {
    pid: number | undefined;
    exitCode: number | null = null;
    signalCode: string | null = null;
    killed = false;
    readonly connected = false;
    spawnfile: string | null = null;
    declare spawnargs: readonly string[] | undefined;
    declare readonly stdout: Readable | null | undefined;
    declare readonly stderr: Readable | null | undefined;
    declare readonly stdin: Writable | null | undefined;
    declare readonly stdio: readonly [Writable | null, Readable | null, Readable | null] | undefined;
    readonly ready = Promise.withResolvers<number>();
    private handle: number | undefined;
    private exited = false;
    private closed = false;
    private readonly closedStreams = new Set<string>();
    private readonly eof = new Set<string>();
    private readonly retained = new Map<string, (() => void)[]>();
    private readonly run = context.capture();
    private referenced: boolean;
    readonly #created: boolean;

    constructor(creation?: symbol, keepsAlive = false, private readonly pipes: ChildStdio = { stdin: "ignore", stdout: "ignore", stderr: "ignore" }) {
      super();
      this.#created = creation === nativeSpawn;
      if (!this.#created && arguments.length !== 0) throw new VMError("FEATURE_NOT_AVAILABLE", "Unsupported ChildProcess constructor arguments");
      this.referenced = keepsAlive;
      bindAsyncEvents(this, context);
      if (!this.#created) return;
      const readable = (stream: "stdout" | "stderr") => {
        const target = new Readable({ highWaterMark: ASSISTANCE_LIMITS.chunk, autoDestroy: true,
          read: () => {
            const acknowledgements = this.retained.get(stream) ?? [];
            this.retained.delete(stream);
            for (const acknowledge of acknowledgements) acknowledge();
          },
        });
        bindAsyncEvents(target, context);
        target.on("close", () => { this.closedStreams.add(stream); this.maybeClose(); });
        return target;
      };
      this.stdout = pipes.stdout === "pipe" ? readable("stdout") : null;
      this.stderr = pipes.stderr === "pipe" ? readable("stderr") : null;
      this.stdin = pipes.stdin !== "pipe" ? null : createOutputStream(async bytes => {
        const child = await this.ready.promise;
        for (let offset = 0; offset < bytes.length;) {
          const part = bytes.slice(offset, offset + ASSISTANCE_LIMITS.chunk);
          const result = nodeResult(await io.call({ kind: "stdin", child, bytes: part }));
          if (result.kind !== "written" || result.count === 0 || result.count > part.length) throw new VMError("PROTOCOL_ERROR", "Invalid native stdin completion");
          offset += result.count;
        }
      }, context, async () => {
        const result = nodeResult(await io.call({ kind: "close-stdin", child: await this.ready.promise }));
        if (result.kind !== "unit") throw new VMError("PROTOCOL_ERROR", "Invalid native stdin EOF completion");
      });
      this.stdio = [this.stdin, this.stdout, this.stderr];
      // Prevent a rejected startup from becoming an unhandled promise before a
      // user writes stdin. The public child still emits its normal error event.
      void this.ready.promise.catch(() => {});
    }
    spawn(): never {
      throw new VMError("FEATURE_NOT_AVAILABLE", "Direct ChildProcess.spawn is unsupported", { builtin: "child_process", export: "ChildProcess.spawn" });
    }
    get keepsAlive(): boolean { return this.referenced; }
    ref(): this { this.referenced = true; changed(); return this; }
    unref(): this { this.referenced = false; changed(); return this; }
    private get pipedStreams(): number { return Number(this.pipes.stdout === "pipe") + Number(this.pipes.stderr === "pipe"); }
    opened(handle: number, pid: number): Promise<void> {
      this.handle = handle; this.pid = pid;
      children.set(handle, this);
      this.ready.resolve(handle);
      return defer(() => { this.run(() => this.emit("spawn")); });
    }
    async failed(error: unknown, command: string, args: readonly string[]): Promise<void> {
      const failure = streamError(error);
      const errno: unknown = Reflect.get(failure, "errno");
      if (typeof errno === "number" && Number.isInteger(errno) && errno < 0 && errno >= -4095) {
        this.exitCode = errno;
        Object.assign(failure, { syscall: `spawn ${command}`, path: command, spawnargs: [...args] });
      }
      this.ready.reject(failure);
      this.stdin?.destroy(); this.stdout?.destroy(); this.stderr?.destroy();
      this.run(() => this.emit("error", failure));
      await Promise.resolve();
      this.run(() => this.emit("close", this.exitCode, null));
    }
    private emitAsyncError(error: unknown): void {
      const emit = () => this.run(() => this.emit("error", streamError(error)));
      if (scheduler === undefined) emit(); else scheduler.enqueue(emit);
    }
    kill(value: unknown = "SIGTERM"): boolean {
      const signals = { SIGTERM: "TERM", SIGKILL: "KILL", SIGINT: "INT", SIGHUP: "HUP" } as const;
      if (typeof value !== "string" || !Object.hasOwn(signals, value)) throw new TypeError("Unsupported child signal");
      if (!this.#created) { this.killed = true; return true; }
      if (this.exited || this.handle === undefined) return false;
      const signal = value === "SIGKILL" ? "KILL" : value === "SIGINT" ? "INT" : value === "SIGHUP" ? "HUP" : "TERM";
      const result = io.callSync({ kind: "signal", child: this.handle, signal });
      if (result.kind === "error") {
        if (result.code === "ESRCH") return false;
        try { nodeResult(result); }
        catch (error) {
          if (result.code === "EINVAL" || result.code === "ENOSYS") throw error;
          this.run(() => this.emit("error", streamError(error)));
          return false;
        }
      }
      if (result.kind !== "unit") throw new VMError("PROTOCOL_ERROR", "Invalid child signal completion");
      this.killed = true;
      return true;
    }
    receive(message: ProcessChildEvent): void {
      const event = message.event;
      if (event.kind === "failure") throw new VMError("PROTOCOL_ERROR", "Task failure reached a child");
      if (event.kind === "output") {
        if (this.eof.has(event.stream)) throw new VMError("PROTOCOL_ERROR", "Child output after EOF");
        const stream = event.stream === "stdout" ? this.stdout : this.stderr;
        const acknowledge = () => {
          void io.call({ kind: "ack", child: event.child, stream: event.stream, sequence: message.sequence, bytes: event.bytes.length })
            .then(result => { if (nodeResult(result).kind !== "unit") throw new VMError("PROTOCOL_ERROR", "Invalid child output acknowledgement"); })
            .catch((error: unknown) => this.emitAsyncError(error));
        };
        // An ignored stream is acknowledged on the application's behalf.
        if (stream === null || stream === undefined) { acknowledge(); return; }
        if (stream.readableLength + event.bytes.length > ASSISTANCE_LIMITS.stream) throw new VMError("QUOTA_EXCEEDED", "Child output queue exhausted");
        // Flowing data is handed directly to application callbacks. Return its
        // transport credit first: a synchronous callback may wait for guest I/O.
        const flowing = stream.readableFlowing === true;
        if (flowing) acknowledge();
        const accepted = this.run(() => stream.push(event.bytes));
        if (!flowing) {
          if (accepted) acknowledge();
          else this.retained.set(event.stream, [...(this.retained.get(event.stream) ?? []), acknowledge]);
        }
      } else if (event.kind === "eof") {
        if (this.eof.has(event.stream)) throw new VMError("PROTOCOL_ERROR", "Duplicate child EOF");
        this.eof.add(event.stream);
        const stream = event.stream === "stdout" ? this.stdout : this.stderr;
        if (stream !== null && stream !== undefined) this.run(() => stream.push(null));
      } else {
        if (this.exited) throw new VMError("PROTOCOL_ERROR", "Duplicate child exit");
        this.exited = true;
        this.exitCode = event.code;
        this.signalCode = event.signal === null ? null : signalName(event.signal);
        this.stdin?.destroy();
        this.run(() => this.emit("exit", this.exitCode, this.signalCode));
        // Linux has exited; drain any unread pipe bytes so EOF can close each
        // stream before the child close event and process-lifetime release.
        this.stdout?.resume(); this.stderr?.resume();
      }
      this.maybeClose();
    }
    private maybeClose(): void {
      if (!this.closed && this.exited && this.eof.size === 2 && this.closedStreams.size === this.pipedStreams) {
        this.closed = true;
        if (this.handle !== undefined) children.delete(this.handle);
        this.run(() => this.emit("close", this.exitCode, this.signalCode));
        changed();
      }
    }
  }
  Object.defineProperty(ChildProcess, "name", { value: "ChildProcess", configurable: true });
  io.setChildEvents(message => {
    const event = message.event;
    if (event.kind === "failure") throw new VMError("PROTOCOL_ERROR", "Unexpected task failure");
    const child = children.get(event.child);
    if (child !== undefined) { child.receive(message); return; }
    const bytes = event.kind === "output" ? event.bytes.length : 64;
    if (starting === 0 || early.length >= 128 || earlyBytes + bytes > ASSISTANCE_LIMITS.stream) {
      throw new VMError("PROTOCOL_ERROR", "Unknown native child or exhausted startup event queue");
    }
    early.push(message); earlyBytes += bytes;
  });
  function spawn(args: unknown[], keepsAlive: boolean): ChildProcess {
    if (args.length < 1 || args.length > 3) throw new TypeError("Unsupported spawn arguments");
    const second = args[1];
    const arguments_: readonly unknown[] = Array.isArray(second) ? second : [];
    const value = second === undefined || second === null || Array.isArray(second) ? args[2] : second;
    const options = value === undefined || value === null ? {} : record(value, "spawn options");
    // Node ignores application-specific options. Known process controls must not be ignored.
    for (const key of ["uid", "gid", "argv0", "signal", "timeout", "killSignal"]) {
      if (options[key] !== undefined) throw new VMError("FEATURE_NOT_AVAILABLE", `Unsupported child option: ${key}`);
    }
    if (options["windowsHide"] !== undefined && typeof options["windowsHide"] !== "boolean") throw new TypeError("Invalid windowsHide option");
    if (options["windowsVerbatimArguments"] !== undefined && typeof options["windowsVerbatimArguments"] !== "boolean") throw new TypeError("Invalid windowsVerbatimArguments option");
    const shell = options["shell"];
    if (shell !== undefined && typeof shell !== "boolean" && typeof shell !== "string") throw new TypeError("Invalid child shell");
    // Every native child already lives in its own retired process group; a
    // detached child needs no session change and is admitted as such.
    if (options["detached"] !== undefined && typeof options["detached"] !== "boolean") throw new TypeError("Invalid detached option");
    const pipes = spawnPipes(options["stdio"]);
    const inherited = Object.values(pipes).includes("inherit");
    if (inherited && io.spawnSync === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Inherited child stdio is unavailable in this transport");
    const directory = options["cwd"] ?? ".";
    if (typeof directory !== "string") throw new TypeError("Invalid child cwd");
    const direct = decodeAssistanceOperation({ kind: "spawn", command: args[0], args: arguments_,
      cwd: directory, env: nodeEnvironment(options["env"], env) });
    if (direct.kind !== "spawn") throw new VMError("PROTOCOL_ERROR", "Invalid native spawn operation");
    const operation = shell === true || (typeof shell === "string" && shell !== "")
      ? decodeAssistanceOperation({ ...direct, command: shell === true ? "/bin/sh" : shell, args: ["-c", [direct.command, ...direct.args].join(" ")] })
      : direct;
    if (operation.kind !== "spawn") throw new VMError("PROTOCOL_ERROR", "Invalid native spawn operation");
    const child = new ChildProcess(nativeSpawn, keepsAlive, pipes);
    child.spawnfile = operation.command; child.spawnargs = [operation.command, ...operation.args];
    starting += 1;
    let started: Promise<void>;
    try {
      // Linux must create the child before JavaScript can change cwd or other
      // inherited process state. Pipes and lifecycle notifications stay async.
      const value = nodeResult(inherited && io.spawnSync !== undefined ? io.spawnSync(operation, {
        stdin: pipes.stdin === "inherit" ? "inherit" : "pipe", stdout: pipes.stdout === "inherit" ? "inherit" : "pipe", stderr: pipes.stderr === "inherit" ? "inherit" : "pipe",
      }) : io.callSync(operation));
      if (value.kind !== "spawned") throw new VMError("PROTOCOL_ERROR", "Invalid native spawn completion");
      started = child.opened(value.child, value.pid).then(() => {
        for (let index = 0; index < early.length;) {
          const event = early[index];
          if (event !== undefined && event.event.kind !== "failure" && event.event.child === value.child) {
            early.splice(index, 1); earlyBytes -= event.event.kind === "output" ? event.event.bytes.length : 64;
            child.receive(event);
          } else index += 1;
        }
      });
    } catch (error) {
      started = defer(() => child.failed(error, operation.command, operation.args));
    }
    void started.finally(() => { starting -= 1; changed(); });
    return child;
  }
  return {
    ChildProcess,
    spawn: (...args: unknown[]) => spawn(args, true),
    // Internal resource adapters retain their own lifetime (for example a TLS
    // socket can unref). Linux still owns and retires every service descendant;
    // this entrypoint is never included in the child_process builtin.
    spawnService: (...args: unknown[]) => pipedChild(spawn(args, false)),
    get hasPending() { return hasPending(); },
    async idle(): Promise<void> {
      if (!hasPending()) return;
      waiting ??= Promise.withResolvers<undefined>(); await waiting.promise;
    },
  };
}
/** Rust binds inherited descriptors; ignored streams retain the existing drain path. */
function spawnPipes(stdio: unknown): ChildStdio {
  if (stdio === undefined || stdio === "pipe") return { stdin: "pipe", stdout: "pipe", stderr: "pipe" };
  if (stdio === "ignore" || stdio === "inherit") return { stdin: stdio, stdout: stdio, stderr: stdio };
  if (!Array.isArray(stdio) || stdio.length > 3) throw new TypeError("Unsupported native child stdio");
  const entry = (index: number): StdioMode => {
    const value: unknown = stdio[index];
    if (value === undefined) return "pipe";
    if (value === "pipe" || value === "ignore" || value === "inherit") return value;
    throw new TypeError("Unsupported native child stdio");
  };
  return { stdin: entry(0), stdout: entry(1), stderr: entry(2) };
}

/** Narrow a child the caller spawned with piped stdio; ignored streams are a
 * caller defect here, never a silent fallback. */
export function pipedChild(child: NativeChildHandle): PipedChildHandle {
  const { stdin, stdout, stderr } = child;
  if (stdin == null || stdout == null || stderr == null) throw new VMError("PROTOCOL_ERROR", "Service children are always piped");
  return Object.assign(child, { stdin, stdout, stderr });
}

function signalName(signal: number): string {
  switch (signal) { case 1: return "SIGHUP"; case 2: return "SIGINT"; case 9: return "SIGKILL"; case 15: return "SIGTERM";
    default: throw new VMError("FEATURE_NOT_AVAILABLE", "Unsupported native child exit signal", { signal }); }
}
