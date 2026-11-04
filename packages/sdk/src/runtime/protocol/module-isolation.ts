import { VMError } from "../errors.js";

// The closed reasons a browser cannot run modules in isolation (engine ADR 0028). They are DOM-free so the Node side
// (`oxidevm wasm test`'s report) shares them with the module frame's protocol, which owns the frame's messages.

/** Why modules cannot run in this browser (`FEATURE_NOT_AVAILABLE`, `reason: "wasm-module-isolation-unavailable"`). */
export const MODULE_ISOLATION_CAPABILITIES = [
  "frame-load", "frame-cross-origin-isolation", "separate-origin", "worker-shared-memory", "worker-atomics-wait",
  "blob-workers", "wasm-compilation", "separate-agent-cluster", "module-frame-lost", "frame-policy",
] as const;
export type ModuleIsolationCapability = (typeof MODULE_ISOLATION_CAPABILITIES)[number];
export const MODULE_ISOLATION_REASON = "wasm-module-isolation-unavailable";

export function isolationUnavailable(capability: ModuleIsolationCapability, message: string): VMError {
  return new VMError("FEATURE_NOT_AVAILABLE", message, { reason: MODULE_ISOLATION_REASON, capability });
}
