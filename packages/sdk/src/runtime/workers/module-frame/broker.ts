import { exactKeys, integer, record } from "../../decode.js";
import { VMError } from "../../errors.js";
import { createBrokerRelay, type BrokerRelay } from "../../js-process/broker-relay.js";
import { JS_PROCESS_PROTOCOL_VERSION, protocol, Reader } from "../../js-process/codec.js";
import { decodeRunnerLaunch, type RunnerLaunch, type RunnerVerifiedFile } from "../../js-process/launch.js";
import { isTrappableSignal } from "../../js-process/signals.js";
import { isCopyKey, type CopyKey } from "../../protocol/userspace-module-files.js";
import { MODULE_BROKER_VERSION, MODULE_FRAME_BOOTSTRAP_VERSION } from "../../protocol/module-frame.js";
import { TaskSignals } from "../js-process/task-signals.js";

/**
 * The module frame's broker (engine ADR 0028), module broker protocol 1. It runs in the opaque module frame as a classic
 * blob: worker and starts one runner per module process as a nested classic blob: worker. Shared memory and compiled
 * modules never leave the frame: the broker owns each process's mailbox and signal buffer, relays its Linux requests to
 * the VM's Userspace worker as messages (`js-process/broker-relay.ts`), and compiles each core WebAssembly module once
 * per VM, by the key of its verified copy. Everything a runner sends is hostile input; a malformed message ends only the
 * process that sent it, which the Userspace worker reports with status 125.
 */

/** Processes one broker serves at once, as the native broker. */
export const MODULE_BROKER_PROCESSES = 32;
const INTERRUPT_RETRY_MS = 4;

export interface RunnerWorker {
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
}

export interface ModuleBrokerPorts {
  /** Starts a runner: a classic worker from the runner Blob's URL. */
  readonly startRunner: (pid: number) => RunnerWorker;
  /** The browser's compiler unless a test supplies one. */
  readonly compile?: (bytes: ArrayBuffer) => Promise<WebAssembly.Module>;
}

/** A WebAssembly core module (magic and version 1); only those are compiled. */
function isCoreModule(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength));
  return head.length === 8 && [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00].every((byte, index) => head[index] === byte);
}

/**
 * The start the Userspace worker sends for one process: the runner's launch with its copies, each artifact's key, the
 * TLS module's key (a module with a network reach), and the module's reach code (0 none, 1 this VM, 2 the internet).
 */
interface ProcessStart { readonly launch: RunnerLaunch; readonly keys: Readonly<Record<string, CopyKey>>; readonly tls: CopyKey | null; readonly reach: 0 | 1 | 2 }

export function decodeProcessStart(value: unknown): ProcessStart {
  const start = record(value, "module process start"); exactKeys(start, ["version", "type", "launch", "keys", "tls", "reach"]);
  if (start["version"] !== JS_PROCESS_PROTOCOL_VERSION || start["type"] !== "start") protocol("Invalid module process start");
  const launch = decodeRunnerLaunch(start["launch"]), keys = record(start["keys"], "module artifact keys"), tls = start["tls"], reach = start["reach"];
  const names = Object.keys(launch.artifacts);
  if (Object.keys(keys).length !== names.length) protocol("Module artifact keys do not match the launch");
  if (Object.values(launch.artifacts).some(file => file.module !== null) || launch.tls !== null && launch.tls.module !== null) protocol("A compiled module cannot cross the module frame");
  if ((tls === null) !== (launch.tls === null) || tls !== null && !isCopyKey(tls)) protocol("The TLS module key does not match the launch");
  if (reach !== 0 && reach !== 1 && reach !== 2) protocol("Invalid module network reach");
  const decoded: Record<string, CopyKey> = {};
  for (const name of names) { const key = keys[name]; if (!isCopyKey(key)) protocol("Module artifact key is invalid"); decoded[name] = key; }
  return { launch, keys: decoded, tls: isCopyKey(tls) ? tls : null, reach };
}

export class ModuleBroker {
  readonly #ports: ModuleBrokerPorts;
  readonly #compiled = new Map<CopyKey, Promise<WebAssembly.Module | null>>();
  #processes = 0;

