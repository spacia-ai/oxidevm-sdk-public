import { VMError } from "../../errors.js";
import { equalBytes } from "../../jit-cache.js";
import {
  type CoreRunExit,
  JIT_DISPATCH_SLOT_GENERATIONS_OFFSET,
  decodeJitModuleExit,
  type CoreJitModuleExit,
} from "../../core-abi.js";
import { type JitModuleTraceMap } from "../../protocol/system-trace-jit.js";
import {
  EMPTY_JIT_AOT_TRAINING_STATS,
  type JitAotTrainingStats,
} from "../../protocol/system-trace-jit-aot.js";
import { type Core, type JitBlock, callNumber } from "./core.js";

export const TRACE_RECORDING_INVOCATION_PERIOD = 64;

export function assertExecutableArtifactBytes(
  expected: Uint8Array | undefined,
  moduleBytes: Uint8Array,
  length: number,
): void {
  if (expected === undefined) return;
  if (!Number.isSafeInteger(length) || length <= 0 ||
      length > moduleBytes.byteLength || expected.byteLength !== length ||
      !equalBytes(expected, moduleBytes.subarray(0, length))) {
    throw new VMError("VM_FAULT", "JIT executable artifact bytes differ from its binding");
  }
}

export class TraceRecordingCadence {
  private invocations = 0;

  reset(): void {
    this.invocations = 0;
  }

  takeWindow(): boolean {
    this.invocations += 1;
    if (this.invocations < TRACE_RECORDING_INVOCATION_PERIOD) return false;
    this.invocations = 0;
    return true;
  }

  advance(before: bigint, after: bigint): void {
    if (after < before) {
      throw new VMError("VM_FAULT", "JIT retired count moved backwards");
    }
  }
}

export function validatePreparedJitModuleLength(
  actual: number,
  expected: number,
): boolean {
  if (actual === expected) return true;
  if (actual === 0) return false;
  throw new VMError(
    "VM_FAULT",
    "JIT action lengths changed before execution",
  );
}

export function retainProfileJitModule(
  loaded: Core,
  moduleMap: JitModuleTraceMap,
  cacheKey: bigint,
  aotTraining: JitAotTrainingStats = EMPTY_JIT_AOT_TRAINING_STATS,
): void {
  const id = moduleMap.profileModuleId;
  if (id === null || loaded.collidingProfileJitModuleIds.has(id)) return;
  const current = loaded.profileJitModules.get(id);
  if (current !== undefined) {
    if (current.cacheKey !== cacheKey || !sameModuleMap(current, moduleMap)) {
      loaded.profileJitModules.delete(id);
      loaded.collidingProfileJitModuleIds.add(id);
      loaded.collidingProfileJitModules += 1;
      return;
    }
  }
  const retained = loaded.profileJitModules.retain({
    ...moduleMap,
    profileModuleId: id,
    cacheKey,
    aotTraining,
  });
  if (retained !== "retained") {
    loaded.droppedProfileJitModules += 1;
  }
}

export function validateResidentGuardExecution(
  execution: CoreRunExit,
  residentInterpreted: bigint,
  executionBudget: number,
): Extract<CoreRunExit, { readonly kind: "step-limit" }> | undefined {
  if (residentInterpreted === 0n) return undefined;
  if (
    execution.kind !== "step-limit" ||
    execution.steps <= 0n ||
    execution.steps > BigInt(executionBudget) ||
    residentInterpreted > execution.steps
  ) {
    throw new VMError(
      "VM_FAULT",
      "compiled JIT block reported an invalid resident guard execution",
    );
  }
  return execution;
}

/** Run-result steps charge fault attempts; the context owns committed retirement. */
export function jitRetiredInstructions(
  execution: CoreRunExit,
  retired: bigint,
  residentInterpreted: bigint,
): bigint {
  const chargedFault = execution.kind === "exception" && execution.steps === retired + 1n;
  if (
    retired < 0n || residentInterpreted < 0n || residentInterpreted > retired
    || (execution.steps !== retired && !chargedFault)
  ) {
    throw new VMError("VM_FAULT", "compiled JIT execution has an invalid retirement boundary");
  }
  return retired - residentInterpreted;
}

export function synchronizeJitDispatchGeneration(
  loaded: Pick<Core, "exports" | "memory">,
  block: JitBlock,
): void {
  const contextPointer = callNumber(loaded, "oxidevm_jit_context_ptr");
  const generation = new DataView(loaded.memory.buffer).getUint32(
    contextPointer + JIT_DISPATCH_SLOT_GENERATIONS_OFFSET + block.slot * 4,
    true,
  );
  if (generation === 0) {
    throw new VMError(
      "VM_FAULT",
      "registered JIT dispatch slot has no authoritative generation",
    );
  }
  block.dispatchGeneration = generation;
}

export function jitTraceExit(
  rawExit: number,
): CoreJitModuleExit {
  return decodeJitModuleExit(rawExit);
}

