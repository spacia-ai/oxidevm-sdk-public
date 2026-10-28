import { boolean, exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import type { SystemTraceJitModule, SystemTraceJitOperationSample, SystemTraceProfile } from "./system.js";
import { decodeJitModules } from "./system-trace.js";
import { decodeInterpreterReasonProfiles } from "./system-trace-profile.js";
import { decodeInterpretedActionReasonProfiles } from "./system-trace-interpreted-actions.js";
import { SYSTEM_TRACE_SCHEMA_VERSION } from "./system-trace-schema.js";
import { decodeJitOperationSamples } from "./system-trace-jit.js";

export const MAX_USERSPACE_JIT_PROFILE_MODULES = 4096;
export const MAX_USERSPACE_JIT_PROFILE_ENTRIES = 65_536;
export const MAX_USERSPACE_JIT_PROFILE_SAMPLES = 8192;

/** These maps and counters cover one VM, including its native children. */
export interface UserspaceJitProfile {
  readonly version: 1;
  readonly runtimeKey: string;
  readonly instructionProfiling: boolean;
  readonly modules: readonly SystemTraceJitModule[];
  readonly droppedModules: number;
  readonly collidingModules: number;
  readonly operationSamples: readonly SystemTraceJitOperationSample[];
  readonly droppedOperationSamples: number;
  readonly operationSampleTotal: number;
  readonly operationSamplePeriod: number;
  readonly interpreterReasons: SystemTraceProfile["worker"]["interpreterReasons"];
  readonly interpretedActionReasons: SystemTraceProfile["worker"]["interpretedActionReasons"];
}

export function decodeUserspaceJitProfile(value: unknown): UserspaceJitProfile {
  const input = record(value, "Userspace JIT profile");
  exactKeys(input, ["version", "runtimeKey", "instructionProfiling", "modules", "droppedModules", "collidingModules", "operationSamples", "droppedOperationSamples", "operationSampleTotal", "operationSamplePeriod", "interpreterReasons", "interpretedActionReasons"]);
  integer(input["version"], "Userspace JIT profile version", 1, 1);
  const runtimeKey = string(input["runtimeKey"], "Userspace JIT runtime key");
  const modules = input["modules"];
  if (runtimeKey.length === 0 || runtimeKey.length > 256 || !Array.isArray(modules) || modules.length > MAX_USERSPACE_JIT_PROFILE_MODULES) {
    throw new VMError("PROTOCOL_ERROR", "Userspace JIT profile identity or module bound is invalid");
  }
  let entries = 0;
  for (const value of modules) {
    const module = record(value, "Userspace JIT module");
    const instructions = module["instructions"], operations = module["operations"];
    if (!Array.isArray(instructions) || !Array.isArray(operations)) throw new VMError("PROTOCOL_ERROR", "Userspace JIT module entries are invalid");
    entries += instructions.length + operations.length;
    if (entries > MAX_USERSPACE_JIT_PROFILE_ENTRIES) throw new VMError("PROTOCOL_ERROR", "Userspace JIT profile entries exceed their bound");
  }
  const rawSamples = input["operationSamples"];
  if (!Array.isArray(rawSamples) || rawSamples.length > MAX_USERSPACE_JIT_PROFILE_SAMPLES) throw new VMError("PROTOCOL_ERROR", "Userspace JIT samples exceed their bound");
  const operationSamples = decodeJitOperationSamples(rawSamples, true);
  const droppedOperationSamples = integer(input["droppedOperationSamples"], "dropped Userspace JIT samples", 0);
  const operationSampleTotal = integer(input["operationSampleTotal"], "Userspace JIT sample total", 0);
  if (operationSamples.reduce((count, sample) => count + sample.samples, droppedOperationSamples) !== operationSampleTotal) throw new VMError("PROTOCOL_ERROR", "Userspace JIT sample counts do not reconcile");
  return { version: 1, runtimeKey, instructionProfiling: boolean(input["instructionProfiling"], "Userspace instruction profiling"), modules: decodeJitModules(modules, SYSTEM_TRACE_SCHEMA_VERSION),
    droppedModules: integer(input["droppedModules"], "dropped Userspace JIT maps", 0),
    collidingModules: integer(input["collidingModules"], "colliding Userspace JIT maps", 0),
    operationSamples, droppedOperationSamples, operationSampleTotal,
    operationSamplePeriod: integer(input["operationSamplePeriod"], "Userspace JIT sample period", 1),
    interpreterReasons: decodeInterpreterReasonProfiles(input["interpreterReasons"], SYSTEM_TRACE_SCHEMA_VERSION),
    interpretedActionReasons: decodeInterpretedActionReasonProfiles(input["interpretedActionReasons"], SYSTEM_TRACE_SCHEMA_VERSION) };
}
