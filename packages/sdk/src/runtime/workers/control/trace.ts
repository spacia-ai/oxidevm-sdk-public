import {
  appendBoundedRing,
  readBoundedRing,
} from "../../bounded-ring.js";
import type { DiskBridgeClient } from "../../disk-bridge.js";
import type { SessionDiagnostics } from "./system-session.js";
import {
  applicationTraceTailCapacity,
  sampleApplicationTrace,
  tracePartition,
  tracePartitionCapacity,
} from "../../trace-partition.js";
import {
  decodeCpuTraceState,
  JIT_EDGE_SAMPLE_PERIOD,
  JIT_OPERATION_SAMPLE_PERIOD,
} from "../../core-abi.js";
import { VMError } from "../../errors.js";
import { encodeSystemAotTrainingBundle } from "../../protocol/system-aot-training-bundle.js";
import {
  type SystemSliceResult,
  type SystemTraceCpu,
  type SystemTraceEvent,
  type SystemTraceProfile,
  type SystemTraceSnapshot,
} from "../../protocol.js";
import type { Core, FrozenSystemTrace } from "./core.js";
import type { SystemAotStatus } from "../../protocol/system-aot.js";
import { SYSTEM_TRACE_SCHEMA_VERSION } from "../../protocol/system-trace-schema.js";
import type { SystemTraceNetworkProfile } from "../../protocol/system-trace-network.js";
import { readCoreRuntimeProfile, readRecord } from "./core.js";
import { jitHealthProfile, stickyJitFailure } from "./jit-health.js";
import {
  copyInterpretedActionReasonProfiles,
  copyInterpreterReasonProfiles,
  copyJitEvictionReasonProfiles,
  latencyPercentile,
} from "./telemetry.js";

export function resetRuntimeStats(loaded: Core): void {
  loaded.runtimeEpoch += 1;
  Object.assign(loaded.runtimeStats, {
    jitInstructions: 0n,
    interpretedInstructions: 0n,
    cacheHits: 0n,
    moduleLoads: 0n,
    compileSamples: 0,
    compileMaximumMilliseconds: 0,
    guardExits: 0n,
    evictions: 0n,
  });
  loaded.runtimeStats.compileLatency.fill(0);
}

export function readSystemTrace(
  loaded: Core,
  diskBridge: DiskBridgeClient | undefined,
  consoleTail: string,
  aot: SystemAotStatus,
  session: SessionDiagnostics,
  network: SystemTraceNetworkProfile,
): SystemTraceSnapshot {
  const frozen = loaded.traceFreeze;
  const profileJitEvidence = frozen === undefined
      ? sampledProfileJitEvidence(
        loaded.profileJitModules.values(),
        loaded.profileJitOperationSamples.values(),
        loaded.profileJitEdgeSamples.values(),
        loaded.traceCheckpointPolicy === "faults-only",
      )
    : undefined;
  const jitModules = frozen?.jitModules ?? profileJitEvidence?.modules ?? [];
  return {
    schemaVersion: SYSTEM_TRACE_SCHEMA_VERSION,
    executionMode: loaded.traceInterpreterOnly
      ? "interpreter-only"
      : loaded.traceInterpretedSemantics.size === 0
        ? "tiered"
        : "semantic-quarantine",
    interpretedSemantics: [...loaded.traceInterpretedSemantics].sort(
      (left, right) => left - right,
    ),
    interpretedRipRanges: loaded.traceInterpretedRipRanges.map((range) => ({
      start: range.start,
      end: range.end,
    })),
    applicationSampleRate: 16,
    runtimeKey: loaded.runtimeKey,
    capturedAt: frozen?.capturedAt ?? performance.now(),
    trigger: frozen?.trigger ?? null,
    checkpointPolicy: frozen?.checkpointPolicy ?? loaded.traceCheckpointPolicy,
    aot,
    capacity: loaded.traceCapacity,
    dropped: frozen?.dropped ?? systemTraceDropped(loaded),
    runtime: frozen?.runtime ?? runtimeStats(loaded),
    profile: frozen?.profile ?? systemTraceProfile(loaded, diskBridge, session, network),
    state: frozen?.state ?? systemTraceCpu(loaded),
    consoleTail: frozen?.consoleTail ?? consoleTail,
    events: frozen?.events ?? currentSystemTraceEvents(loaded),
    jitModules,
    jitLoopStats: null,
    droppedJitModules:
      frozen?.droppedJitModules
      ?? loaded.droppedProfileJitModules
        + loaded.profileJitModules.size - jitModules.length,
    collidingJitModules:
      frozen?.collidingJitModules ?? loaded.collidingProfileJitModules,
    jitOperationSamples:
      frozen?.jitOperationSamples ?? profileJitEvidence?.samples ?? [],
    jitOperationSampleTotal:
      frozen?.jitOperationSampleTotal ?? loaded.profileJitOperationSampleTotal,
    droppedJitOperationSamples:
      frozen?.droppedJitOperationSamples
      ?? loaded.droppedProfileJitOperationSamples
        + (profileJitEvidence?.droppedSamples ?? 0),
    jitOperationSamplePeriod: JIT_OPERATION_SAMPLE_PERIOD,
    jitEdgeSamples:
      frozen?.jitEdgeSamples ?? profileJitEvidence?.edgeSamples ?? [],
    jitEdgeSampleTotal:
      frozen?.jitEdgeSampleTotal ?? loaded.profileJitEdgeSampleTotal,
    droppedJitEdgeSamples:
      frozen?.droppedJitEdgeSamples
      ?? loaded.droppedProfileJitEdgeSamples
        + (profileJitEvidence?.droppedEdgeSamples ?? 0),
    jitEdgeSamplePeriod: JIT_EDGE_SAMPLE_PERIOD,
  };
}

