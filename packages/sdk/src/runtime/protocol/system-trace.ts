import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { JIT_DISPATCH_TABLE_ENTRIES, JIT_REGION_MAX_INSTRUCTIONS } from "../jit-cache.js";
import { MAX_SYSTEM_TRACE_EVENTS } from "./common.js";
import {
  finiteNonnegativeNumber,
  nonnegativeBigint,
} from "./decoders.js";
import {
  type SystemTraceSnapshot,
  decodeSystemRuntimeStats,
} from "./system.js";
import { decodeSystemAotStatus } from "./system-aot.js";
import { decodeSystemTraceCpu } from "./system-trace-state.js";
import { decodeSystemTraceEvent } from "./system-trace-events.js";
import { decodeSystemTraceSchemaVersion } from "./system-trace-schema.js";
import { decodeJitLoopPolicyRecord, decodeJitLoopSpan, decodeJitLoopStats } from "./system-trace-jit-loops.js";
import { decodeSystemTraceProfile } from "./system-trace-profile.js";
import {
  decodeInterpretedRipRanges,
  decodeInterpretedSemantics,
  decodeSystemTraceExecutionMode,
  decodeSystemTraceTrigger,
} from "./system-trace-identity.js";
import {
  decodeJitAotTrainingSourceRecord,
  EMPTY_JIT_AOT_TRAINING_STATS,
} from "./system-trace-jit-aot.js";
import {
  decodeJitEdgeKind,
  decodeJitOperationSamples,
  decodeJitProofCostClass,
  decodeJitRuntimeIdentity,
  decodeTraceTier,
} from "./system-trace-jit.js";

export * from "./system-trace-jit.js";
export { decodeInterpretedRipRanges, decodeInterpretedSemantics };

