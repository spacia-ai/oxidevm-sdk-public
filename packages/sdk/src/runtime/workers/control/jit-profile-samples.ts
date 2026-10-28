import {
  JIT_EDGE_SAMPLE_DROPPED_OFFSET,
  JIT_EDGE_SAMPLE_TOTAL_OFFSET,
  JIT_OPERATION_SAMPLE_COUNT_OFFSET,
  JIT_OPERATION_SAMPLE_DROPPED_OFFSET,
  JIT_OPERATION_SAMPLE_ENTRIES,
  JIT_OPERATION_SAMPLE_ENTRY_LENGTH,
  JIT_OPERATION_SAMPLES_OFFSET,
  JIT_OPERATION_SAMPLE_TOTAL_OFFSET,
  JIT_TRACE_RECORD_COUNT_OFFSET,
  JIT_TRACE_RECORD_DROPPED_OFFSET,
  JIT_TRACE_RECORD_ENTRIES,
  JIT_TRACE_RECORD_ENTRY_LENGTH,
  JIT_TRACE_RECORD_TOTAL_OFFSET,
  JIT_TRACE_RECORDS_OFFSET,
} from "../../core-abi.js";
import { VMError } from "../../errors.js";
import { JIT_OPERATION_SAMPLE_LIMIT } from "../../protocol.js";
import type { Core, JitBlock, JitBlockBinding } from "./core.js";
import { exactProfileCounter, jitEdgeKind } from "./jit-runtime-helpers.js";

const PROFILE_JIT_EDGE_SAMPLE_LIMIT = 262_144;

type JitProfileSampleState = Pick<
  Core,
  | "memory"
  | "profileJitOperationSampleTotal"
  | "droppedProfileJitOperationSamples"
  | "profileJitEdgeSampleTotal"
  | "droppedProfileJitEdgeSamples"
  | "profileJitOperationSamples"
  | "profileJitEdgeSamples"
  | "jitBlocksBySlot"
  | "collidingProfileJitModuleIds"
>;

export function drainJitProfileSamples(
  loaded: JitProfileSampleState,
  contextPointer: number,
): void {
  const view = new DataView(loaded.memory.buffer);
  const count = view.getUint32(
    contextPointer + JIT_OPERATION_SAMPLE_COUNT_OFFSET,
    true,
  );
  if (count > JIT_OPERATION_SAMPLE_ENTRIES) {
    throw new VMError("VM_FAULT", "JIT operation sample ring is corrupt");
  }
  const droppedOperations = exactProfileCounter(
    view.getBigUint64(contextPointer + JIT_OPERATION_SAMPLE_DROPPED_OFFSET, true),
  );
  // Wasm counts retained ring entries and overflow separately. The SDK total includes both.
  loaded.profileJitOperationSampleTotal += droppedOperations + exactProfileCounter(
    view.getBigUint64(contextPointer + JIT_OPERATION_SAMPLE_TOTAL_OFFSET, true),
  );
  loaded.droppedProfileJitOperationSamples += droppedOperations;
  const droppedEdges = exactProfileCounter(
    view.getBigUint64(contextPointer + JIT_EDGE_SAMPLE_DROPPED_OFFSET, true),
  );
  loaded.profileJitEdgeSampleTotal += droppedEdges + exactProfileCounter(
    view.getBigUint64(contextPointer + JIT_EDGE_SAMPLE_TOTAL_OFFSET, true),
  );
  loaded.droppedProfileJitEdgeSamples += droppedEdges;
  const traceRecordCount = view.getUint32(
    contextPointer + JIT_TRACE_RECORD_COUNT_OFFSET,
    true,
  );
  if (traceRecordCount > JIT_TRACE_RECORD_ENTRIES) {
    throw new VMError("VM_FAULT", "JIT trace record ring is corrupt");
  }
  const traceRecordTotal = exactProfileCounter(
    view.getBigUint64(contextPointer + JIT_TRACE_RECORD_TOTAL_OFFSET, true),
  );
  if (traceRecordTotal !== traceRecordCount) {
    throw new VMError("VM_FAULT", "JIT trace record total does not reconcile");
  }
  const droppedTraceRecords = view.getUint32(
    contextPointer + JIT_TRACE_RECORD_DROPPED_OFFSET,
    true,
  );
  loaded.profileJitEdgeSampleTotal += traceRecordTotal + droppedTraceRecords;
  loaded.droppedProfileJitEdgeSamples += droppedTraceRecords;
  drainTraceRecords(loaded, view, contextPointer, traceRecordCount);
  drainOperationSamples(loaded, view, contextPointer, count);
  view.setUint32(contextPointer + JIT_OPERATION_SAMPLE_COUNT_OFFSET, 0, true);
  view.setBigUint64(contextPointer + JIT_OPERATION_SAMPLE_TOTAL_OFFSET, 0n, true);
  view.setBigUint64(contextPointer + JIT_OPERATION_SAMPLE_DROPPED_OFFSET, 0n, true);
  view.setBigUint64(contextPointer + JIT_EDGE_SAMPLE_TOTAL_OFFSET, 0n, true);
  view.setBigUint64(contextPointer + JIT_EDGE_SAMPLE_DROPPED_OFFSET, 0n, true);
  // Rust completion owns the trace window and clears it after admission has
  // consumed the exact records copied here for diagnostic evidence.
}

