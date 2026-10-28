import type { UserspaceOperations } from "../userspace-protocol.js";
import type { UserspaceJitTier } from "../jit-tier-option.js";
import { VMError } from "../errors.js";
import { assertUserspaceStatus, callUserspaceU32 as call } from "./userspace-exports.js";

/** What every runtime the worker mounts is configured with, decided once by its initialize request. */
export interface UserspaceMountSettings {
  /**
   * The embedder's bound on live processes, forked descendants included. Without one the worker
   * leaves the engine's own cap (4,096 live processes) in place; the public `createVM` always
   * passes one (32 unless the image recommends another).
   */
  readonly processLimit: number | undefined;
  readonly initialUser: "user" | "root";
  readonly rootPersistence: "ephemeral" | "persistent";
  readonly syscallTraceCapacity: number;
  readonly jitTier: UserspaceJitTier;
}

export const UNCONFIGURED_MOUNT: UserspaceMountSettings = { processLimit: undefined, initialUser: "user", rootPersistence: "ephemeral", syscallTraceCapacity: 0, jitTier: "tier1" };

export function readEffectiveJitTier(instance: Pick<WebAssembly.Instance, "exports">): UserspaceJitTier {
  const tier = call(instance, "oxidevm_userspace_jit_tier");
  if (tier === 1) return "tier1";
  if (tier === 2) return "tier2";
  throw new VMError("PROTOCOL_ERROR", "Userspace effective JIT tier is unavailable");
}

export function mountSettings(request: UserspaceOperations["initialize"]["request"]): UserspaceMountSettings {
  return { processLimit: request.maxProcesses, initialUser: request.initialUser ?? "user", rootPersistence: request.rootPersistence ?? "ephemeral", syscallTraceCapacity: request.syscallTraceCapacity ?? 0, jitTier: request.jitTier ?? "tier1" };
}

/** Applies the settings to a freshly mounted runtime through the engine's exports. */
export function configureMountedRuntime(instance: Pick<WebAssembly.Instance, "exports">, settings: UserspaceMountSettings, networkEnabled: boolean): void {
  const tier = settings.jitTier === "tier2" ? 2 : 1;
  assertUserspaceStatus(call(instance, "oxidevm_userspace_jit_configure", tier), "configure JIT tier");
  if (readEffectiveJitTier(instance) !== settings.jitTier) throw new VMError("CORE_LOAD_FAILED", "Userspace JIT tier was not admitted");
  if (settings.processLimit !== undefined) assertUserspaceStatus(call(instance, "oxidevm_userspace_process_limit", settings.processLimit), "configure process limit");
  assertUserspaceStatus(call(instance, "oxidevm_userspace_configure_initial_user", settings.initialUser === "root" ? 1 : 0), "configure initial credentials");
  if (settings.syscallTraceCapacity !== 0) assertUserspaceStatus(call(instance, "oxidevm_userspace_syscall_trace_configure", settings.syscallTraceCapacity), "configure syscall trace");
  if (networkEnabled) assertUserspaceStatus(call(instance, "oxidevm_userspace_network_enable"), "enable network");
}