export function readSystemAotTraining(loaded: Core): Uint8Array<ArrayBuffer> {
  if (loaded.traceCheckpointPolicy !== "faults-only") {
    throw new VMError(
      "INVALID_ARGUMENT",
      "system AOT training evidence requires faults-only trace capture",
    );
  }
  return encodeSystemAotTrainingBundle(
    [...loaded.profileJitModules.values()],
    loaded.droppedProfileJitModules,
  );
}

export function systemTraceCpu(loaded: Core): SystemTraceCpu {
  return decodeCpuTraceState(readRecord(loaded, "cpu-state"));
}

export function systemTraceBase(loaded: Core): {
  readonly sequence: number;
  readonly workerTimestamp: number;
} {
  loaded.traceSequence += 1;
  return {
    sequence: loaded.traceSequence,
    workerTimestamp: performance.now(),
  };
}

export function recordSystemTrace(
  loaded: Core,
  event: SystemTraceEvent,
): void {
  if (!systemTraceEnabled(loaded)) return;
  const aotCapacity = aotTraceCapacity(loaded.traceCapacity);
  if (event.kind === "jit" && event.artifact?.kind === "aot") {
    appendBoundedRing(loaded.traceAotEvents, aotCapacity, event);
    return;
  }
  const reservedCapacity = tracePartitionCapacity(loaded.traceCapacity);
  const partition = systemTraceEventPartition(event);
  if (reservedCapacity !== 0 && partition === "application") {
    loaded.traceApplicationSequence += 1;
    const tailCapacity = applicationTraceTailCapacity(reservedCapacity);
    if (sampleApplicationTrace(loaded.traceApplicationSequence)) {
      appendBoundedRing(
        loaded.traceApplicationSamples,
        reservedCapacity - tailCapacity,
        event,
      );
    } else {
      appendBoundedRing(loaded.traceApplicationEvents, tailCapacity, event);
    }
    return;
  }
  if (reservedCapacity !== 0 && partition === "shared-library") {
    appendBoundedRing(loaded.traceSharedLibraryEvents, reservedCapacity, event);
    return;
  }
  appendBoundedRing(
    loaded.traceSystemEvents,
    loaded.traceCapacity - reservedCapacity * 2 - aotCapacity,
    event,
  );
}

export function systemTraceEnabled(loaded: Core): boolean {
  return loaded.traceCapacity !== 0 && loaded.traceFreeze === undefined;
}