function drainTraceRecords(
  loaded: JitProfileSampleState,
  view: DataView,
  contextPointer: number,
  count: number,
): void {
  const firstSource = count === 0
    ? undefined
    : loaded.jitBlocksBySlot.get(view.getUint16(contextPointer + JIT_TRACE_RECORDS_OFFSET, true));
  if (firstSource?.profileModuleId === null && view.getBigUint64(contextPointer + JIT_TRACE_RECORDS_OFFSET + 32, true) === 0n) {
    loaded.droppedProfileJitEdgeSamples += count;
    return;
  }
  for (let index = 0; index < count; index += 1) {
    const offset = contextPointer + JIT_TRACE_RECORDS_OFFSET
      + index * JIT_TRACE_RECORD_ENTRY_LENGTH;
    drainRecordedJitEdge(
      loaded,
      view.getUint16(offset, true),
      view.getUint16(offset + 2, true),
      view.getUint16(offset + 4, true),
      view.getUint16(offset + 6, true),
      view.getUint8(offset + 8),
      view.getUint32(offset + 12, true),
      view.getBigUint64(offset + 16, true),
      view.getUint32(offset + 24, true),
      view.getUint32(offset + 28, true),
      view.getBigUint64(offset + 32, true),
      view.getBigUint64(offset + 40, true),
    );
  }
}

function drainOperationSamples(
  loaded: JitProfileSampleState,
  view: DataView,
  contextPointer: number,
  count: number,
): void {
  for (let index = 0; index < count; index += 1) {
    const offset = contextPointer + JIT_OPERATION_SAMPLES_OFFSET
      + index * JIT_OPERATION_SAMPLE_ENTRY_LENGTH;
    const rawModuleId = view.getBigUint64(offset, true);
    const instructionIndex = view.getUint16(offset + 8, true);
    const sourceIndex = view.getUint8(offset + 10);
    const spanCode = view.getUint8(offset + 11);
    const operationKind = view.getUint16(offset + 12, true);
    const targetSlotMarker = view.getUint16(offset + 14, true);
    if (spanCode !== 0) throw new VMError("PROTOCOL_ERROR", "JIT operation sample reserved byte is invalid");
    if (targetSlotMarker !== 0) {
      loaded.droppedProfileJitEdgeSamples += 1;
      continue;
    }
    if (rawModuleId === 0n) {
      loaded.droppedProfileJitOperationSamples += 1;
      continue;
    }
    const profileModuleId = rawModuleId.toString(16).padStart(16, "0");
    const key = `${profileModuleId}:${String(instructionIndex)}:${String(sourceIndex)}:${String(operationKind)}`;
    const current = loaded.profileJitOperationSamples.get(key);
    if (
      current === undefined
      && loaded.profileJitOperationSamples.size >= JIT_OPERATION_SAMPLE_LIMIT
    ) {
      loaded.droppedProfileJitOperationSamples += 1;
      continue;
    }
    loaded.profileJitOperationSamples.set(key, {
      profileModuleId,
      instructionIndex,
      sourceIndex,
      operationKind,
      span: "ordinary",
      samples: (current?.samples ?? 0) + 1,
    });
  }
}