export function sameModuleMap(left: JitModuleTraceMap, right: JitModuleTraceMap): boolean {
  if (left.artifactIdentity?.cacheKey !== right.artifactIdentity?.cacheKey || left.artifactIdentity?.moduleLength !== right.artifactIdentity?.moduleLength || left.bindingIdentity?.id !== right.bindingIdentity?.id || left.bindingIdentity?.originBindingId !== right.bindingIdentity?.originBindingId || left.artifactProfileModuleId !== right.artifactProfileModuleId || left.tier !== right.tier || left.recordedProfileGeneration !== right.recordedProfileGeneration || !sameRuntimeIdentity(left.runtimeIdentity, right.runtimeIdentity) || !sameAotTrainingSource(left.aotTrainingSource, right.aotTrainingSource) || left.instructions.length !== right.instructions.length || left.operations.length !== right.operations.length || left.plan.initialStateMask !== right.plan.initialStateMask || left.plan.dirtyStateMask !== right.plan.dirtyStateMask || left.plan.stateMaterializationBoundaries !== right.plan.stateMaterializationBoundaries || left.plan.segmentGuards !== right.plan.segmentGuards) return false;
  return left.instructions.every((value, index) => {
    const other = right.instructions[index];
    return other !== undefined && value.rip === other.rip && value.semantic === other.semantic && value.retired === other.retired && value.instructionForm === other.instructionForm;
  }) && left.operations.every((value, index) => {
    const other = right.operations[index];
    return other !== undefined && value.instructionIndex === other.instructionIndex && value.sourceIndex === other.sourceIndex && value.disposition === other.disposition && value.emittedStart === other.emittedStart && value.emittedEnd === other.emittedEnd && value.wireStart === other.wireStart && value.wireEnd === other.wireEnd && value.instructionForm === other.instructionForm && value.operationKind === other.operationKind && value.proofCostClass === other.proofCostClass;
  });
}

function sameAotTrainingSource(
  left: JitModuleTraceMap["aotTrainingSource"],
  right: JitModuleTraceMap["aotTrainingSource"],
): boolean {
  if (left === null || right === null) return left === right;
  return left.instructions.length === right.instructions.length
    && left.instructions.every((instruction, index) => {
      const other = right.instructions[index];
      return other !== undefined
        && instruction.rip === other.rip
        && instruction.bytes === other.bytes
        && instruction.semantic === other.semantic
        && instruction.instructionForm === other.instructionForm
        && JSON.stringify(instruction.edge, (_, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value
        ) === JSON.stringify(other.edge, (_, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value
        );
    });
}

function sameRuntimeIdentity(
  left: JitModuleTraceMap["runtimeIdentity"],
  right: JitModuleTraceMap["runtimeIdentity"],
): boolean {
  if (left === null || right === null) return left === right;
  return left.mode === right.mode
    && left.cpl === right.cpl
    && left.profile === right.profile
    && left.codeAttributes === right.codeAttributes
    && left.addressSpaceId === right.addressSpaceId
    && left.addressSpaceScoped === right.addressSpaceScoped
    && left.codePages.length === right.codePages.length
    && left.codePages.every((page, index) => {
      const other = right.codePages[index];
      return other !== undefined
        && page.linear === other.linear
        && page.physical === other.physical
        && page.generation === other.generation
        && page.globalSupervisor === other.globalSupervisor;
    });
}

export function jitCompletionFailures(mask: number): readonly string[] {
  const failures: string[] = [];
  for (const [bit, name] of [
    [0, "invalid-exit"],
    [1, "unexpected-exception"],
    [2, "zero-retirement"],
    [3, "budget-exceeded"],
    [4, "device-ticks-exceeded"],
    [5, "unexpected-rip"],
    [6, "halt-mismatch"],
    [7, "missing-metadata"],
    [8, "invalid-context"],
    [9, "missing-pending"],
    [10, "fault-mismatch"],
    [11, "bridge-mismatch"],
    [12, "trace-record-header"],
    [13, "trace-record-source-identity"],
    [14, "trace-record-target-identity"],
    [15, "trace-record-payload"],
    [16, "tier-retirement-mismatch"],
    [17, "timestamp-ticks-exceeded"],
    [18, "missing-metadata-binding"],
    [19, "missing-metadata-cache"],
    [20, "missing-metadata-slot"],
    [21, "missing-metadata-cpu"],
    [22, "missing-metadata-address-space"],
  ] as const) {
    if ((mask & (1 << bit)) !== 0) failures.push(name);
  }
  return failures.length === 0 ? ["unclassified"] : failures;
}

export function jitEdgeKind(
  value: number,
): "direct" | "conditional" | "call" | "indirect" | null {
  if (value === 0) return "direct";
  if (value === 1) return "conditional";
  if (value === 2) return "call";
  if (value === 3) return "indirect";
  return null;
}

export function nextGeneration(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new VMError("VM_FAULT", "JIT generation counter overflowed");
  }
  return current + 1;
}

export function exactProfileCounter(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new VMError("VM_FAULT", "JIT operation sample counter overflowed");
  }
  return Number(value);
}

export function localJitBytes(
  view: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  return typeof SharedArrayBuffer !== "undefined"
    && view.buffer instanceof SharedArrayBuffer
    ? view.slice()
    : view;
}