export function freezeSystemTrace(
  loaded: Core,
  diskBridge: DiskBridgeClient | undefined,
  consoleTail: string,
  trigger: Exclude<SystemTraceSnapshot["trigger"], null>,
  session: SessionDiagnostics,
): void {
  if (!systemTraceEnabled(loaded)) return;
  loaded.traceFreeze =
    loaded.traceCheckpoint ??
    captureSystemTrace(loaded, diskBridge, consoleTail, trigger, session);
  diskBridge?.configureProfiling(false);
}

export function checkpointSystemTrace(
  loaded: Core,
  diskBridge: DiskBridgeClient | undefined,
  consoleTail: string,
  session: SessionDiagnostics,
): void {
  if (!systemTraceEnabled(loaded) || loaded.traceCheckpoint !== undefined) {
    return;
  }
  loaded.traceCheckpoint = captureSystemTrace(
    loaded,
    diskBridge,
    consoleTail,
    "guest-stderr",
    session,
  );
}

export function runtimeStats(loaded: Core): SystemSliceResult["runtime"] {
  const { runtimeStats: stats } = loaded;
  return {
    profile: "x86-64-v3",
    jitState:
      loaded.jitHealth.state !== "active" || loaded.traceInterpreterOnly
        ? "degraded"
        : "active",
    retiredInstructions:
      stats.jitInstructions + stats.interpretedInstructions,
    jitInstructions: stats.jitInstructions,
    interpretedInstructions: stats.interpretedInstructions,
    cacheHits: stats.cacheHits,
    moduleLoads: stats.moduleLoads,
    compileSamples: stats.compileSamples,
    compileP95Milliseconds: latencyPercentile(
      stats.compileLatency,
      stats.compileSamples,
      95,
    ),
    compileMaximumMilliseconds: stats.compileMaximumMilliseconds,
    guardExits: stats.guardExits,
    evictions: stats.evictions,
    cacheEntries: loaded.aotCacheEntries + loaded.jitBlocks.size + loaded.dormantJitBlocks.size,
    cacheBytes: loaded.aotCacheBytes + loaded.jitBlockBytes + loaded.dormantJitBlockBytes,
    cacheLimitBytes: loaded.jitCacheBytes,
  };
}

function captureSystemTrace(
  loaded: Core,
  diskBridge: DiskBridgeClient | undefined,
  consoleTail: string,
  trigger: Exclude<SystemTraceSnapshot["trigger"], null>,
  session: SessionDiagnostics,
): FrozenSystemTrace {
  const profileJitEvidence = sampledProfileJitEvidence(
    loaded.profileJitModules.values(),
    loaded.profileJitOperationSamples.values(),
    loaded.profileJitEdgeSamples.values(),
    loaded.traceCheckpointPolicy === "faults-only",
  );
  const jitModules = profileJitEvidence.modules;
  return {
    capturedAt: performance.now(),
    trigger,
    checkpointPolicy: loaded.traceCheckpointPolicy,
    runtime: runtimeStats(loaded),
    profile: systemTraceProfile(loaded, diskBridge, session),
    state: systemTraceCpu(loaded),
    consoleTail,
    dropped: systemTraceDropped(loaded),
    events: currentSystemTraceEvents(loaded),
    jitModules,
    droppedJitModules:
      loaded.droppedProfileJitModules
      + loaded.profileJitModules.size - jitModules.length,
    collidingJitModules: loaded.collidingProfileJitModules,
    jitOperationSamples: profileJitEvidence.samples,
    jitOperationSampleTotal: loaded.profileJitOperationSampleTotal,
    droppedJitOperationSamples:
      loaded.droppedProfileJitOperationSamples + profileJitEvidence.droppedSamples,
    jitEdgeSamples: profileJitEvidence.edgeSamples,
    jitEdgeSampleTotal: loaded.profileJitEdgeSampleTotal,
    droppedJitEdgeSamples:
      loaded.droppedProfileJitEdgeSamples + profileJitEvidence.droppedEdgeSamples,
  };
}

type ProfileJitModule = NonNullable<SystemTraceSnapshot["jitModules"]>[number];
type ProfileJitOperationSample = NonNullable<
  SystemTraceSnapshot["jitOperationSamples"]
>[number];
type ProfileJitEdgeSample = NonNullable<
  SystemTraceSnapshot["jitEdgeSamples"]
