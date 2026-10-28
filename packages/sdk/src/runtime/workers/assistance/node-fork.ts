import { exactKeys, record } from "../../decode.js";
import { VMError, deserializeError } from "../../errors.js";
import { ASSISTANCE_LIMITS, decodeAssistanceEnvironment } from "../../protocol/assistance.js";
import { FORK_EXEC_ARGUMENTS, type ForkReply, type ForkRequest } from "../../protocol/assistance-fork.js";
import type { ChildSignal } from "../../protocol/assistance-broker.js";
import type { AsyncContext } from "./async-context.js";
import type { ForkExit, ProcessRuntimeIO } from "./process-io.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import type { ProcessScheduler } from "./process-scheduler.js";
import { nodeEnvironment } from "./node-children.js";
import { nodeResult } from "./node-file-operations.js";
import { createIpcChannel, type IpcChannel } from "./node-ipc.js";
import { bindAsyncEvents, createOutputStream, EventEmitter, Readable, streamError, type Writable } from "./node-streams.js";

export const EXEC_PATH = "/usr/local/bin/oxidevm-node";
const SIGNALS = { SIGTERM: "TERM", SIGKILL: "KILL", SIGINT: "INT", SIGHUP: "HUP" } as const;
function isSignalName(value: string): value is keyof typeof SIGNALS { return Object.hasOwn(SIGNALS, value); }
type ForkIO = Pick<ProcessRuntimeIO, "forkSync" | "forkInput" | "forkSignal" | "forkOutputAck" | "setForkEvents">;

/** Node's ChildProcess surface for a forked JavaScript child. */
export type ForkedChildHandle = EventEmitter & {
  readonly pid: number | undefined;
  readonly connected: boolean;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly killed: boolean;
  readonly spawnfile: string;
  readonly spawnargs: readonly string[];
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly stdio: readonly [Writable | null, Readable | null, Readable | null];
  readonly channel: { ref(): void; unref(): void } | null;
  send(message: unknown, ...rest: unknown[]): boolean;
  disconnect(): void;
  ref(): void;
  unref(): void;
  kill(signal?: unknown): boolean;
};
export interface ForkedChildren {
  readonly fork: (...args: unknown[]) => ForkedChildHandle;
  readonly hasPending: boolean;
  idle(): Promise<void>;
}

/** Forked JavaScript children live in sibling workers. This owner adapts the
 * control-routed fork wires and the private IPC channel to Node's ChildProcess
 * mechanics; control alone allocates identities and retires children. */
