import { VMError } from "../../errors.ts";
import { EventEmitter } from "./node-streams.ts";
import { processMemoryUsage } from "./node-memory.ts";
import { createWarningEmitter } from "./node-warnings.ts";
import { decodeForkExecArgv } from "../../protocol/assistance-fork.js";
import { linuxSignalConstants } from "../../process-signals.js";
import { unavailableNodeApi } from "./node-capability.js";

const monotonicNow = performance.now.bind(performance);

/** The child end of a fork IPC channel as the process object exposes it. */
export interface ProcessIpc {
  readonly connected: boolean;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  disconnect(): void;
  ref(): void;
  unref(): void;
  setListeners(count: number): void;
}

export interface ProcessIpcSurface {
  readonly connected: boolean;
  send(message: unknown, ...rest: unknown[]): boolean;
  disconnect(): void;
  readonly channel: { ref(): void; unref(): void };
}

/** `process.send`, `connected`, `disconnect` and `channel` for a forked child.
 * Node references the channel through 'message' listeners, so the count is
 * mirrored on registration and removal. */
export function installProcessIpc(process: NodeProcess, channel: ProcessIpc): asserts process is NodeProcess & ProcessIpcSurface {
  Object.defineProperties(process, {
    connected: { configurable: true, enumerable: true, get: () => channel.connected },
    send: { configurable: true, enumerable: true, writable: true, value: (message: unknown, ...rest: unknown[]): boolean => {
      const callback = rest.find(value => typeof value === "function");
      if (rest.some(value => value !== undefined && typeof value !== "function")) throw new VMError("FEATURE_NOT_AVAILABLE", "Sending handles over fork IPC is unsupported", { api: "process.send(handle)", backend: "assisted-node" });
      return channel.send(message, callback === undefined ? undefined : error => { Reflect.apply(callback, process, [error]); });
    } },
    disconnect: { configurable: true, enumerable: true, writable: true, value: () => { channel.disconnect(); } },
    channel: { configurable: true, enumerable: true, writable: true, value: { ref: () => { channel.ref(); }, unref: () => { channel.unref(); } } },
  });
  process.on("newListener", event => { if (event === "message") channel.setListeners(process.listenerCount("message") + 1); });
  process.on("removeListener", event => { if (event === "message") channel.setListeners(process.listenerCount("message")); });
}

const SIGNAL_NUMBERS = { TERM: 15, INT: 2, HUP: 1 } as const;

/** Linux retains PID visibility, credentials and signal-disposition authority. */
export function createProcessKill(send: ((pid: number, signal: number) => void) | undefined) {
  const signals = linuxSignalConstants();
  return (pid: unknown, signal: unknown = "SIGTERM"): true => {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid < -0x8000_0000 || pid > 0x7fff_ffff) {
      throw Object.assign(new TypeError("The \"pid\" argument must be an integer"), { code: "ERR_INVALID_ARG_TYPE" });
    }
    const number = typeof signal === "number" && Number.isInteger(signal) ? signal
      : typeof signal === "string" && Object.hasOwn(signals, signal || "SIGTERM") ? signals[signal || "SIGTERM"] : signal === null || signal === false ? 15 : undefined;
    if (number === undefined) throw Object.assign(new TypeError(`Unknown signal: ${String(signal)}`), { code: "ERR_UNKNOWN_SIGNAL" });
    if (send === undefined) return unavailableNodeApi("process.kill");
    send(pid, number);
    return true;
  };
}

export type ProcessBuildProperty = { readonly value: object; readonly writable: boolean; readonly configurable: boolean };
export type ProcessBuildMetadata = { readonly config: ProcessBuildProperty; readonly features: ProcessBuildProperty };

/** A catchable signal reaches its listeners by name; without one the process
 * ends by that signal, exactly as Node's default disposition. */
export function deliverProcessSignal(process: NodeProcess, signal: keyof typeof SIGNAL_NUMBERS, ended: (signal: 1 | 2 | 15) => never): void {
  const name = `SIG${signal}`;
  if (process.listenerCount(name) > 0) { process.emit(name, name); return; }
  ended(SIGNAL_NUMBERS[signal]);
}

/** Admit only implemented Node options before any application module runs. */
export function validateNodeEnvironment(env: Readonly<Record<string, string>>, entry: string, execArgv: readonly string[] = []): boolean {
  const input = (env["NODE_OPTIONS"] ?? "").trim();
  let sourceMaps = false;
  for (const token of input === "" ? [] : input.split(/\s+/u)) {
    if (token === "--enable-source-maps" || token === '"--enable-source-maps"') sourceMaps = true;
    else if (token === "--no-enable-source-maps" || token === '"--no-enable-source-maps"') sourceMaps = false;
    else throw new VMError("FEATURE_NOT_AVAILABLE", "NODE_OPTIONS contains an unsupported option", {
      api: "NODE_OPTIONS", importer: entry, backend: "assisted-node",
    });
  }
  for (const flag of decodeForkExecArgv(execArgv)) sourceMaps = flag === "--enable-source-maps";
  return sourceMaps;
}

