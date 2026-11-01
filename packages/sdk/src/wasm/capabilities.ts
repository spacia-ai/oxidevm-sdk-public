import type { LinuxFiles, LinuxProcesses, LinuxSockets, LinuxSyncFiles } from "../js-process-types.js";

/** Client-side socket operations. Listening belongs to the runner and is declared by `expose`. */
export type ClientSockets = Pick<LinuxSockets, "socket" | "connect" | "address" | "read" | "write" | "close" | "shutdown">;

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
};

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && Object.hasOwn(CAPABILITY_MIN_API, value);
}

/** Browser features a module may require; the runner probes each before running the adapter. */
export const BROWSER_FEATURES = ["cross-origin-isolated", "indexeddb", "jspi", "web-locks"] as const;
export type BrowserFeature = (typeof BROWSER_FEATURES)[number];

export function isBrowserFeature(value: unknown): value is BrowserFeature {
  return typeof value === "string" && BROWSER_FEATURES.some(feature => feature === value);
}