  constructor(ports: ModuleBrokerPorts) { this.#ports = ports; }

  /** Serves the Userspace worker's attached port: one `spawn` per process, each with its own channel. */
  attach(port: MessagePort): void {
    port.onmessage = (event: MessageEvent<unknown>) => {
      const command = record(event.data, "module broker command"); exactKeys(command, ["version", "type", "pid", "port"]);
      const connection = command["port"];
      if (!(connection instanceof MessagePort)) protocol("Module process channel is absent");
      try {
        if (command["version"] !== MODULE_BROKER_VERSION || command["type"] !== "spawn" || this.#processes >= MODULE_BROKER_PROCESSES) protocol("Invalid module process launch");
        this.#processes++;
        this.#serve(connection, integer(command["pid"], "module process PID", 1, 0x7fff_ffff), () => { this.#processes--; });
      } catch (error) { reportError(connection, error); connection.close(); }
    };
    port.start();
  }

  /** The compiled module of a verified copy, compiled at most once per key for as long as the frame lives. */
  async #module(key: CopyKey, file: RunnerVerifiedFile): Promise<WebAssembly.Module | null> {
    let compiled = this.#compiled.get(key);
    if (compiled === undefined) {
      const compile = this.#ports.compile ?? (bytes => WebAssembly.compile(bytes));
      compiled = file.blob.arrayBuffer().then(bytes => isCoreModule(bytes) ? compile(bytes) : null).catch(() => null);
      this.#compiled.set(key, compiled);
    }
    return compiled;
  }

  async #withModules(start: ProcessStart): Promise<RunnerLaunch> {
    const artifacts: Record<string, RunnerVerifiedFile> = {};
    for (const [name, file] of Object.entries(start.launch.artifacts)) artifacts[name] = { blob: file.blob, module: await this.#module(start.keys[name] ?? protocol("Missing artifact key"), file) };
    // The TLS module is compiled once per frame, the first time a module with a network reach starts (ADR 0029).
    const tls = start.launch.tls === null || start.tls === null ? null : { blob: start.launch.tls.blob, module: await this.#module(start.tls, start.launch.tls) };
    return { ...start.launch, artifacts, tls };
  }

  #serve(connection: MessagePort, pid: number, retired: () => void): void {
    let worker: RunnerWorker | undefined, stopped = false, retry: ReturnType<typeof setTimeout> | undefined;
    const signals = new TaskSignals();
    const stop = (): void => {
      if (stopped) return; stopped = true; retired(); clearTimeout(retry);
      worker?.terminate(); relay.close(); connection.close();
    };
    const fail = (error: unknown): void => { if (stopped) return; reportError(connection, error); stop(); };
    // Pyodide's interrupt word is retried while the module has not taken the previous signal from it.
    const offer = (): void => {
      signals.offerInterrupts(); clearTimeout(retry);
      if (signals.waiting && !stopped) retry = setTimeout(offer, INTERRUPT_RETRY_MS);
    };
    // Until the start arrives no request can come; then the module's declared reach (ADR 0029).
    let reach: ProcessStart["reach"] = 0;
    const relay: BrokerRelay = createBrokerRelay({
      fail, sequential: true, after: offer, refuse: (operation, payload) => refuseBeyondReach(reach, operation, payload),
      // A caught signal reaches the process as a notice on the service port, before any completion it interrupted.
      control: message => {
        if (message["type"] !== "signal-notice") return false;
        exactKeys(message, ["version", "type", "signal", "interrupt", "code", "sender", "uid", "value"]);
        const signal = message["signal"], interrupt = message["interrupt"], value = message["value"];
        if (message["version"] !== JS_PROCESS_PROTOCOL_VERSION || !isTrappableSignal(signal) || typeof interrupt !== "boolean" || typeof value !== "bigint" || value < 0n || value > 0xffff_ffff_ffff_ffffn) protocol("Malformed signal notice");
        const details = { code: integer(message["code"], "signal code", -0x8000_0000, 0x7fff_ffff), sender: integer(message["sender"], "signal sender", 0, 0x7fff_ffff), uid: integer(message["uid"], "signal uid", 0, 0xffff_ffff), value };
        signals.deliver({ signal, interrupt, details });
        relay.post({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal" });
        return true;
      },
      // The runner ends killed by a signal: the Userspace worker asks Rust, and no exit follows.
      local: message => {
        if (message["type"] !== "signaled") return false;
        exactKeys(message, ["version", "type", "signal"]);
        if (message["version"] !== JS_PROCESS_PROTOCOL_VERSION || !isTrappableSignal(message["signal"])) protocol("Malformed signal exit");
        return true;
      },
    });
    connection.onmessage = (event: MessageEvent<unknown>) => {
      try {
        const request = record(event.data, "module process command");
        if (request["type"] === "stop") { exactKeys(request, ["version", "type"]); if (request["version"] !== MODULE_BROKER_VERSION) protocol("Module stop version mismatch"); stop(); return; }
        exactKeys(request, ["version", "type", "value", "port", "attention"]);
        const upstream = request["port"], attention = request["attention"];
        if (request["version"] !== MODULE_BROKER_VERSION || request["type"] !== "start" || !(upstream instanceof MessagePort) || attention !== null && !(attention instanceof MessagePort) || worker !== undefined) protocol("Invalid module process start");
        const start = decodeProcessStart(request["value"]);
        reach = start.reach;
        relay.attach(upstream, attention);
        const runner = worker = this.#ports.startRunner(pid);
        // A runner can post what cannot be forwarded (a port it did not transfer): that ends its process only, never the
        // broker, whose uncaught error would make the frame end every module process.
        runner.onmessage = (message: MessageEvent<unknown>) => {
          if (stopped) return;
          try { connection.postMessage({ version: MODULE_BROKER_VERSION, type: "message", value: message.data }); }
          catch { fail(new VMError("PROTOCOL_ERROR", "Module runner message could not be forwarded")); }
        };
        runner.onerror = (error: ErrorEvent) => { error.preventDefault(); fail(new VMError("VM_FAULT", error.message || "Module runner failed")); };
        runner.onmessageerror = () => { fail(new VMError("PROTOCOL_ERROR", "Module runner message could not be decoded")); };
        void this.#withModules(start).then(launch => {
          if (stopped) return;
          runner.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "start", port: relay.port, mailbox: relay.mailbox, signals: signals.buffer, launch }, [relay.port]);
        }, fail);
      } catch (error) { fail(error); }
    };
    connection.onmessageerror = () => { fail(new VMError("PROTOCOL_ERROR", "Module process command could not be decoded")); };
    connection.start();
  }
}

