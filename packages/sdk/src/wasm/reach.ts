import type { Capability } from "./capabilities.js";

/**
 * How far a module process reaches on the network (engine ADR 0029, N-1): not at all, programs in its own VM, or also
 * the internet through the VM's connection. Rust enforces it for each module process from its launch.
 */
export type ModuleReach = "none" | "vm" | "internet";

/** The tokens that declare a reach; a manifest names at most one, and `net.internet` already includes VM reach. */
export const REACH_TOKENS = ["net.vm", "net.internet"] as const satisfies readonly Capability[];

/**
 * The reach a manifest's `requires.host` declares: `net.internet` or `net.vm`. A manifest from an earlier CLI that names
 * `sockets.connect` alone reads as VM-only reach (owner decision D15); anything else has none.
 */
export function moduleReach(host: readonly Capability[]): ModuleReach {
  if (host.includes("net.internet")) return "internet";
  return host.includes("net.vm") || host.includes("sockets.connect") ? "vm" : "none";
}

const CODES: Readonly<Record<ModuleReach, number>> = { none: 0, vm: 1, internet: 2 };

/** The code OXMC 2 entries and `oxidevm_userspace_spawn_module_process` carry: 0 none, 1 this VM, 2 the internet. */
export function moduleReachCode(reach: ModuleReach): number {
  if (!Object.hasOwn(CODES, reach)) throw new TypeError("Unknown module network reach");
  return CODES[reach];
}