function drainRecordedJitEdge(
  loaded: JitProfileSampleState,
  sourceSlot: number,
  targetSlot: number,
  sourceInstructionIndex: number,
  targetEntryIndex: number,
  rawKind: number,
  retiredDelta: number,
  targetRip: bigint,
  sourceDispatchGeneration: number,
  targetDispatchGeneration: number,
  sourceBindingId: bigint,
  targetBindingId: bigint,
): void {
  const source = loaded.jitBlocksBySlot.get(sourceSlot);
  const target = loaded.jitBlocksBySlot.get(targetSlot);
  const kind = jitEdgeKind(rawKind);
  if (
    source === undefined
    || target === undefined
    || kind === null
    || retiredDelta === 0
    || sourceDispatchGeneration === 0
    || targetDispatchGeneration === 0
    || source.dispatchGeneration !== sourceDispatchGeneration
    || target.dispatchGeneration !== targetDispatchGeneration
    || target.instructions[targetEntryIndex]?.rip !== targetRip
  ) {
    loaded.droppedProfileJitEdgeSamples += 1;
    return;
  }
  const sourceBinding = recordedBinding(source, sourceBindingId);
  const targetBinding = recordedBinding(target, targetBindingId);
  if (sourceBinding === undefined || targetBinding === undefined) {
    loaded.droppedProfileJitEdgeSamples += 1;
    return;
  }
  retainResolvedJitEdge(
    loaded,
    sourceBinding,
    targetBinding,
    sourceInstructionIndex,
    targetEntryIndex,
    kind,
    sourceSlot,
    targetSlot,
    sourceDispatchGeneration,
    targetDispatchGeneration,
    retiredDelta,
  );
}

function recordedBinding(block: JitBlock, id: bigint): JitBlockBinding | JitBlock | undefined {
  if (id === 0n) return block;
  const profileId = id.toString(16).padStart(16, "0");
  for (const binding of block.bindings.values()) {
    if (binding.profileModuleId === profileId) return binding;
  }
  return undefined;
}

function retainResolvedJitEdge(
  loaded: JitProfileSampleState,
  source: JitBlockBinding | JitBlock,
  target: JitBlockBinding | JitBlock,
  sourceInstructionIndex: number,
  targetEntryIndex: number,
  kind: "direct" | "conditional" | "call" | "indirect",
  sourceDispatchSlot: number,
  targetDispatchSlot: number,
  sourceDispatchGeneration: number,
  targetDispatchGeneration: number,
  retiredDelta: number,
): void {
  const sourceProfileModuleId = source.profileModuleId;
  const targetProfileModuleId = target.profileModuleId;
  const sourceInstruction = source.instructions[sourceInstructionIndex];
  const targetInstruction = target.instructions[targetEntryIndex];
  if (
    sourceProfileModuleId === null
    || targetProfileModuleId === null
    || sourceInstruction === undefined
    || targetInstruction === undefined
    || loaded.collidingProfileJitModuleIds.has(sourceProfileModuleId)
    || loaded.collidingProfileJitModuleIds.has(targetProfileModuleId)
  ) {
    loaded.droppedProfileJitEdgeSamples += 1;
    return;
  }
  const key = [
    sourceProfileModuleId,
    targetProfileModuleId,
    source.compileGeneration,
    target.compileGeneration,
    sourceDispatchSlot,
    targetDispatchSlot,
    sourceDispatchGeneration,
    targetDispatchGeneration,
    sourceInstructionIndex,
    targetEntryIndex,
    kind,
  ].join(":");
  const current = loaded.profileJitEdgeSamples.get(key);
  if (
    current === undefined
    && loaded.profileJitEdgeSamples.size >= PROFILE_JIT_EDGE_SAMPLE_LIMIT
  ) {
    loaded.droppedProfileJitEdgeSamples += 1;
    return;
  }
  loaded.profileJitEdgeSamples.set(key, {
    sourceProfileModuleId,
    targetProfileModuleId,
    sourceCacheKey: source.cacheKey,
    targetCacheKey: target.cacheKey,
    sourceCompileGeneration: source.compileGeneration,
    targetCompileGeneration: target.compileGeneration,
    sourceDispatchSlot,
    targetDispatchSlot,
    sourceDispatchGeneration,
    targetDispatchGeneration,
    sourceInstructionIndex,
    targetEntryIndex,
    sourceTier: source.tier,
    targetTier: target.tier,
    sourceRip: sourceInstruction.rip,
    targetRip: targetInstruction.rip,
    sourceSemantic: sourceInstruction.semantic,
    targetSemantic: targetInstruction.semantic,
    kind,
    samples: (current?.samples ?? 0) + 1,
    retired: (current?.retired ?? 0n) + BigInt(retiredDelta),
  });
}
