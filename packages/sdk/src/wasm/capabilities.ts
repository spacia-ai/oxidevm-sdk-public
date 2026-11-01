import type { LinuxFiles, LinuxProcesses, LinuxSockets, LinuxSyncFiles } from "../js-process-types.js";

/** Client-side socket operations. Listening belongs to the runner and is declared by `expose`. */
export type ClientSockets = Pick<LinuxSockets, "socket" | "connect" | "address" | "read" | "write" | "close" | "shutdown">;

/** The signals a module can trap (engine ADR 0027). SIGKILL and SIGSTOP can never be caught, and real-time signals are out of scope. */
export type TrappableSignal = "SIGHUP" | "SIGINT" | "SIGQUIT" | "SIGTERM" | "SIGUSR1" | "SIGUSR2";

/** The signals a module trapped: each reaches the module through this iterator instead of its default action. */
export interface SignalTrap extends AsyncIterable<TrappableSignal> {
  readonly signals: readonly TrappableSignal[];
  /** Pyodide interrupt-buffer format: the runtime writes the signal number into [0] at delivery; the reader resets it. */
  readonly interruptBuffer: Int32Array;
  untrap(): Promise<void>;
}

/** This process's signals: a signal that is not trapped keeps its default action. */
export interface ProcessSignals {
  trap(signals: readonly TrappableSignal[]): Promise<SignalTrap>;
  /** Ends this process killed by the signal when it is not trapped; never settles in that case. */
  raise(signal: TrappableSignal): Promise<void>;
}

/**
 * Host operations an adapter may be granted. A manifest names them in `requires.host`;
 * the adapter's `host` type contains exactly the members of the named capabilities, and the
 * runner hands over nothing else.
 */
export interface CapabilityMap {
  readonly "files.sync": { readonly fs: LinuxSyncFiles };
  readonly "files.async": { readonly files: LinuxFiles };
  readonly "sockets.connect": { readonly sockets: ClientSockets };
  readonly "process.info": { readonly process: Pick<LinuxProcesses, "info" | "cwd"> };
  readonly "process.spawn": { readonly process: Pick<LinuxProcesses, "spawn" | "wait" | "signal"> };
  readonly "process.signals": { readonly process: { readonly signals: ProcessSignals } };
}
export type Capability = keyof CapabilityMap;

/** The first Userspace API version that serves every operation behind a capability. */
export const CAPABILITY_MIN_API: Readonly<Record<Capability, number>> = {
  // 144 added utimes (utimensat, 280) and write with noSignal (sendto, 44) to both file facades.
  "files.sync": 144,
  "files.async": 144,
  "sockets.connect": 143,
  "process.info": 143,
  "process.spawn": 143,
  // 145 delivers the trappable signals of a JS process to the process instead of their default action (engine ADR 0027).
  "process.signals": 145,
};

/** The first Userspace API version that runs a module's `commands` from the VM's PATH (engine ADR 0027). */
export const COMMANDS_MIN_API = 145;

/**
 * The first Userspace API version that serves everything a manifest declares: each capability and, when it declares
 * them, its commands. The parameter is structural so this leaf needs none of the manifest types.
 */
export function manifestMinApi(manifest: { readonly requires: { readonly host: readonly Capability[] }; readonly commands?: readonly string[] }): number {
  return Math.max(0, ...manifest.requires.host.map(capability => CAPABILITY_MIN_API[capability]), ...(manifest.commands === undefined ? [] : [COMMANDS_MIN_API]));
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && Object.hasOwn(CAPABILITY_MIN_API, value);
}

/** Browser features a module may require; the runner probes each before running the adapter. */
export const BROWSER_FEATURES = ["cross-origin-isolated", "indexeddb", "jspi", "web-locks"] as const;
export type BrowserFeature = (typeof BROWSER_FEATURES)[number];

export function isBrowserFeature(value: unknown): value is BrowserFeature {
  return typeof value === "string" && BROWSER_FEATURES.some(feature => feature === value);
}