>[number];

export function sampledProfileJitEvidence(
  modules: Iterable<ProfileJitModule>,
  samples: Iterable<ProfileJitOperationSample>,
  edgeSamples: Iterable<ProfileJitEdgeSample>,
  aotTraining = false,
): {
  readonly modules: readonly ProfileJitModule[];
  readonly samples: readonly ProfileJitOperationSample[];
  readonly droppedSamples: number;
  readonly edgeSamples: readonly ProfileJitEdgeSample[];
  readonly droppedEdgeSamples: number;
} {
  const allModules = [...modules];
  const availableModules = new Set(
    allModules.map((module) => module.profileModuleId),
  );
  const allSamples = [...samples];
  const allEdgeSamples = [...edgeSamples];
  if (aotTraining) {
    return {
      modules: [],
      samples: [],
      droppedSamples: allSamples.reduce((total, sample) => total + sample.samples, 0),
      edgeSamples: [],
      droppedEdgeSamples: allEdgeSamples.reduce((total, sample) => total + sample.samples, 0),
    };
  }
  const selected = new Map<string, {
    readonly identities: Map<number, ProfileJitOperationSample>;
    total: number;
  }>();
  for (const sample of allSamples) {
    const module = selected.get(sample.profileModuleId) ?? {
      identities: new Map(),
      total: 0,
    };
    const identities = module.identities;
    identities.set(operationIdentity(sample), sample);
    module.total += sample.samples;
    selected.set(sample.profileModuleId, module);
  }
  for (const sample of allEdgeSamples) {
    for (const profileModuleId of [
      sample.sourceProfileModuleId,
      sample.targetProfileModuleId,
    ]) {
      const module = selected.get(profileModuleId) ?? {
        identities: new Map(),
        total: 0,
      };
      module.total += sample.samples;
      selected.set(profileModuleId, module);
    }
  }
  const retained = new Set(
    [...selected.entries()]
      .filter(([profileModuleId]) => availableModules.has(profileModuleId))
      .sort((left, right) =>
        right[1].total - left[1].total || left[0].localeCompare(right[0])
      )
      .map(([profileModuleId]) => profileModuleId),
  );
  const retainedSamples = allSamples.filter((sample) =>
    retained.has(sample.profileModuleId)
  );
  const retainedEdgeSamples = allEdgeSamples.filter((sample) =>
    retained.has(sample.sourceProfileModuleId)
    && retained.has(sample.targetProfileModuleId)
  );
  const compactModules = allModules.flatMap((module) => {
    const sampleModule = selected.get(module.profileModuleId);
    if (sampleModule === undefined || !retained.has(module.profileModuleId)) {
      return [{ ...module, operations: [] }];
    }
    const operations = [...sampleModule.identities.values()]
      .map((sample) => findSampledOperation(module.operations, sample))
      .filter((operation): operation is ProfileJitModule["operations"][number] =>
        operation !== undefined
      )
      .sort((left, right) => operationPosition(left) - operationPosition(right));
    return [operations.length === module.operations.length
      ? module
      : { ...module, operations }];
  });
  return {
    modules: compactModules,
    samples: retainedSamples,
    droppedSamples: allSamples.reduce(
      (total, sample) =>
        retained.has(sample.profileModuleId) ? total : total + sample.samples,
      0,
    ),
    edgeSamples: retainedEdgeSamples,
    droppedEdgeSamples: allEdgeSamples.reduce(
      (total, sample) =>
        retained.has(sample.sourceProfileModuleId)
          && retained.has(sample.targetProfileModuleId)
          ? total
          : total + sample.samples,
      0,
    ),
  };
}

function operationIdentity(operation: {
  readonly instructionIndex: number;
  readonly sourceIndex: number;
  readonly operationKind: number;
}): number {
  return operationPosition(operation) * 65_536 + operation.operationKind;
}

function operationPosition(operation: {
  readonly instructionIndex: number;
  readonly sourceIndex: number;
}): number {
  return operation.instructionIndex * 256 + operation.sourceIndex;
}

