import { engineRelease } from "../../engine.generated.js";
import { VMError } from "../../runtime/errors.js";
import type { Pin } from "../handle.js";
import type { ModuleReach } from "../reach.js";

/**
 * The engine's TLS module as a module file (engine ADR 0029, N-4): a module with a network reach starts with it, and the
 * VM's verified-copy store holds it like any pinned file, so it is fetched once per VM, checked against the engine
 * release's pin, and compiled once per module frame by its broker. A VM whose modules never reach the network never
 * fetches it.
 */
export const TLS_FILE = "oxidevm_tls.wasm";

/** The pin of the TLS module in the engine release this SDK pins. */
export function tlsPin(): Pin {
  const artifact = engineRelease.artifacts.find(entry => entry.name === TLS_FILE);
  if (artifact === undefined) throw new VMError("CORE_LOAD_FAILED", `The pinned engine release has no ${TLS_FILE}`);
  return { sha256: artifact.sha256, bytes: artifact.bytes };
}

/** Whether a module of this reach starts with the TLS module. */
export function startsWithTls(reach: ModuleReach): boolean { return reach !== "none"; }