export function createForkedChildren(
  io: ForkIO, context: AsyncContext, env: Readonly<Record<string, string>>, cwd: () => string,
  execArgv: readonly string[], runtime: { readonly scheduler?: ProcessScheduler; readonly execPath?: string } = {},
): ForkedChildren {
  const { scheduler } = runtime, execPath = runtime.execPath ?? EXEC_PATH;
  const children = new Map<number, ForkedChild>();
  let waiting: PromiseWithResolvers<undefined> | undefined;
  const deliver = (callback: () => void): void => { if (scheduler === undefined) queueMicrotask(callback); else scheduler.enqueue(callback); };
  function hasPending(): boolean { return [...children.values()].some(child => child.keepsAlive); }
  function changed(): void { if (!hasPending()) { waiting?.resolve(undefined); waiting = undefined; } }

  class ForkedChild extends EventEmitter {
    pid: number | undefined;
    connected = false;
    exitCode: number | null = null;
    signalCode: string | null = null;
    killed = false;
    readonly spawnfile = execPath;
    readonly spawnargs: string[];
    readonly stdin: Writable | null;
    readonly stdout: Readable | null;
    readonly stderr: Readable | null;
    readonly stdio: readonly [Writable | null, Readable | null, Readable | null];
    channel: { ref(): void; unref(): void } | null = null;
    private ipc: IpcChannel | undefined;
    private readonly queued: [unknown, ((error: Error | null) => void) | undefined][] = [];
    private process: number | undefined;
    private exited = false;
    private closed = false;
    private referenced = true;
    private readonly eof = new Set<string>();
    private readonly closedStreams = new Set<string>();
    private readonly retained = new Map<string, (() => void)[]>();
    readonly run = context.capture();

    constructor(readonly silent: boolean, entry: string, args: readonly string[]) {
      super();
      bindAsyncEvents(this, context);
      this.spawnargs = [execPath, entry, ...args];
      if (silent) {
        const readable = (stream: "stdout" | "stderr") => new Readable({ highWaterMark: ASSISTANCE_LIMITS.chunk, autoDestroy: true,
          read: () => {
            const acknowledgements = this.retained.get(stream) ?? [];
            this.retained.delete(stream);
            for (const acknowledge of acknowledgements) acknowledge();
          },
        });
        this.stdout = readable("stdout"); this.stderr = readable("stderr");
        bindAsyncEvents(this.stdout, context); bindAsyncEvents(this.stderr, context);
        this.stdout.on("close", () => { this.closedStreams.add("stdout"); this.maybeClose(); });
        this.stderr.on("close", () => { this.closedStreams.add("stderr"); this.maybeClose(); });
        this.stdin = createOutputStream(async bytes => {
          const child = this.requireProcess();
          for (let offset = 0; offset < bytes.length; offset += ASSISTANCE_LIMITS.chunk) {
            const result = nodeResult(await io.forkInput(child, bytes.slice(offset, offset + ASSISTANCE_LIMITS.chunk)));
            if (result.kind !== "unit") throw new VMError("PROTOCOL_ERROR", "Invalid fork stdin completion");
          }
        }, context, async () => {
          const result = nodeResult(await io.forkInput(this.requireProcess(), null));
          if (result.kind !== "unit") throw new VMError("PROTOCOL_ERROR", "Invalid fork stdin EOF completion");
        });
      } else { this.stdin = null; this.stdout = null; this.stderr = null; }
      this.stdio = [this.stdin, this.stdout, this.stderr];
      // Node references the IPC channel through 'message' listeners.
      this.on("newListener", event => { if (event === "message") this.ipc?.setListeners(this.listenerCount("message") + 1); });
      this.on("removeListener", event => { if (event === "message") this.ipc?.setListeners(this.listenerCount("message")); });
    }
    private requireProcess(): number {
      if (this.process === undefined) throw new VMError("PROTOCOL_ERROR", "Fork child has no process");
      return this.process;
    }
    get keepsAlive(): boolean { return (!this.closed && this.referenced) || (this.ipc?.hasReferences ?? false); }
    opened(process: number, pid: number): void { this.process = process; this.pid = pid; }
    failed(reply: Extract<ForkReply, { kind: "error" }>): void {
      const failure = Object.assign(new Error(`${reply.code}: spawn ${execPath}`), {
        errno: -reply.errno, code: reply.code, syscall: `spawn ${execPath}`, path: execPath, spawnargs: this.spawnargs.slice(1),
      });
      this.exitCode = -reply.errno;
      this.stdin?.destroy(); this.stdout?.destroy(); this.stderr?.destroy();
      this.run(() => this.emit("error", failure));
      deliver(() => { this.closed = true; this.run(() => this.emit("close", this.exitCode, null)); changed(); });
    }
    attach(port: MessagePort): void {
      if (this.ipc !== undefined || this.exited) { port.close(); return; }
      const ipc = createIpcChannel(port, { context, deliver,
        onMessage: value => { this.run(() => this.emit("message", value)); },
        onDisconnect: () => { this.connected = false; this.run(() => this.emit("disconnect")); changed(); },
      });
      this.ipc = ipc;
      ipc.setListeners(this.listenerCount("message"));
      this.connected = true;
      this.channel = { ref: () => { ipc.ref(); }, unref: () => { ipc.unref(); } };
      for (const [message, callback] of this.queued.splice(0)) ipc.send(message, callback);
    }
    send(message: unknown, ...rest: unknown[]): boolean {
      const callback = rest.find(value => typeof value === "function");
      if (rest.some(value => value !== undefined && typeof value !== "function")) throw new VMError("FEATURE_NOT_AVAILABLE", "Sending handles over fork IPC is unsupported", { api: "child.send(handle)", backend: "assisted-node" });
      const complete = callback === undefined ? undefined : (error: Error | null) => { Reflect.apply(callback, this, [error]); };
      if (this.ipc === undefined) {
        if (this.exited) throw Object.assign(new Error("Channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" });
        if (message === undefined) throw Object.assign(new TypeError('The "message" argument must be specified'), { code: "ERR_MISSING_ARGS" });
        this.queued.push([message, complete]);
        return true;
      }
      return this.ipc.send(message, complete);
    }
    disconnect(): void {
      // Node flips `connected` synchronously; the event follows asynchronously.
      if (this.ipc === undefined) return;
      this.connected = false;
      this.ipc.disconnect();
    }
    ref(): void { this.referenced = true; }
    unref(): void { this.referenced = false; changed(); }
    kill(value: unknown = "SIGTERM"): boolean {
      if (typeof value !== "string" || !isSignalName(value)) throw Object.assign(new TypeError(`Unknown signal: ${String(value)}`), { code: "ERR_UNKNOWN_SIGNAL" });
      const signal: ChildSignal = SIGNALS[value];
      if (this.exited || this.process === undefined) return false;
      const complete = (result: AssistanceResult): boolean => {
        if (result.kind === "error" && result.code === "ESRCH") return false;
        if (nodeResult(result).kind !== "unit") throw new VMError("PROTOCOL_ERROR", "Invalid fork signal completion");
        this.killed = true; return true;
      };
      const report = (error: unknown) => { deliver(() => this.run(() => this.emit("error", streamError(error)))); };
      try {
        const result = io.forkSignal(this.process, signal);
        if ("kind" in result) return complete(result);
        void result.then(complete).catch(report);
        this.killed = true; return true;
      } catch (error) { report(error); return false; }
    }
    output(stream: "stdout" | "stderr", bytes: Uint8Array<ArrayBuffer>, chunk: number): void {
      const child = this.requireProcess();
      const target = stream === "stdout" ? this.stdout : this.stderr;
      if (target === null || this.eof.has(stream)) { io.forkOutputAck(child, chunk); return; }
      if (target.readableLength + bytes.length > ASSISTANCE_LIMITS.stream) throw new VMError("QUOTA_EXCEEDED", "Fork output queue exhausted");
      const acknowledge = () => { io.forkOutputAck(child, chunk); };
      const flowing = target.readableFlowing === true;
      if (flowing) acknowledge();
      const accepted = this.run(() => target.push(bytes));
      if (!flowing) {
        if (accepted) acknowledge();
        else this.retained.set(stream, [...(this.retained.get(stream) ?? []), acknowledge]);
      }
    }
    terminated(termination: ForkExit): void {
      if (this.exited) throw new VMError("PROTOCOL_ERROR", "Duplicate fork exit");
      this.exited = true;
      if (termination.kind === "exit") this.exitCode = termination.code;
      else if (termination.kind === "signal") this.signalCode = signalName(termination.signal);
      else if (termination.kind === "native-signal") this.signalCode = termination.signal;
      else this.run(() => this.emit("error", deserializeError(termination.error)));
      this.stdin?.destroy();
      this.run(() => this.emit("exit", this.exitCode, this.signalCode));
      // The child is gone: an open channel disconnects without a peer frame.
      this.ipc?.disconnect();
      for (const stream of ["stdout", "stderr"] as const) {
        const target = stream === "stdout" ? this.stdout : this.stderr;
        if (target === null || this.eof.has(stream)) continue;
        this.eof.add(stream);
        this.run(() => target.push(null));
        target.resume();
      }
      this.maybeClose();
    }
    private maybeClose(): void {
      if (this.closed || !this.exited) return;
      if (this.silent && this.closedStreams.size !== 2) return;
      this.closed = true;
      if (this.process !== undefined) children.delete(this.process);
      deliver(() => { this.run(() => this.emit("close", this.exitCode, this.signalCode)); changed(); });
    }
  }

  io.setForkEvents({
    channel(child, port) { const owner = children.get(child); if (owner === undefined) port.close(); else owner.attach(port); },
    output(child, stream, bytes, chunk) {
      const owner = children.get(child);
      if (owner === undefined) throw new VMError("PROTOCOL_ERROR", "Output for an unknown fork child");
      owner.output(stream, bytes, chunk);
    },
    exit(child, termination) {
      const owner = children.get(child);
      if (owner === undefined) throw new VMError("PROTOCOL_ERROR", "Exit for an unknown fork child");
      owner.terminated(termination);
    },
  });

  function fork(args: unknown[]): ForkedChild {
    if (args.length < 1 || args.length > 3) throw new TypeError("Unsupported fork arguments");
    const modulePath = args[0];
    if (typeof modulePath !== "string" || modulePath === "") throw new TypeError("The fork module path must be a non-empty string");
    const second = args[1];
    const arguments_: readonly unknown[] = Array.isArray(second) ? second : [];
    const value = second === undefined || second === null || Array.isArray(second) ? args[2] : second;
    const options = value === undefined || value === null ? {} : record(value, "fork options");
    exactKeys(options, [], ["cwd", "env", "execArgv", "execPath", "silent", "stdio", "detached", "serialization", "windowsHide", "timeout", "killSignal", "signal", "uid", "gid"]);
    const unavailable = (api: string): never => { throw new VMError("FEATURE_NOT_AVAILABLE", `${api} is unsupported for forked children`, { api, backend: "assisted-node" }); };
    if (options["serialization"] !== undefined && options["serialization"] !== "json") unavailable("child_process.fork serialization");
    if (options["execPath"] !== undefined && options["execPath"] !== execPath) unavailable("child_process.fork execPath");
    for (const name of ["uid", "gid", "timeout", "killSignal", "signal"]) if (options[name] !== undefined) unavailable(`child_process.fork ${name}`);
    const requested = readExecArgv(options["execArgv"] ?? execArgv);
    const directory = options["cwd"] ?? cwd();
    if (typeof directory !== "string" || !directory.startsWith("/")) throw new TypeError("Invalid fork cwd");
    const silent = forkSilent(options["silent"], options["stdio"]);
    const request: ForkRequest = { entry: resolvePath(directory, modulePath), args: arguments_.map(argument => { if (typeof argument !== "string") throw new TypeError("Fork arguments must be strings"); return argument; }),
      execArgv: requested, cwd: directory,
      env: decodeAssistanceEnvironment(nodeEnvironment(options["env"], env)), silent };
    const child = new ForkedChild(silent, request.entry, request.args);
    const reply = io.forkSync(request);
    if (reply.kind === "spawned") {
      child.opened(reply.process, reply.pid);
      children.set(reply.process, child);
      deliver(() => { child.run(() => child.emit("spawn")); });
    } else {
      children.set(-reply.errno - (children.size + 1) * 4096, child);
      deliver(() => { child.failed(reply); });
    }
    return child;
  }
  return {
    fork: (...args: unknown[]) => fork(args),
    get hasPending() { return hasPending(); },
    async idle(): Promise<void> {
      if (!hasPending()) return;
      waiting ??= Promise.withResolvers<undefined>(); await waiting.promise;
    },
  };
}

