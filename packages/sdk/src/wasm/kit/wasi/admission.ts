import { BRIDGE_NAMESPACE, PREVIEW1_NAMESPACE, isPreview1Name } from "./imports.js";

/** A program the profile refuses before any of its code runs; `reason` names the first offending import or export. */
export class AdmissionError extends Error {
  override readonly name = "AdmissionError";
}

/**
 * Checks a compiled program's imports and exports against the first-release profile: only function imports, only from
 * wasi_snapshot_preview1 (by known name) or the bridge namespace of this ABI major, a `_start` function and an exported
 * `memory`. A program that fails runs no code.
 */
export function admitProgram(module: WebAssembly.Module, bridgeNames: ReadonlySet<string>): void {
  for (const entry of WebAssembly.Module.imports(module)) {
    const where = `${entry.module}.${entry.name}`;
    if (entry.kind !== "function") throw new AdmissionError(`imports a ${entry.kind} (${where}); the profile admits function imports only`);
    if (entry.module === PREVIEW1_NAMESPACE) {
      if (!isPreview1Name(entry.name)) throw new AdmissionError(`imports ${where}, which WASI Preview1 does not define`);
      continue;
    }
    const major = /^oxidevm_bridge_v(\d+)$/u.exec(entry.module);
    if (major !== null && entry.module !== BRIDGE_NAMESPACE) throw new AdmissionError(`imports ${where}: bridge ABI major ${major[1] ?? "?"} is not supported (this module serves ${BRIDGE_NAMESPACE})`);
    if (entry.module === BRIDGE_NAMESPACE) {
      if (!bridgeNames.has(entry.name)) throw new AdmissionError(`imports ${where}, which ${BRIDGE_NAMESPACE} does not define`);
      continue;
    }
    throw new AdmissionError(`imports from the unknown namespace ${entry.module} (${where})`);
  }
  const exports = new Map(WebAssembly.Module.exports(module).map(entry => [entry.name, entry.kind]));
  if (exports.get("_start") !== "function") throw new AdmissionError("exports no _start function; build it as a wasm32-wasip1 command");
  if (exports.get("memory") !== "memory") throw new AdmissionError("exports no memory");
}