const EACCES = 13, CONNECT = 42, SENDTO = 44;

/**
 * The broker's own reach check (engine ADR 0029, Enforcement: defence in depth before Rust, with the same answer): a
 * module that declares no reach opens no client connection and sends no datagram, so connect(2) and sendto(2) with a
 * destination are EACCES here. Rust enforces every reach, including VM-only, for each module process.
 */
export function refuseBeyondReach(reach: ProcessStart["reach"], operation: number, payload: Uint8Array): number | undefined {
  if (reach !== 0) return undefined;
  if (operation === CONNECT) return EACCES;
  if (operation !== SENDTO) return undefined;
  // sendto is fd, bytes, flags and, only with a destination, its address; a plain write on a socket has none.
  const reader = new Reader(payload);
  try { reader.u64(); reader.blob(); reader.u64(); } catch { return undefined; }
  try { reader.end(); return undefined; } catch { return EACCES; }
}

/**
 * Serves the frame document's control port for a broker: one `attach` carrying the Userspace worker's port and the page's
 * heartbeat port. The broker, not the frame document, answers each `ping` with a `pong`, so a broker that dies (out of
 * memory, say) stops answering and the page's watch ends the VM's module processes with status 125 and reopens the frame
 * on the next call. Returns the end of the service, which closes both ports. A malformed attachment goes to `failed`.
 */
export function serveBrokerControl(control: MessagePort, broker: ModuleBroker, failed: (error: unknown) => void = error => { throw error; }): () => void {
  let attached = false, heartbeat: MessagePort | undefined;
  const stop = (): void => { control.close(); heartbeat?.close(); };
  control.onmessage = (message: MessageEvent<unknown>) => {
    try {
      const attach = record(message.data, "module broker attachment"); exactKeys(attach, ["version", "type", "port", "liveness"]);
      const port = attach["port"], liveness = attach["liveness"];
      if (attached || attach["version"] !== MODULE_FRAME_BOOTSTRAP_VERSION || attach["type"] !== "attach" || !(port instanceof MessagePort) || !(liveness instanceof MessagePort)) protocol("Invalid module broker attachment");
      attached = true; heartbeat = liveness;
      liveness.onmessage = () => { liveness.postMessage("pong"); };
      liveness.start();
      broker.attach(port);
    } catch (error: unknown) { failed(error); }
  };
  control.start();
  return stop;
}

function reportError(connection: MessagePort, error: unknown): void {
  try { connection.postMessage({ version: MODULE_BROKER_VERSION, type: "error", message: error instanceof Error ? error.message.slice(0, 1024) : "Module broker failed" }); }
  catch { /* the channel is gone */ }
}
