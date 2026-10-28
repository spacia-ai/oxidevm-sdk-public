import { MAX_USERSPACE_JIT_PROFILE_ENTRIES, MAX_USERSPACE_JIT_PROFILE_MODULES, MAX_USERSPACE_JIT_PROFILE_SAMPLES, type UserspaceJitProfile } from "../protocol/userspace-jit-profile.js";
import { JIT_OPERATION_SAMPLE_PERIOD } from "../core-abi.js";
import type { Core } from "./control/core.js";
import { copyInterpretedActionReasonProfiles, copyInterpreterReasonProfiles } from "./control/telemetry.js";

type JitProfileSource = Pick<Core, "runtimeKey" | "profileJitModules" | "droppedProfileJitModules" | "collidingProfileJitModules" | "traceProfile" | "profileJitOperationSamples" | "profileJitOperationSampleTotal" | "droppedProfileJitOperationSamples">;

/** Retained counters can use live maps only from the runtime that produced them. */
export function captureUserspaceJitProfileForRuntime(core: JitProfileSource | undefined, runtimeKey: string, instructionProfiling: boolean): UserspaceJitProfile | undefined {
  return core?.runtimeKey === runtimeKey ? captureUserspaceJitProfile(core, instructionProfiling) : undefined;
}

/** Read existing maps only on a diagnostic request, never on ordinary process retirement. */
export function captureUserspaceJitProfile(core: JitProfileSource, instructionProfiling: boolean): UserspaceJitProfile {
  const modules: UserspaceJitProfile["modules"][number][] = [];
  let entries = 0;
  // Prefer recent bindings when the bounded diagnostic window omits older maps.
  for (const module of [...core.profileJitModules.values()].reverse()) {
    const count = module.instructions.length + module.operations.length;
    if (modules.length === MAX_USERSPACE_JIT_PROFILE_MODULES || entries + count > MAX_USERSPACE_JIT_PROFILE_ENTRIES) continue;
    entries += count; modules.push(module);
  }
  const ids = new Set(modules.map(module => module.profileModuleId));
  const operationSamples: UserspaceJitProfile["operationSamples"][number][] = [];
  let droppedOperationSamples = core.droppedProfileJitOperationSamples;
  for (const sample of core.profileJitOperationSamples.values()) {
    if (operationSamples.length === MAX_USERSPACE_JIT_PROFILE_SAMPLES || !ids.has(sample.profileModuleId)) droppedOperationSamples += sample.samples;
    else operationSamples.push(sample);
  }
  return { version: 1, runtimeKey: core.runtimeKey, instructionProfiling, modules,
    droppedModules: core.droppedProfileJitModules + core.profileJitModules.size - modules.length,
    collidingModules: core.collidingProfileJitModules,
    operationSamples, droppedOperationSamples, operationSampleTotal: core.profileJitOperationSampleTotal, operationSamplePeriod: JIT_OPERATION_SAMPLE_PERIOD,
    interpreterReasons: copyInterpreterReasonProfiles(core.traceProfile.worker.interpreterReasons),
    interpretedActionReasons: copyInterpretedActionReasonProfiles(core.traceProfile.worker.interpretedActionReasons) };
}