function findSampledOperation(
  operations: ProfileJitModule["operations"],
  sample: ProfileJitOperationSample,
): ProfileJitModule["operations"][number] | undefined {
  const target = operationPosition(sample);
  let low = 0;
  let high = operations.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const operation = operations[middle];
    if (operation === undefined) return undefined;
    const position = operationPosition(operation);
    if (position < target) low = middle + 1;
    else high = middle;
  }
  const operation = operations[low];
  return operation !== undefined
    && operationPosition(operation) === target
    && operation.operationKind === sample.operationKind
    ? operation
    : undefined;
}

/** A live read carries the network link; checkpoints record none (null). */
function systemTraceProfile(
  loaded: Core,
  diskBridge: DiskBridgeClient | undefined,
  session: SessionDiagnostics,
  network: SystemTraceNetworkProfile | null = null,
): SystemTraceProfile {
  const stats = loaded.runtimeStats;
  return {
    worker: {
      ...loaded.traceProfile.worker,
      session,
      core: readCoreRuntimeProfile(loaded),
      synchronousCompileP95Milliseconds: latencyPercentile(
        stats.compileLatency,
        stats.compileSamples,
        95,
      ),
      synchronousCompileMaximumMilliseconds:
        stats.compileMaximumMilliseconds,
      stickyJitFailure: stickyJitFailure(loaded.jitHealth),
      jitHealth: jitHealthProfile(loaded.jitHealth),
      jitCode: loaded.jitCode.profile(),
      dispatchVictimAge: { ...loaded.traceProfile.worker.dispatchVictimAge },
      dispatchRecompileReuseDistance: {
        ...loaded.traceProfile.worker.dispatchRecompileReuseDistance,
      },
      evictionReasons: copyJitEvictionReasonProfiles(
        loaded.traceProfile.worker.evictionReasons,
      ),
      interpreterReasons: copyInterpreterReasonProfiles(
        loaded.traceProfile.worker.interpreterReasons,
      ),
      interpretedActionReasons: copyInterpretedActionReasonProfiles(
        loaded.traceProfile.worker.interpretedActionReasons,
      ),
      backgroundCompile: { ...loaded.traceProfile.worker.backgroundCompile },
      hostAttention: {
        yields: { ...loaded.traceProfile.worker.hostAttention.yields },
        deferrals: loaded.traceProfile.worker.hostAttention.deferrals,
      },
    },
    disk: diskBridge?.profile() ?? {
      enabled: false,
      requests: 0,
      failures: 0,
      reads: 0,
      readBytes: 0,
      writes: 0,
      writtenBytes: 0,
      zeroes: 0,
      zeroedBytes: 0,
      discards: 0,
      discardedBytes: 0,
      flushes: 0,
      waitMilliseconds: 0,
      maximumWaitMilliseconds: 0,
      maximumQueueDepth: 0,
      busyReturns: 0,
      maximumInFlight: 0,
      delayedFailures: 0,
      backendFailures: 0,
      protocolFailures: 0,
      timeoutFailures: 0,
      quotaFailures: 0,
    },
    agent: { ...loaded.traceProfile.agent },
    network,
  };
}

function currentSystemTraceEvents(
  loaded: Core,
): readonly SystemTraceEvent[] {
  return [
    ...readBoundedRing(loaded.traceSystemEvents),
    ...readBoundedRing(loaded.traceApplicationEvents),
    ...readBoundedRing(loaded.traceApplicationSamples),
    ...readBoundedRing(loaded.traceSharedLibraryEvents),
    ...readBoundedRing(loaded.traceAotEvents),
  ].sort((left, right) => left.sequence - right.sequence);
}

function systemTraceEventPartition(
  event: SystemTraceEvent,
): ReturnType<typeof tracePartition> {
  return event.kind === "compile"
    ? "system"
    : tracePartition(event.before.cpl, event.before.rip);
}

function systemTraceDropped(loaded: Core): number {
  return (
    loaded.traceSystemEvents.dropped +
    loaded.traceApplicationEvents.dropped +
    loaded.traceApplicationSamples.dropped +
    loaded.traceSharedLibraryEvents.dropped +
    loaded.traceAotEvents.dropped
  );
}

function aotTraceCapacity(capacity: number): number {
  return capacity >= 256 ? Math.min(64, capacity) : 0;
}