export function decodeSystemTraceSnapshot(value: unknown): SystemTraceSnapshot {
  const snapshot = record(value, "system trace snapshot");
  const schemaVersion = decodeSystemTraceSchemaVersion(snapshot["schemaVersion"]);
  const baseKeys = [
    "schemaVersion",
    "runtimeKey",
    "capturedAt",
    "trigger",
    "capacity",
    "dropped",
    "runtime",
    "profile",
    "state",
    "consoleTail",
    "events",
  ] as const;
  exactKeys(
    snapshot,
    schemaVersion === 2 || schemaVersion === 3
      ? baseKeys
      : schemaVersion === 4
        ? [...baseKeys, "executionMode", "interpretedSemantics"]
        : schemaVersion === 5
          ? [
              ...baseKeys,
              "executionMode",
              "interpretedSemantics",
              "interpretedRipRanges",
            ]
          : [
            ...baseKeys,
            "executionMode",
            "interpretedSemantics",
            "interpretedRipRanges",
            "applicationSampleRate",
            ...(schemaVersion >= 33 ? ["checkpointPolicy", "aot"] as const : []),
            ...(schemaVersion >= 25 ? ["jitModules", "droppedJitModules", "collidingJitModules"] as const : []),
            ...(schemaVersion >= 39 ? ["jitLoopStats"] as const : []),
            ...(schemaVersion >= 26 ? ["jitOperationSamples", "jitOperationSampleTotal", "droppedJitOperationSamples"] as const : []),
            ...(schemaVersion >= 27 ? ["jitOperationSamplePeriod"] as const : []),
            ...(schemaVersion >= 28 ? [
              "jitEdgeSamples",
              "jitEdgeSampleTotal",
              "droppedJitEdgeSamples",
              "jitEdgeSamplePeriod",
            ] as const : []),
          ],
  );
  const runtimeKey = string(snapshot["runtimeKey"], "system trace runtime key");
  if (!/^[0-9a-f]{64}$/u.test(runtimeKey)) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "system trace runtime key is invalid",
    );
  }
  const capacity = integer(
    snapshot["capacity"],
    "system trace capacity",
    0,
    MAX_SYSTEM_TRACE_EVENTS,
  );
  const events = snapshot["events"];
  if (!Array.isArray(events) || events.length > capacity) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "system trace events exceed their capacity",
    );
  }
  let previousSequence = 0;
  const decodedEvents = events.map((event, index) => {
    const decoded = decodeSystemTraceEvent(event, index, schemaVersion);
    if (decoded.sequence <= previousSequence) {
      throw new VMError(
        "PROTOCOL_ERROR",
        "system trace event sequence is not increasing",
      );
    }
    previousSequence = decoded.sequence;
    return decoded;
  });
  const consoleTail = string(
    snapshot["consoleTail"],
    "system trace console tail",
  );
  if (new TextEncoder().encode(consoleTail).byteLength > 64 * 1024) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "system trace console tail is too large",
    );
  }
  const executionMode =
    schemaVersion === 2 || schemaVersion === 3
      ? "unknown"
      : decodeSystemTraceExecutionMode(snapshot["executionMode"]);
  const interpretedSemantics =
    schemaVersion === 2 || schemaVersion === 3
      ? []
      : decodeInterpretedSemantics(snapshot["interpretedSemantics"]);
  const interpretedRipRanges =
    schemaVersion >= 5
      ? decodeInterpretedRipRanges(snapshot["interpretedRipRanges"])
      : [];
  const applicationSampleRate =
    schemaVersion >= 6
      ? integer(
          snapshot["applicationSampleRate"],
          "application trace sample rate",
          1,
          1_024,
        )
      : 1;
  if (
    (executionMode === "semantic-quarantine") !==
    (interpretedSemantics.length !== 0)
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "system trace execution mode and semantic quarantine disagree",
    );
  }
  if (
    interpretedRipRanges.length !== 0 &&
    interpretedSemantics.length === 0
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "system trace RIP ranges require semantic quarantine",
    );
  }
  return {
    schemaVersion,
    executionMode,
    interpretedSemantics,
    interpretedRipRanges,
    applicationSampleRate,
    runtimeKey,
    capturedAt: finiteNonnegativeNumber(
      snapshot["capturedAt"],
      "system trace capture time",
    ),
    trigger: decodeSystemTraceTrigger(snapshot["trigger"]),
    ...(schemaVersion >= 33
      ? {
          checkpointPolicy: decodeCheckpointPolicy(snapshot["checkpointPolicy"]),
          aot: decodeSystemAotStatus(snapshot["aot"], schemaVersion),
        }
      : {}),
    capacity,
    dropped: integer(snapshot["dropped"], "dropped system trace events", 0),
    runtime: decodeSystemRuntimeStats(snapshot["runtime"]),
    profile: decodeSystemTraceProfile(snapshot["profile"], schemaVersion),
    state: decodeSystemTraceCpu(
      snapshot["state"],
      "system trace state",
      schemaVersion,
    ),
    consoleTail,
    events: decodedEvents,
    ...(schemaVersion >= 25 ? {
      jitModules: decodeJitModules(snapshot["jitModules"], schemaVersion),
      droppedJitModules: integer(snapshot["droppedJitModules"], "dropped JIT modules", 0),
      collidingJitModules: integer(snapshot["collidingJitModules"], "colliding JIT modules", 0),
    } : {}),
    ...(schemaVersion >= 39 ? { jitLoopStats: snapshot["jitLoopStats"] === null ? null : decodeJitLoopStats(snapshot["jitLoopStats"]) } : {}),
    ...(schemaVersion >= 26 ? {
      jitOperationSamples: decodeJitOperationSamples(snapshot["jitOperationSamples"], schemaVersion >= 39),
      jitOperationSampleTotal: integer(snapshot["jitOperationSampleTotal"], "JIT operation sample total", 0),
      droppedJitOperationSamples: integer(snapshot["droppedJitOperationSamples"], "dropped JIT operation samples", 0),
    } : {}),
    ...(schemaVersion >= 27 ? {
      jitOperationSamplePeriod: integer(
        snapshot["jitOperationSamplePeriod"],
        "JIT operation sample period",
        1,
      ),
    } : {}),
    ...(schemaVersion >= 28 ? {
      jitEdgeSamples: decodeJitEdgeSamples(snapshot["jitEdgeSamples"]),
      jitEdgeSampleTotal: integer(
        snapshot["jitEdgeSampleTotal"],
        "JIT edge sample total",
        0,
      ),
      droppedJitEdgeSamples: integer(
        snapshot["droppedJitEdgeSamples"],
        "dropped JIT edge samples",
        0,
      ),
      jitEdgeSamplePeriod: integer(
        snapshot["jitEdgeSamplePeriod"],
        "JIT edge sample period",
        1,
      ),
    } : {}),
  };
}