/** The process owns exit listeners and status; only its trusted worker owner
 * can terminate execution. An application-catchable exception is not exit. */
export class NodeProcess extends EventEmitter {
  #code: number | undefined;
  #exiting = false;
  readonly #now: () => number;
  readonly #terminate: (code: number) => never;
  readonly version: string;
  readonly versions: Readonly<{ node: string }>;
  readonly memoryUsage = processMemoryUsage;
  readonly emitWarning: ReturnType<typeof createWarningEmitter>;
  noDeprecation = false;
  throwDeprecation = false;
  traceDeprecation = false;
  traceProcessWarnings = false;
  constructor(terminate: (code: number) => never, apiVersion: string, now: () => number = monotonicNow, nextTick: (callback: () => void) => void = queueMicrotask, build?: ProcessBuildMetadata) {
    super();
    this.#terminate = terminate;
    this.#now = now;
    this.emitWarning = createWarningEmitter(this, nextTick);
    this.version = `v${apiVersion}`;
    this.versions = Object.freeze({ node: apiVersion });
    if (build !== undefined) for (const name of ["config", "features"] as const) {
      const property = build[name];
      Object.defineProperty(this, name, { ...property, enumerable: true });
    }
    // The loader derives named builtin exports from own enumerable properties.
    const status = Object.getOwnPropertyDescriptor(NodeProcess.prototype, "exitCode");
    if (status === undefined) throw new TypeError("Missing process exit-code descriptor");
    Object.defineProperty(this, "exitCode", { ...status, enumerable: true });
  }
  get exitCode(): number | undefined { return this.#code; }
  set exitCode(value: unknown) {
    if (value === undefined || value === null) { this.#code = undefined; return; }
    const code = typeof value === "string" && value !== "" ? Number(value) : value;
    if (typeof code !== "number" || (typeof value === "string" && Number.isNaN(code))) {
      throw Object.assign(new TypeError("process.exitCode must be a number or numeric string"), { code: "ERR_INVALID_ARG_TYPE" });
    }
    if (!Number.isSafeInteger(code)) throw Object.assign(new RangeError("process.exitCode must be a safe integer"), { code: "ERR_OUT_OF_RANGE" });
    this.#code = code | 0;
  }
  // Worker performance time is monotonic and begins at worker creation. Never
  // derive process elapsed time from Date.now() or invented guest CPU counters.
  readonly uptime = (): number => this.#now() / 1000;
  readonly hrtime = Object.assign((previous?: unknown) => this.#hrtime(previous), {
    bigint: (): bigint => {
      const [seconds, nanoseconds] = this.#hrtime();
      return BigInt(seconds) * 1_000_000_000n + BigInt(nanoseconds);
    },
  });
  #hrtime(previous?: unknown): [number, number] {
    const milliseconds = this.#now();
    let seconds = Math.floor(milliseconds / 1000);
    let nanoseconds = Math.round((milliseconds - seconds * 1000) * 1_000_000);
    if (nanoseconds === 1_000_000_000) { seconds += 1; nanoseconds = 0; }
    if (previous !== undefined) {
      if (!Array.isArray(previous)) throw Object.assign(new TypeError("process.hrtime time must be an array"), { code: "ERR_INVALID_ARG_TYPE" });
      if (previous.length !== 2) throw Object.assign(new RangeError("process.hrtime time must contain two values"), { code: "ERR_OUT_OF_RANGE" });
      const priorSeconds: unknown = previous[0]; const priorNanoseconds: unknown = previous[1];
      if (typeof priorSeconds === "bigint" || typeof priorNanoseconds === "bigint") throw new TypeError("Cannot mix BigInt and other types in process.hrtime");
      seconds -= Number(priorSeconds); nanoseconds -= Number(priorNanoseconds);
      if (nanoseconds < 0) { seconds -= 1; nanoseconds += 1_000_000_000; }
    }
    return [seconds, nanoseconds];
  }
  readonly exit = (...args: unknown[]): never => {
    if (args.length !== 0) this.exitCode = args[0];
    if (!this.#exiting) {
      this.#exiting = true;
      this.emit("exit", this.#code ?? 0);
    }
    return this.#terminate((this.#code ?? 0) & 255);
  };
}
