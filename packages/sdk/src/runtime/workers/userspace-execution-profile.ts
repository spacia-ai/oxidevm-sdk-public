import { VMError } from "../errors.js";
import { decodeUserspaceKernelAccountingModel } from "../userspace-abi.js";
import type { UserspaceExecutionProfile } from "../userspace-protocol.js";
import { readCoreRuntimeProfile } from "./control/core.js";
import { jitHealthProfile } from "./control/jit-health.js";
import { callUserspaceU64 } from "./userspace-exports.js";
import { readEffectiveJitTier } from "./userspace-settings.js";
import type { ProcessState } from "./userspace-worker-state.js";

export function captureExecutionProfile(active: ProcessState): { readonly runtimeKey: string; readonly profile: UserspaceExecutionProfile } {
  const core = readCoreRuntimeProfile(active.runtime.core);
  const worker = active.runtime.core.traceProfile.worker;
  const jitInstructions = active.runtime.core.runtimeStats.jitInstructions;
  const interpretedInstructions = active.runtime.core.runtimeStats.interpretedInstructions;
  const memoryMetric = (metric: number): bigint => {
    const value = callUserspaceU64(active.runtime.instance, "oxidevm_userspace_memory_metric", metric);
    if (value === 0xffff_ffff_ffff_ffffn) {
      throw new VMError("PROTOCOL_ERROR", "Userspace memory profile is unavailable");
    }
    return value;
  };
  return {
    runtimeKey: active.runtime.core.runtimeKey,
    profile: {
      pid: active.pid,
      jitTier: readEffectiveJitTier(active.runtime.instance),
      retiredInstructions: jitInstructions + interpretedInstructions,
      jitInstructions,
      interpretedInstructions,
      jitTier1Retired: core.jitTier1Retired,
      jitTier2Retired: core.jitTier2Retired,
      jitTier1Ring0Retired: core.jitTier1Ring0Retired,
      jitTier1Ring3Retired: core.jitTier1Ring3Retired,
      jitTier2Ring0Retired: core.jitTier2Ring0Retired,
      jitTier2Ring3Retired: core.jitTier2Ring3Retired,
      guestKernelInstructions: 0n,
      guestDeviceInstructions: 0n,
      guestPageTableWalkInstructions: 0n,
      guestSchedulerInstructions: 0n,
      guestTcpStackInstructions: 0n,
      unknownAttributionInstructions: 0n,
      lastException: active.runtime.lastException ?? null,
      timing: active.runtime.jitRuntime.executionTiming(active.runtime.core),
      jitBatches: worker.jitBatches,
      interpreterBatches: worker.interpreterBatches,
      compileModules: worker.compileModules,
      recompiledModules: worker.recompiledModules,
      moduleEvictions: worker.moduleEvictions,
      prepareCalls: worker.prepareCalls,
      prepareSamples: worker.prepareSamples,
      prepareMilliseconds: worker.prepareSampleMilliseconds,
      jitChainAttempts: core.jitChainAttempts,
      jitChainHits: core.jitChainHits,
      jitChainMissingCoverage: core.jitChainMissingCoverage,
      jitChainMissingCache: core.jitChainMissingCache,
      jitChainMissingDispatchSlot: core.jitChainMissingDispatchSlot,
      jitChainMissingEntry: core.jitChainMissingEntry,
      jitChainInvalidCode: core.jitChainInvalidCode,
      jitChainContextFailures: core.jitChainContextFailures,
      jitResidentTierLoopCalls: core.jitResidentTierLoopCalls,
      jitHotBlockTransitions: core.jitHotBlockTransitions,
      jitHotBoundaryStops: core.jitHotBoundaryStops,
      jitPartialBudgetFallbacks: core.jitPartialBudgetFallbacks,
      jitTailChainTransitions: worker.jitChainTransitions,
      jitTier2ExecutionEntries: core.jitTier2ExecutionEntries,
      jitMemoryReads: core.jitMemoryReads,
      jitMemoryPreflightWrites: core.jitMemoryPreflightWrites,
      jitMemoryStageWrites: core.jitMemoryStageWrites,
      jitMemoryWrites: core.jitMemoryWrites,
      jitMemoryDirectPreflightWrites: core.jitMemoryDirectPreflightWrites,
      jitReadCacheHits: core.jitReadCacheHits,
      jitWriteCacheHits: core.jitWriteCacheHits,
      jitReadVictimHits: core.jitReadVictimHits,
      jitWriteVictimHits: core.jitWriteVictimHits,
      jitResidentAdapterCompletions: core.jitResidentAdapterCompletions,
      jitAdapterExitsReturned: core.jitAdapterExitsReturned,
      jitResidentTaskSwitches: core.jitResidentTaskSwitches,
      jitResidentZeroRetirementExhaustions: core.jitResidentZeroRetirementExhaustions,
      jitResidentHostWaitExits: core.jitResidentHostWaitExits,
      jitDispatchRebindSameModuleCrossAddressSpace:
        core.jitDispatchRebindSameModuleCrossAddressSpace,
      jitDispatchRebindDifferentModule: core.jitDispatchRebindDifferentModule,
      jitDispatchRebindSameAddressSpace: core.jitDispatchRebindSameAddressSpace,
      jitBindingInvalidationsUnregister: core.jitBindingInvalidationsUnregister,
      jitBindingInvalidationsEviction: core.jitBindingInvalidationsEviction,
      jitBindingInvalidationsReplacement: core.jitBindingInvalidationsReplacement,
      jitActiveBindings: core.jitActiveBindings,
      jitActiveArtifacts: core.jitActiveArtifacts,
      jitActiveAddressSpaces: core.jitActiveAddressSpaces,
      jitAliasBindings: core.jitAliasBindings,
      jitAliasReuses: core.jitAliasReuses,
      jitCacheBindingBytes: core.jitCacheBindingBytes,
      jitCacheArtifactBytes: core.jitCacheArtifactBytes,
      jitCacheTotalBytes: core.jitCacheTotalBytes,
      mappedBytes: memoryMetric(0),
      residentBytes: memoryMetric(1),
      materializedPages: memoryMetric(2),
      directReadPageFills: memoryMetric(3),
      directWritePageFills: memoryMetric(4),
      translationJournalRecorded: memoryMetric(5),
      translationJournalDrained: memoryMetric(6),
      translationJournalCoalesced: memoryMetric(7),
      translationJournalDropped: memoryMetric(8),
      translationJournalRangeOverflows: memoryMetric(9),
      translationJournalCodeWriteOverflows: memoryMetric(10),
      translationJournalTrackedPages: memoryMetric(11),
      guestClockTicks: memoryMetric(12),
      guestClockRetiredTicks: memoryMetric(13),
      guestClockIdleTicks: memoryMetric(14),
      realtimeOffsetSteps: memoryMetric(15),
      guestClockKernelTicks: memoryMetric(16),
      kernelAccountingModel: decodeUserspaceKernelAccountingModel(memoryMetric(17)),
      workerRunTurns: active.runtime.workerRunTurns,
      workerYields: active.runtime.workerYields,
      workerMessages: active.runtime.workerMessages,
      hostRequests: active.runtime.hostRequests,
      hostRequestBytes: active.runtime.hostRequestBytes,
      pendingWorkPolls: active.runtime.pendingWorkPolls,
      hostRequestServicePolls: active.runtime.hostRequestServicePolls,
      outputServicePolls: active.runtime.outputServicePolls,
      exitServicePolls: active.runtime.exitServicePolls,
      timerServicePolls: active.runtime.timerServicePolls,
      slices: { ...active.runtime.slices, ends: { ...active.runtime.slices.ends }, hostAttention: { ...active.runtime.slices.hostAttention } },
      coreProfile: core,
      backgroundCompile: { ...worker.backgroundCompile },
      jitHealth: jitHealthProfile(active.runtime.core.jitHealth),
      jitCode: active.runtime.core.jitCode.profile(),
    },
  };
}