function decodeCheckpointPolicy(
  value: unknown,
): NonNullable<SystemTraceSnapshot["checkpointPolicy"]> {
  if (value === "faults-and-stderr" || value === "faults-only") return value;
  throw new VMError(
    "PROTOCOL_ERROR",
    "system trace checkpoint policy is invalid",
  );
}

function decodeJitEdgeSamples(
  value: unknown,
): NonNullable<SystemTraceSnapshot["jitEdgeSamples"]> {
  if (!Array.isArray(value) || value.length > 262_144) {
    throw new VMError("PROTOCOL_ERROR", "JIT edge samples exceed their bound");
  }
  const identities = new Set<string>();
  return value.map((item: unknown, index: number) => {
    const sample = record(item, `JIT edge sample ${index}`);
    exactKeys(sample, [
      "sourceProfileModuleId",
      "targetProfileModuleId",
      "sourceCacheKey",
      "targetCacheKey",
      "sourceCompileGeneration",
      "targetCompileGeneration",
      "sourceDispatchSlot",
      "targetDispatchSlot",
      "sourceDispatchGeneration",
      "targetDispatchGeneration",
      "sourceInstructionIndex",
      "targetEntryIndex",
      "sourceTier",
      "targetTier",
      "sourceRip",
      "targetRip",
      "sourceSemantic",
      "targetSemantic",
      "kind",
      "samples",
      "retired",
    ]);
    const sourceProfileModuleId = string(
      sample["sourceProfileModuleId"],
      "JIT edge source module ID",
    );
    const targetProfileModuleId = string(
      sample["targetProfileModuleId"],
      "JIT edge target module ID",
    );
    if (
      !/^[0-9a-f]{16}$/u.test(sourceProfileModuleId)
      || !/^[0-9a-f]{16}$/u.test(targetProfileModuleId)
    ) {
      throw new VMError("PROTOCOL_ERROR", "JIT edge module ID is invalid");
    }
    const rawKind = decodeJitEdgeKind(sample["kind"]);
    const decoded = {
      sourceProfileModuleId,
      targetProfileModuleId,
      sourceCacheKey: nonnegativeBigint(sample["sourceCacheKey"], "JIT edge source cache key"),
      targetCacheKey: nonnegativeBigint(sample["targetCacheKey"], "JIT edge target cache key"),
      sourceCompileGeneration: integer(sample["sourceCompileGeneration"], "JIT edge source compile generation", 1),
      targetCompileGeneration: integer(sample["targetCompileGeneration"], "JIT edge target compile generation", 1),
      sourceDispatchSlot: integer(sample["sourceDispatchSlot"], "JIT edge source dispatch slot", 0, 16_383),
      targetDispatchSlot: integer(sample["targetDispatchSlot"], "JIT edge target dispatch slot", 0, 16_383),
      sourceDispatchGeneration: integer(sample["sourceDispatchGeneration"], "JIT edge source dispatch generation", 1),
      targetDispatchGeneration: integer(sample["targetDispatchGeneration"], "JIT edge target dispatch generation", 1),
      sourceInstructionIndex: integer(sample["sourceInstructionIndex"], "JIT edge source instruction", 0, 0x0fff),
      targetEntryIndex: integer(sample["targetEntryIndex"], "JIT edge target entry", 0, 0x0fff),
      sourceTier: decodeTraceTier(sample["sourceTier"], "JIT edge source tier"),
      targetTier: decodeTraceTier(sample["targetTier"], "JIT edge target tier"),
      sourceRip: nonnegativeBigint(sample["sourceRip"], "JIT edge source RIP"),
      targetRip: nonnegativeBigint(sample["targetRip"], "JIT edge target RIP"),
      sourceSemantic: integer(sample["sourceSemantic"], "JIT edge source semantic", 0),
      targetSemantic: integer(sample["targetSemantic"], "JIT edge target semantic", 0),
      kind: rawKind,
      samples: integer(sample["samples"], "JIT edge sample count", 1),
      retired: nonnegativeBigint(sample["retired"], "JIT edge retired delta"),
    };
    if (decoded.retired < BigInt(decoded.samples)) {
      throw new VMError("PROTOCOL_ERROR", "JIT edge retired delta is inconsistent");
    }
    const identity = [
      sourceProfileModuleId,
      targetProfileModuleId,
      decoded.sourceCompileGeneration,
      decoded.targetCompileGeneration,
      decoded.sourceDispatchSlot,
      decoded.targetDispatchSlot,
      decoded.sourceDispatchGeneration,
      decoded.targetDispatchGeneration,
      decoded.sourceInstructionIndex,
      decoded.targetEntryIndex,
      rawKind,
    ].join(":");
    if (identities.has(identity)) {
      throw new VMError("PROTOCOL_ERROR", "JIT edge sample identity is duplicated");
    }
    identities.add(identity);
    return decoded;
  });
}