function readExecArgv(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > FORK_EXEC_ARGUMENTS.length) throw new VMError("FEATURE_NOT_AVAILABLE", "child_process.fork execArgv is unsupported", { api: "child_process.fork execArgv", backend: "assisted-node" });
  return value.map((argument: unknown) => {
    if (typeof argument !== "string" || !FORK_EXEC_ARGUMENTS.includes(argument)) throw new VMError("FEATURE_NOT_AVAILABLE", "child_process.fork execArgv is unsupported", { api: "child_process.fork execArgv", backend: "assisted-node" });
    return argument;
  });
}

/** Node: `silent` means piped stdio; an explicit `stdio` wins and must carry
 * exactly one 'ipc' entry when given as an array. */
function forkSilent(silent: unknown, stdio: unknown): boolean {
  if (silent !== undefined && typeof silent !== "boolean") throw new TypeError("Invalid fork silent option");
  if (stdio === undefined) return silent === true;
  if (stdio === "pipe") return true;
  if (stdio === "inherit") return false;
  if (!Array.isArray(stdio) || stdio.length !== 4 || stdio[3] !== "ipc" || stdio.slice(0, 3).some(entry => entry !== stdio[0]) || (stdio[0] !== "pipe" && stdio[0] !== "inherit")) {
    throw new VMError("FEATURE_NOT_AVAILABLE", "Only uniform pipe or inherit stdio with one ipc entry is supported", { api: "child_process.fork stdio", backend: "assisted-node" });
  }
  return stdio[0] === "pipe";
}

function resolvePath(base: string, target: string): string {
  const parts = (target.startsWith("/") ? target : `${base}/${target}`).split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") resolved.pop(); else resolved.push(part);
  }
  return `/${resolved.join("/")}`;
}

function signalName(signal: number): string {
  switch (signal) { case 1: return "SIGHUP"; case 2: return "SIGINT"; case 9: return "SIGKILL"; case 15: return "SIGTERM";
    default: throw new VMError("FEATURE_NOT_AVAILABLE", "Unsupported fork child exit signal", { signal }); }
}