export function decodeJitModules(
  value: unknown,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): NonNullable<SystemTraceSnapshot["jitModules"]> {
  if (!Array.isArray(value)) throw new VMError("PROTOCOL_ERROR", "profile JIT modules must be an array");
  if (value.length > JIT_DISPATCH_TABLE_ENTRIES) throw new VMError("PROTOCOL_ERROR", "profile JIT modules exceed their bound");
  const ids = new Set<string>();
  return value.map((item: unknown, index: number) => {
    const module = record(item, `profile JIT module ${index}`);
    exactKeys(
      module,
      schemaVersion >= 39
        ? ["profileModuleId", "cacheKey", "tier", "recordedProfileGeneration", "runtimeIdentity", "aotTrainingSource", "aotTraining", "instructions", "operations", "plan", "loopPolicy"]
        : schemaVersion >= 33
        ? ["profileModuleId", "cacheKey", "tier", "recordedProfileGeneration", "runtimeIdentity", "aotTrainingSource", "aotTraining", "instructions", "operations", "plan"]
        : schemaVersion >= 29
        ? ["profileModuleId", "cacheKey", "tier", "recordedProfileGeneration", "runtimeIdentity", "instructions", "operations", "plan"]
        : schemaVersion >= 28
        ? ["profileModuleId", "cacheKey", "tier", "instructions", "operations", "plan"]
        : ["profileModuleId", "cacheKey", "instructions", "operations", "plan"],
      schemaVersion >= 53 ? ["bindingIdentity", "artifactProfileModuleId", "artifactIdentity"] : [],
    );
    const profileModuleId = string(module["profileModuleId"], "profile JIT module ID");
    if (!/^[0-9a-f]{16}$/u.test(profileModuleId)) throw new VMError("PROTOCOL_ERROR", "profile JIT module ID is invalid");
    if (ids.has(profileModuleId)) throw new VMError("PROTOCOL_ERROR", "profile JIT module ID is duplicated");
    ids.add(profileModuleId);
    if (!Array.isArray(module["instructions"]) || !Array.isArray(module["operations"])) throw new VMError("PROTOCOL_ERROR", "profile JIT maps must be arrays");
    const instructions = module["instructions"].map((item: unknown) => {
      const instruction = record(item, "profile JIT instruction");
      exactKeys(instruction, ["rip", "semantic", "retired", "instructionForm"]);
      return { rip: nonnegativeBigint(instruction["rip"], "profile JIT RIP"), semantic: integer(instruction["semantic"], "profile JIT semantic", 0), retired: integer(instruction["retired"], "profile JIT retired", 1, 255), instructionForm: instruction["instructionForm"] === null ? null : integer(instruction["instructionForm"], "profile JIT form", 0, 0xffff) };
    });
    const operations = module["operations"].map((item: unknown) => {
      const operation = record(item, "profile JIT operation");
      exactKeys(
        operation,
        schemaVersion >= 39
          ? ["instructionIndex", "sourceIndex", "disposition", "emittedStart", "emittedEnd", "wireStart", "wireEnd", "instructionForm", "operationKind", "proofCostClass", "span"]
          : schemaVersion >= 29
          ? ["instructionIndex", "sourceIndex", "disposition", "emittedStart", "emittedEnd", "wireStart", "wireEnd", "instructionForm", "operationKind", "proofCostClass"]
          : ["instructionIndex", "sourceIndex", "disposition", "emittedStart", "emittedEnd", "wireStart", "wireEnd", "instructionForm", "operationKind"],
      );
      const rawDisposition = string(operation["disposition"], "profile JIT disposition");
      if (rawDisposition !== "emitted" && rawDisposition !== "folded" && rawDisposition !== "elided") throw new VMError("PROTOCOL_ERROR", "profile JIT disposition is invalid");
      const disposition: "emitted" | "folded" | "elided" = rawDisposition;
      return { instructionIndex: integer(operation["instructionIndex"], "profile JIT instruction index", 0), sourceIndex: integer(operation["sourceIndex"], "profile JIT source index", 0), disposition, emittedStart: integer(operation["emittedStart"], "profile JIT emitted start", 0), emittedEnd: integer(operation["emittedEnd"], "profile JIT emitted end", 0), wireStart: integer(operation["wireStart"], "profile JIT wire start", 0), wireEnd: integer(operation["wireEnd"], "profile JIT wire end", 0), instructionForm: operation["instructionForm"] === null ? null : integer(operation["instructionForm"], "profile JIT operation form", 0, 0xffff), operationKind: integer(operation["operationKind"], "profile JIT operation kind", 0, 0xffff), proofCostClass: schemaVersion >= 29 ? decodeJitProofCostClass(operation["proofCostClass"]) : "unchanged-generated-work", ...(schemaVersion >= 39 ? { span: decodeJitLoopSpan(operation["span"]) } : {}) };
    });
    if (instructions.length === 0 || instructions.length > JIT_REGION_MAX_INSTRUCTIONS || operations.length > instructions.length * 24 * (schemaVersion >= 39 ? 16 : 1) || operations.some((operation) => operation.instructionIndex >= instructions.length || operation.emittedStart > operation.emittedEnd || operation.wireStart > operation.wireEnd)) throw new VMError("PROTOCOL_ERROR", "profile JIT module map is inconsistent");
    const plan = record(module["plan"], "profile JIT plan");
    exactKeys(plan, ["initialStateMask", "dirtyStateMask", "stateMaterializationBoundaries", "segmentGuards"]);
    const rawTier = schemaVersion >= 28 ? string(module["tier"], "profile JIT tier") : "tier1";
    if (rawTier !== "tier1" && rawTier !== "tier2") {
      throw new VMError("PROTOCOL_ERROR", "profile JIT tier is invalid");
    }
    const recordedProfileGeneration = schemaVersion < 29 || module["recordedProfileGeneration"] === null
      ? null
      : nonnegativeBigint(module["recordedProfileGeneration"], "profile JIT recorded-profile generation");
    if (schemaVersion >= 29 && (rawTier === "tier2") !== (recordedProfileGeneration !== null)) {
      throw new VMError("PROTOCOL_ERROR", "profile JIT Tier-2 identity is inconsistent");
    }
    const runtimeIdentity = schemaVersion >= 29
      ? decodeJitRuntimeIdentity(module["runtimeIdentity"], schemaVersion)
      : null;
    const aotTrainingSource = schemaVersion >= 33 && module["aotTrainingSource"] !== null
      ? decodeJitAotTrainingSourceRecord(module["aotTrainingSource"])
      : null;
    if (aotTrainingSource !== null && (
      (schemaVersion < 38 && aotTrainingSource.version === 2)
      || aotTrainingSource.version !== (rawTier === "tier1" ? 1 : 2)
    )) throw new VMError("PROTOCOL_ERROR", "JIT training source version does not match its trace tier");
    const aotTraining = schemaVersion >= 33
      ? decodeAotTrainingStats(module["aotTraining"])
      : EMPTY_JIT_AOT_TRAINING_STATS;
    const bindingFields = decodeBindingFields(module, profileModuleId);
    const artifactIdentity = decodeArtifactIdentity(module["artifactIdentity"]);
    if (bindingFields.bindingIdentity !== undefined && artifactIdentity === undefined) throw new VMError("PROTOCOL_ERROR", "JIT binding is missing its executable artifact");
    return { ...bindingFields, ...(artifactIdentity === undefined ? {} : { artifactIdentity }), profileModuleId, cacheKey: nonnegativeBigint(module["cacheKey"], "profile JIT cache key"), tier: rawTier, recordedProfileGeneration, runtimeIdentity, aotTrainingSource, aotTraining, instructions, operations, ...(schemaVersion >= 39 ? { loopPolicy: module["loopPolicy"] === null ? null : decodeJitLoopPolicyRecord(module["loopPolicy"], instructions.length) } : {}), plan: { initialStateMask: nonnegativeBigint(plan["initialStateMask"], "profile JIT initial state mask"), dirtyStateMask: nonnegativeBigint(plan["dirtyStateMask"], "profile JIT dirty state mask"), stateMaterializationBoundaries: integer(plan["stateMaterializationBoundaries"], "profile JIT state boundaries", 0), segmentGuards: integer(plan["segmentGuards"], "profile JIT segment guards", 0) } };
  });
}

function decodeAotTrainingStats(value: unknown) {
  const stats = record(value, "JIT AOT training statistics");
  exactKeys(stats, ["emissions", "emittedBytes", "compilationMilliseconds", "instantiationMilliseconds", "installationMilliseconds", "outerEntries", "outerRetired"]);
  return {
    emissions: integer(stats["emissions"], "JIT AOT emissions", 0),
    emittedBytes: integer(stats["emittedBytes"], "JIT AOT emitted bytes", 0),
    compilationMilliseconds: finiteNonnegativeNumber(stats["compilationMilliseconds"], "JIT AOT compilation milliseconds"),
    instantiationMilliseconds: finiteNonnegativeNumber(stats["instantiationMilliseconds"], "JIT AOT instantiation milliseconds"),
    installationMilliseconds: finiteNonnegativeNumber(stats["installationMilliseconds"], "JIT AOT installation milliseconds"),
    outerEntries: integer(stats["outerEntries"], "JIT AOT outer entries", 0),
    outerRetired: nonnegativeBigint(stats["outerRetired"], "JIT AOT outer retired instructions"),
  };
}

function decodeBindingFields(module: Record<string, unknown>, profileModuleId: string): {
  readonly bindingIdentity?: { readonly id: bigint; readonly originBindingId: bigint };
  readonly artifactProfileModuleId?: string | null;
} {
  if (module["bindingIdentity"] === undefined && module["artifactProfileModuleId"] === undefined) return {};
  const identity = record(module["bindingIdentity"], "JIT binding identity");
  exactKeys(identity, ["id", "originBindingId"]);
  const id = nonnegativeBigint(identity["id"], "JIT binding ID");
  const originBindingId = nonnegativeBigint(identity["originBindingId"], "JIT origin binding ID");
  const artifactProfileModuleId = module["artifactProfileModuleId"] === null ? null
    : string(module["artifactProfileModuleId"], "JIT artifact profile ID");
  if (id === 0n || id > 0xffff_ffff_ffff_ffffn || originBindingId === 0n || originBindingId > id
    || profileModuleId !== id.toString(16).padStart(16, "0")
    || artifactProfileModuleId !== null && !/^[0-9a-f]{16}$/u.test(artifactProfileModuleId)) {
    throw new VMError("PROTOCOL_ERROR", "JIT binding identity is invalid");
  }
  return { bindingIdentity: { id, originBindingId }, artifactProfileModuleId };
}

function decodeArtifactIdentity(value: unknown): { readonly cacheKey: bigint; readonly moduleLength: number } | undefined {
  if (value === undefined) return undefined;
  const identity = record(value, "JIT artifact identity");
  exactKeys(identity, ["cacheKey", "moduleLength"]);
  const cacheKey = nonnegativeBigint(identity["cacheKey"], "JIT artifact cache key");
  const moduleLength = integer(identity["moduleLength"], "JIT artifact module length", 1, 0xffff_ffff);
  if (cacheKey === 0n || cacheKey > 0xffff_ffff_ffff_ffffn) throw new VMError("PROTOCOL_ERROR", "JIT artifact cache key is invalid");
  return { cacheKey, moduleLength };
}
