import type { CodeSegmentContext } from "./code-segment-context.js";
import { decodeCodeSegmentContext } from "./code-segment-context.js";
import { boolean, exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import {
  JIT_DISPATCH_TABLE_ENTRIES,
  JIT_REGION_MAX_INSTRUCTIONS,
} from "../jit-cache.js";
import { nonnegativeBigint } from "./decoders.js";
import type {
  SystemTraceJitEdgeKind,
  SystemTraceSnapshot,
} from "./system.js";
import {
  decodeJitAotTrainingSource,
  type JitAotTrainingSource,
} from "./system-trace-jit-aot.js";
import { decodeJitLoopPolicy, JIT_LOOP_SPANS, type JitLoopPolicy, type JitLoopSpan } from "./system-trace-jit-loops.js";

const MODULE_HEADER = [0, 97, 115, 109, 1, 0, 0, 0] as const;
export const JIT_OPERATION_SAMPLE_LIMIT = 16_384;
const LEGACY_RIP_MAP_ENTRY_BYTES = 13;
const RIP_MAP_HEADER_BYTES = 8;
const RIP_MAP_ENTRY_BYTES = 15;
const RIP_MAP_VERSION = 2;
const LEGACY_IR_MAP_HEADER_BYTES = 32;
const IR_MAP_HEADER_BYTES_V4 = 36;
const LEGACY_IR_MAP_ENTRY_BYTES = 12;
const IR_MAP_ENTRY_BYTES_V3 = 16;
const IR_MAP_ENTRY_BYTES_V5 = 18;
const MAX_IR_OPERATIONS = 24;
const ARCHITECTURAL_STATE_MASK = 0x0000_000f_0000_ffffn;
const CONTEXT_RIP_OFFSET = 140;
const CONTEXT_HALTED_OFFSET = 156;
const CONTEXT_RETIRED_OFFSET = 208;
const CONTEXT_FORCE_EXIT_OFFSET = 224;
const CONTEXT_ENTRY_INDEX_OFFSET = 232;
const CONTEXT_READ_EPOCH_OFFSET = 236;
const CONTEXT_WRITE_EPOCH_OFFSET = 22_768;
const CONTEXT_CR3_OFFSET = 22_856;
const CONTEXT_LAST_DISPATCH_SLOT_OFFSET = 23_400;
const CONTEXT_CHAIN_TRANSITIONS_OFFSET = CONTEXT_LAST_DISPATCH_SLOT_OFFSET + 4;
const CONTEXT_DISPATCH_EPOCH_OFFSET = 23_408;
const CONTEXT_PENDING_WRITES_OFFSET = 23_416;

export interface JitTraceInstruction {
  readonly rip: bigint;
  readonly semantic: number;
  readonly retired: number;
  readonly instructionForm: number | null;
}

export interface JitTraceOperation {
  readonly span?: JitLoopSpan;
  readonly instructionIndex: number;
  readonly sourceIndex: number;
  readonly disposition: "emitted" | "folded" | "elided";
  readonly emittedStart: number;
  readonly emittedEnd: number;
  readonly wireStart: number;
  readonly wireEnd: number;
  readonly instructionForm: number | null;
  readonly operationKind: number;
  readonly proofCostClass:
    | "dispatcher-transition"
    | "architectural-state"
    | "flag-maintenance"
    | "read-translation"
    | "write-rmw-translation"
    | "added-cache-guard-backedge"
    | "unchanged-generated-work";
}

export interface JitRuntimeCodePage {
  readonly linear: bigint;
  readonly physical: bigint;
  readonly generation: bigint;
  readonly globalSupervisor: boolean;
}

export interface JitRuntimeIdentity extends CodeSegmentContext {
  readonly mode: "real" | "protected" | "compatibility" | "long";
  readonly cpl: 0 | 1 | 2 | 3;
  readonly profile: "baseline" | "x86-64-v2" | "x86-64-v3";
  readonly codeAttributes: number;
  readonly capabilityRevision: 0 | 1;
  readonly addressSpaceId: bigint | null;
  readonly addressSpaceScoped: boolean;
  readonly codePages: readonly JitRuntimeCodePage[];
}

export interface JitBindingIdentity {
  readonly id: bigint;
  readonly originBindingId: bigint;
}

export interface JitModuleTraceMap {
  readonly artifactIdentity?: { readonly cacheKey: bigint; readonly moduleLength: number };
  readonly bindingIdentity?: JitBindingIdentity;
  readonly artifactProfileModuleId?: string | null;
  readonly loopPolicy?: JitLoopPolicy | null;
  readonly profileModuleId: string | null;
  readonly tier: "tier1" | "tier2";
  readonly recordedProfileGeneration: bigint | null;
  readonly runtimeIdentity: JitRuntimeIdentity | null;
  readonly aotTrainingSource: JitAotTrainingSource | null;
  readonly instructions: readonly JitTraceInstruction[];
  readonly operations: readonly JitTraceOperation[];
  readonly plan: {
    readonly initialStateMask: bigint;
    readonly dirtyStateMask: bigint;
    readonly stateMaterializationBoundaries: number;
    readonly segmentGuards: number;
  };
}

export interface JitContextDiagnostics {
  readonly cr3: bigint;
  readonly forceExit: boolean;
  readonly entryIndex: number;
  readonly readEpoch: number;
  readonly writeEpoch: bigint;
  readonly lastDispatchSlot: number | null;
  readonly dispatchEpoch: bigint;
  readonly pendingWrites: bigint;
}

export interface JitExecutionDiagnostics {
  readonly rip: bigint;
  readonly retired: bigint;
  readonly halted: boolean;
  readonly lastDispatchSlot: number | null;
  readonly chainTransitions: number;
}

export function decodeJitRuntimeIdentity(value: unknown, schemaVersion = 48): JitRuntimeIdentity {
  const identity = record(value, "profile JIT runtime identity");
  exactKeys(identity, ["mode", "cpl", "profile", "codeAttributes", "addressSpaceId", "addressSpaceScoped", "codePages", ...(schemaVersion >= 45 ? ["capabilityRevision"] : []), ...(schemaVersion >= 48 ? ["codeSegmentBase", "codeSegmentLimit"] : [])], schemaVersion < 48 ? ["codeSegmentBase", "codeSegmentLimit"] : []);
  const mode = string(identity["mode"], "profile JIT runtime mode");
  if (mode !== "real" && mode !== "protected" && mode !== "compatibility" && mode !== "long") {
    throw new VMError("PROTOCOL_ERROR", "profile JIT runtime mode is invalid");
  }
  const profile = string(identity["profile"], "profile JIT CPU profile");
  if (profile !== "baseline" && profile !== "x86-64-v2" && profile !== "x86-64-v3") {
    throw new VMError("PROTOCOL_ERROR", "profile JIT CPU profile is invalid");
  }
  if (!Array.isArray(identity["codePages"]) || identity["codePages"].length === 0 || identity["codePages"].length > 8) {
    throw new VMError("PROTOCOL_ERROR", "profile JIT code pages are invalid");
  }
  const pageIdentities = new Set<string>();
  const codePages = identity["codePages"].map((value: unknown, index: number) => {
    const page = record(value, `profile JIT code page ${String(index)}`);
    exactKeys(page, ["linear", "physical", "generation", "globalSupervisor"]);
    const linear = nonnegativeBigint(page["linear"], "profile JIT linear code page");
    const physical = nonnegativeBigint(page["physical"], "profile JIT physical code page");
    const generation = nonnegativeBigint(page["generation"], "profile JIT code generation");
    if (((linear | physical) & 0xfffn) !== 0n || typeof page["globalSupervisor"] !== "boolean") {
      throw new VMError("PROTOCOL_ERROR", "profile JIT code page is invalid");
    }
    const key = `${linear.toString()}:${physical.toString()}:${generation.toString()}`;
    if (pageIdentities.has(key)) {
      throw new VMError("PROTOCOL_ERROR", "profile JIT code page is duplicated");
    }
    pageIdentities.add(key);
    return { linear, physical, generation, globalSupervisor: page["globalSupervisor"] };
  });
  const addressSpaceId = identity["addressSpaceId"] === null
    ? null
    : nonnegativeBigint(identity["addressSpaceId"], "profile JIT address-space identity");
  const addressSpaceScoped = boolean(identity["addressSpaceScoped"], "profile JIT address-space scope");
  if (addressSpaceId === 0n || addressSpaceScoped && addressSpaceId === null) {
    throw new VMError("PROTOCOL_ERROR", "profile JIT address-space identity is invalid");
  }
  return {
    mode,
    cpl: decodeCpl(integer(identity["cpl"], "profile JIT CPL", 0, 3)),
    profile,
    codeAttributes: integer(identity["codeAttributes"], "profile JIT code attributes", 0, 0xffff),
    ...decodeCodeSegmentContext(identity["codeSegmentBase"], identity["codeSegmentLimit"], mode === "long", schemaVersion >= 48 && identity["codeSegmentBase"] !== null),
    capabilityRevision: decodeCapabilityRevision(schemaVersion >= 45 ? identity["capabilityRevision"] : 0),
    addressSpaceId,
    addressSpaceScoped,
    codePages,
  };
}

export function decodeTraceTier(value: unknown, label: string): "tier1" | "tier2" {
  const tier = string(value, label);
  if (tier === "tier1" || tier === "tier2") return tier;
  throw new VMError("PROTOCOL_ERROR", `${label} is invalid`);
}

export function decodeJitEdgeKind(value: unknown): SystemTraceJitEdgeKind {
  const kind = string(value, "JIT edge kind");
  if (kind === "direct" || kind === "conditional" || kind === "call" || kind === "indirect") {
    return kind;
  }
  throw new VMError("PROTOCOL_ERROR", "JIT edge kind is invalid");
}

export function decodeJitProofCostClass(value: unknown): JitTraceOperation["proofCostClass"] {
  const costClass = string(value, "profile JIT proof cost class");
  if (
    costClass === "dispatcher-transition"
    || costClass === "architectural-state"
    || costClass === "flag-maintenance"
    || costClass === "read-translation"
    || costClass === "write-rmw-translation"
    || costClass === "added-cache-guard-backedge"
    || costClass === "unchanged-generated-work"
  ) return costClass;
  throw new VMError("PROTOCOL_ERROR", "profile JIT proof cost class is invalid");
}

export function decodeJitOperationSamples(
  value: unknown,
  spans = false,
): NonNullable<SystemTraceSnapshot["jitOperationSamples"]> {
  if (!Array.isArray(value) || value.length > JIT_OPERATION_SAMPLE_LIMIT) {
    throw new VMError("PROTOCOL_ERROR", "JIT operation samples exceed their bound");
  }
  const identities = new Set<string>();
  return value.map((item: unknown, index: number) => {
    const sample = record(item, `JIT operation sample ${index}`);
    exactKeys(sample, ["profileModuleId", "instructionIndex", "sourceIndex", "operationKind", "samples", ...(spans ? ["span"] : [])]);
    const span = spans ? sample["span"] : "ordinary";
    if (span !== "ordinary" && span !== "specialized") throw new VMError("PROTOCOL_ERROR", "JIT operation sample span is invalid");
    const profileModuleId = string(sample["profileModuleId"], "JIT operation sample module ID");
    if (!/^[0-9a-f]{16}$/u.test(profileModuleId)) {
      throw new VMError("PROTOCOL_ERROR", "JIT operation sample module ID is invalid");
    }
    const instructionIndex = integer(sample["instructionIndex"], "JIT operation sample instruction", 0, 0xffff);
    const sourceIndex = integer(sample["sourceIndex"], "JIT operation sample source", 0, 0xff);
    const operationKind = integer(sample["operationKind"], "JIT operation sample kind", 0, 0xffff);
    const identity = `${profileModuleId}:${String(instructionIndex)}:${String(sourceIndex)}:${String(operationKind)}:${span}`;
    if (identities.has(identity)) {
      throw new VMError("PROTOCOL_ERROR", "JIT operation sample identity is duplicated");
    }
    identities.add(identity);
    return {
      profileModuleId,
      ...(spans ? { span } : {}),
      instructionIndex,
      sourceIndex,
      operationKind,
      samples: integer(sample["samples"], "JIT operation sample count", 1),
    };
  });
}

function decodeCpl(value: number): 0 | 1 | 2 | 3 {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  throw new VMError("PROTOCOL_ERROR", "profile JIT CPL is invalid");
}

export function decodeSystemJitModuleMap(module: Uint8Array): JitModuleTraceMap {
  const input = new Reader(module);
  for (const expected of MODULE_HEADER) {
    if (input.byte() !== expected) throw new TypeError("invalid JIT Wasm header");
  }
  let ripMap: Uint8Array | undefined;
  let irMap: Uint8Array | undefined;
  let loopPolicyBytes: Uint8Array | undefined;
  let hasNameSection = false;
  let profileModuleId: string | null = null;
  let bindingIdentity: JitBindingIdentity | undefined;
  let recordedProfileGeneration: bigint | null = null;
  let runtimeIdentity: JitRuntimeIdentity | null = null;
  let aotTrainingSource: JitAotTrainingSource | null = null;
  let traceBodyStart: number | null = null;
  let lastSection = 0;
  while (!input.done()) {
    const id = input.byte();
    const payloadBytes = input.sized();
    const payloadStart = input.position - payloadBytes.byteLength;
    const payload = new Reader(payloadBytes);
    if (id === 0) {
      const name = payload.name();
      if (name === "oxidevm.rip-map" && ripMap === undefined) {
        ripMap = payload.rest();
      } else if (name === "oxidevm.ir-map" && irMap === undefined) {
        irMap = payload.rest();
      } else if (name === "oxidevm.loop-policy" && loopPolicyBytes === undefined) {
        loopPolicyBytes = payload.rest();
      } else if (name === "name" && !hasNameSection) {
        hasNameSection = true;
        profileModuleId = decodeProfileModuleId(payload.rest());
      } else if (
        name === "oxidevm.tier2-profile" &&
        recordedProfileGeneration === null
      ) {
        const identity = payload.rest();
        if (
          identity.byteLength !== 12 ||
          view(identity).getUint32(0, true) !== 1
        ) {
          throw new TypeError("invalid JIT Wasm Tier-2 profile identity");
        }
        recordedProfileGeneration = view(identity).getBigUint64(4, true);
      } else if (name === "oxidevm.binding-identity" && bindingIdentity === undefined) {
        const bytes = payload.rest();
        if (bytes.byteLength !== 20 || view(bytes).getUint32(0, true) !== 1) {
          throw new TypeError("invalid JIT binding identity");
        }
        const id = view(bytes).getBigUint64(4, true);
        const originBindingId = view(bytes).getBigUint64(12, true);
        if (id === 0n || originBindingId === 0n || originBindingId > id) {
          throw new TypeError("invalid JIT binding identity");
        }
        bindingIdentity = { id, originBindingId };
      } else if (
        name === "oxidevm.runtime-identity" &&
        runtimeIdentity === null
      ) {
        runtimeIdentity = decodeRuntimeIdentity(payload.rest());
      } else if (
        name === "oxidevm.aot-training" &&
        aotTrainingSource === null
      ) {
        aotTrainingSource = decodeJitAotTrainingSource(payload.rest());
      } else {
        throw new TypeError("unexpected JIT Wasm custom section");
      }
    } else {
      if (id <= lastSection) throw new TypeError("JIT Wasm sections are out of order");
      lastSection = id;
      if (id === 10) {
        const count = payload.u32();
        if (count === 0) throw new TypeError("JIT Wasm code section is empty");
        const body = payload.sized();
        traceBodyStart = payloadStart + payload.position - body.byteLength;
        payload.rest();
      } else {
        payload.rest();
      }
    }
    payload.finish("JIT Wasm section");
  }
  if (ripMap === undefined || ripMap.byteLength === 0) {
    throw new TypeError("invalid JIT Wasm RIP map");
  }
  const ripView = view(ripMap);
  const firstRipWord = ripMap.byteLength >= 4 ? ripView.getUint32(0, true) : 0;
  const newRipCount = ripMap.byteLength >= RIP_MAP_HEADER_BYTES ? ripView.getUint32(4, true) : 0;
  const newRipMap = firstRipWord === RIP_MAP_VERSION && ripMap.byteLength === RIP_MAP_HEADER_BYTES + newRipCount * RIP_MAP_ENTRY_BYTES;
  const legacyRipMap = !newRipMap && ripMap.byteLength % LEGACY_RIP_MAP_ENTRY_BYTES === 0;
  const ripVersion = legacyRipMap
    ? 1
    : ripView.getUint32(0, true);
  const ripCount = legacyRipMap
    ? ripMap.byteLength / LEGACY_RIP_MAP_ENTRY_BYTES
    : ripView.getUint32(4, true);
  if (!legacyRipMap && ripVersion !== RIP_MAP_VERSION) {
    throw new TypeError("unsupported JIT Wasm RIP map version");
  }
  const instructionCount = ripCount;
  if (instructionCount === 0 || instructionCount > JIT_REGION_MAX_INSTRUCTIONS) {
    throw new TypeError("JIT Wasm RIP map exceeds the region limit");
  }
  if (irMap === undefined || irMap.byteLength < LEGACY_IR_MAP_HEADER_BYTES) {
    throw new TypeError("invalid JIT Wasm IR map");
  }
  if (traceBodyStart === null) throw new TypeError("invalid JIT Wasm code section");
  const instructions = Array.from(
    { length: instructionCount },
    (_, index): JitTraceInstruction => {
      const offset = legacyRipMap
        ? index * LEGACY_RIP_MAP_ENTRY_BYTES
        : RIP_MAP_HEADER_BYTES + index * RIP_MAP_ENTRY_BYTES;
      const retired = ripView.getUint8(offset + 12);
      if (retired === 0) throw new TypeError("invalid JIT Wasm retired count");
      return {
        rip: ripView.getBigUint64(offset, true),
        semantic: ripView.getUint32(offset + 8, true),
        retired,
        instructionForm: legacyRipMap
          ? null
          : readForm(ripView.getUint16(offset + 13, true)),
      };
    },
  );
  const irView = view(irMap);
  const irVersion = irView.getUint32(0, true);
  if (!isIrMapVersion(irVersion)) {
    throw new TypeError("unsupported JIT Wasm IR map version");
  }
  const irEntryBytes = irVersion === 2
    ? LEGACY_IR_MAP_ENTRY_BYTES
    : irVersion >= 5
      ? IR_MAP_ENTRY_BYTES_V5
      : IR_MAP_ENTRY_BYTES_V3;
  const irHeaderBytes = irVersion >= 4
    ? IR_MAP_HEADER_BYTES_V4
    : LEGACY_IR_MAP_HEADER_BYTES;
  const operationCount = irView.getUint32(4, true);
  const initialStateMask = irView.getBigUint64(8, true);
  const dirtyStateMask = irView.getBigUint64(16, true);
  const stateMaterializationBoundaries = irView.getUint32(24, true);
  const segmentGuards = irView.getUint32(28, true);
  if (
    operationCount > instructionCount * MAX_IR_OPERATIONS * (irVersion === 6 ? 16 : 1) ||
    irMap.byteLength !== irHeaderBytes + operationCount * irEntryBytes ||
    (initialStateMask | dirtyStateMask) & ~ARCHITECTURAL_STATE_MASK ||
    stateMaterializationBoundaries > instructionCount + 2 ||
    segmentGuards > instructionCount + 1
  ) {
    throw new TypeError("invalid JIT Wasm IR map length");
  }
  const tier = irVersion >= 4 ? decodeTier(irView, 32) : "tier1";
  if (tier !== "tier2" && recordedProfileGeneration !== null) {
    throw new TypeError("Tier-1 JIT Wasm has Tier-2 profile identity");
  }
  let previousIdentity = -1;
  let previousStart = -1;
  const operations = Array.from(
    { length: operationCount },
    (_, index): JitTraceOperation => {
      const offset = irHeaderBytes + index * irEntryBytes;
      const instructionIndex = irView.getUint16(offset, true);
      const sourceIndex = irView.getUint8(offset + 2);
      const rawDisposition = irView.getUint8(offset + 3);
      const emittedStart = irView.getUint32(offset + 4, true);
      const emittedEnd = irView.getUint32(offset + 8, true);
      const instructionForm =
        irVersion >= 3 ? readForm(irView.getUint16(offset + 12, true)) : null;
      const operationKind = irVersion >= 3 ? irView.getUint16(offset + 14, true) : 0;
      const proofCostClass = irVersion >= 5
        ? decodeProofCostClass(irView.getUint8(offset + 16))
        : "unchanged-generated-work";
      const spanIndex = irVersion === 6 ? irView.getUint8(offset + 17) : 0;
      const span = JIT_LOOP_SPANS[spanIndex];
      const identity = (instructionIndex * MAX_IR_OPERATIONS + sourceIndex) * 16 + spanIndex;
      if (
        instructionIndex >= instructionCount ||
        sourceIndex >= MAX_IR_OPERATIONS ||
        rawDisposition > 2 ||
        (identity < previousIdentity || identity === previousIdentity && (spanIndex < 2 || emittedStart <= previousStart)) ||
        span === undefined ||
        emittedStart > emittedEnd ||
        emittedEnd > module.byteLength ||
        traceBodyStart + emittedEnd > module.byteLength ||
        (rawDisposition === 2 && emittedStart !== emittedEnd)
        || (irVersion === 5 && irView.getUint8(offset + 17) !== 0)
      ) {
        throw new TypeError("invalid JIT Wasm IR map entry");
      }
      previousIdentity = identity;
      previousStart = emittedStart;
      return {
        span,
        instructionIndex,
        sourceIndex,
        disposition:
          rawDisposition === 0
            ? "emitted"
            : rawDisposition === 1
              ? "folded"
              : "elided",
        emittedStart,
        emittedEnd,
        wireStart: traceBodyStart + emittedStart,
        wireEnd: traceBodyStart + emittedEnd,
        instructionForm,
        operationKind,
        proofCostClass,
      };
    },
  );
  if (
    aotTrainingSource !== null
    && (
      (aotTrainingSource.version === 1 ? tier !== "tier1" : tier !== "tier2")
      || !sameAotInstructionIdentity(aotTrainingSource.instructions, instructions)
    )
  ) {
    throw new TypeError("JIT AOT training source does not match its instruction map");
  }
  const loopPolicy = loopPolicyBytes === undefined ? null : decodeJitLoopPolicy(loopPolicyBytes, instructionCount);
  if (loopPolicy !== null && (irVersion !== 6 || (loopPolicy.decision === "selected"
    ? tier !== "tier2"
      || !loopPolicy.nodes.every((node) => operations.some((operation) => operation.instructionIndex === node && operation.span === "specialized"))
      || !loopPolicy.reads.every((read) => operations.some((operation) => operation.instructionIndex === read.instructionIndex && operation.sourceIndex === read.sourceIndex && operation.span === "specialized"))
      || operations.some((operation) => operation.span !== "ordinary" && !loopPolicy.nodes.includes(operation.instructionIndex))
    : operations.some((operation) => operation.span !== "ordinary")))) {
    throw new TypeError("JIT loop policy does not match its source spans");
  }
  return {
    loopPolicy,
    profileModuleId,
    ...(bindingIdentity === undefined ? {} : {
      artifactProfileModuleId: profileModuleId,
      profileModuleId: bindingIdentity.id.toString(16).padStart(16, "0"),
      bindingIdentity,
    }),
    tier,
    recordedProfileGeneration,
    runtimeIdentity,
    aotTrainingSource,
    instructions,
    operations,
    plan: {
      initialStateMask,
      dirtyStateMask,
      stateMaterializationBoundaries,
      segmentGuards,
    },
  };
}

function sameAotInstructionIdentity(
  sources: JitAotTrainingSource["instructions"],
  instructions: readonly JitTraceInstruction[],
): boolean {
  if (sources.length !== instructions.length) return false;
  return sources.every((source, index) => {
    const instruction = instructions[index];
    return instruction !== undefined
      && source.rip === instruction.rip
      && source.semantic === instruction.semantic
      && source.instructionForm === instruction.instructionForm;
  });
}

function decodeRuntimeIdentity(bytes: Uint8Array): JitRuntimeIdentity {
  if (bytes.byteLength < 16) {
    throw new TypeError("invalid JIT Wasm runtime identity");
  }
  const identity = view(bytes);
  const version = identity.getUint32(0, true);
  const pageCount = identity.getUint32(12, true);
  const headerBytes = version >= 4 ? 40 : version >= 2 ? 24 : 16;
  if (
    (version !== 1 && version !== 2 && version !== 3 && version !== 4) ||
    (version === 1 ? identity.getUint8(7) !== 0 : identity.getUint8(7) > 1) ||
    (version >= 3 ? identity.getUint8(10) > 1 || identity.getUint8(11) !== 0 : identity.getUint16(10, true) !== 0) ||
    pageCount === 0 ||
    pageCount > 8 ||
    (version >= 4 && bytes.byteLength >= 40 && identity.getUint32(36, true) !== 0) ||
    (version >= 2 && bytes.byteLength >= 24 && identity.getBigUint64(16, true) === 0n) ||
    bytes.byteLength !== headerBytes + pageCount * 32
  ) {
    throw new TypeError("invalid JIT Wasm runtime identity");
  }
  const mode = decodeRuntimeMode(identity.getUint8(4));
  const cpl = decodeRuntimeCpl(identity.getUint8(5));
  const profile = decodeRuntimeProfile(identity.getUint8(6));
  const codePages = Array.from({ length: pageCount }, (_, index) => {
    const offset = headerBytes + index * 32;
    const linear = identity.getBigUint64(offset, true);
    const physical = identity.getBigUint64(offset + 8, true);
    const generation = identity.getBigUint64(offset + 16, true);
    const globalSupervisor = identity.getUint8(offset + 24);
    if (
      ((linear | physical) & 0xfffn) !== 0n ||
      globalSupervisor > 1 ||
      identity.getBigUint64(offset + 24, true) > 1n
    ) {
      throw new TypeError("invalid JIT Wasm runtime code page");
    }
    return {
      linear,
      physical,
      generation,
      globalSupervisor: globalSupervisor === 1,
    };
  });
  return {
    mode,
    cpl,
    profile,
    codeAttributes: identity.getUint16(8, true),
    ...decodeCodeSegmentContext(version >= 4 ? identity.getBigUint64(24, true) : null, version >= 4 ? identity.getUint32(32, true) : null, mode === "long", version >= 4),
    capabilityRevision: version >= 3 && identity.getUint8(10) === 1 ? 1 : 0,
    addressSpaceId: version >= 2 ? identity.getBigUint64(16, true) : null,
    addressSpaceScoped: version >= 2 && identity.getUint8(7) === 1,
    codePages,
  };
}

function decodeCapabilityRevision(value: unknown): 0 | 1 {
  if (value === 0 || value === 1) return value;
  throw new VMError("PROTOCOL_ERROR", "profile JIT capability revision is invalid");
}

function decodeRuntimeCpl(value: number): JitRuntimeIdentity["cpl"] {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  throw new TypeError("invalid JIT Wasm runtime CPL");
}

function decodeRuntimeMode(value: number): JitRuntimeIdentity["mode"] {
  switch (value) {
    case 0: return "real";
    case 1: return "protected";
    case 2: return "compatibility";
    case 3: return "long";
    default: throw new TypeError("invalid JIT Wasm runtime mode");
  }
}

function decodeRuntimeProfile(value: number): JitRuntimeIdentity["profile"] {
  switch (value) {
    case 0: return "baseline";
    case 1: return "x86-64-v2";
    case 2: return "x86-64-v3";
    default: throw new TypeError("invalid JIT Wasm runtime profile");
  }
}

function decodeProfileModuleId(bytes: Uint8Array): string | null {
  const input = new Reader(bytes);
  while (!input.done()) {
    const subsection = input.byte();
    const contents = new Reader(input.sized());
    if (subsection !== 1) { contents.rest(); continue; }
    const count = contents.u32();
    for (let index = 0; index < count; index += 1) {
      contents.u32();
      const match = /^oxidevm_tb_([0-9a-f]{16})_r[0-9a-f]{16}(?:_(?:record|profile))?$/u
        .exec(contents.name());
      if (match?.[1] !== undefined) return match[1];
    }
    contents.finish("JIT Wasm function names");
  }
  return null;
}

function isIrMapVersion(value: number): value is 2 | 3 | 4 | 5 | 6 {
  return value === 2 || value === 3 || value === 4 || value === 5 || value === 6;
}

function decodeProofCostClass(value: number): JitTraceOperation["proofCostClass"] {
  switch (value) {
    case 1: return "dispatcher-transition";
    case 2: return "architectural-state";
    case 3: return "flag-maintenance";
    case 4: return "read-translation";
    case 5: return "write-rmw-translation";
    case 6: return "added-cache-guard-backedge";
    case 7: return "unchanged-generated-work";
    default: throw new TypeError("invalid JIT Wasm proof cost class");
  }
}

function decodeTier(view: DataView, offset: number): JitModuleTraceMap["tier"] {
  if (
    view.getUint8(offset + 1) !== 0 ||
    view.getUint8(offset + 2) !== 0 ||
    view.getUint8(offset + 3) !== 0
  ) {
    throw new TypeError("invalid JIT Wasm tier header");
  }
  const tier = view.getUint8(offset);
  if (tier === 1) return "tier1";
  if (tier === 2) return "tier2";
  throw new TypeError("invalid JIT Wasm tier");
}

export function decodeSystemJitRipMap(
  module: Uint8Array,
): readonly JitTraceInstruction[] {
  return decodeSystemJitModuleMap(module).instructions;
}

export function readSystemJitLastDispatchSlot(
  memory: { readonly buffer: ArrayBufferLike },
  contextPointer: number,
): number | null {
  return readSystemJitContextDiagnostics(memory, contextPointer).lastDispatchSlot;
}

export function readSystemJitContextDiagnostics(
  memory: { readonly buffer: ArrayBufferLike },
  contextPointer: number,
): JitContextDiagnostics {
  assertContext(memory, contextPointer);
  const view = new DataView(memory.buffer);
  const slot = view.getUint32(contextPointer + CONTEXT_LAST_DISPATCH_SLOT_OFFSET, true);
  return {
    cr3: view.getBigUint64(contextPointer + CONTEXT_CR3_OFFSET, true),
    forceExit: view.getBigUint64(contextPointer + CONTEXT_FORCE_EXIT_OFFSET, true) !== 0n,
    entryIndex: view.getUint32(contextPointer + CONTEXT_ENTRY_INDEX_OFFSET, true),
    readEpoch: view.getUint32(contextPointer + CONTEXT_READ_EPOCH_OFFSET, true),
    writeEpoch: view.getBigUint64(contextPointer + CONTEXT_WRITE_EPOCH_OFFSET, true),
    lastDispatchSlot:
      slot < JIT_DISPATCH_TABLE_ENTRIES ? slot : null,
    dispatchEpoch: view.getBigUint64(contextPointer + CONTEXT_DISPATCH_EPOCH_OFFSET, true),
    pendingWrites: view.getBigUint64(contextPointer + CONTEXT_PENDING_WRITES_OFFSET, true),
  };
}

export function readSystemJitExecutionDiagnostics(
  memory: { readonly buffer: ArrayBufferLike },
  contextPointer: number,
): JitExecutionDiagnostics {
  assertContext(memory, contextPointer);
  const view = new DataView(memory.buffer);
  const slot = view.getUint32(contextPointer + CONTEXT_LAST_DISPATCH_SLOT_OFFSET, true);
  return {
    rip: view.getBigUint64(contextPointer + CONTEXT_RIP_OFFSET, true),
    retired: view.getBigUint64(contextPointer + CONTEXT_RETIRED_OFFSET, true),
    halted: view.getUint8(contextPointer + CONTEXT_HALTED_OFFSET) !== 0,
    lastDispatchSlot: slot < JIT_DISPATCH_TABLE_ENTRIES ? slot : null,
    chainTransitions: view.getUint32(contextPointer + CONTEXT_CHAIN_TRANSITIONS_OFFSET, true),
  };
}

function assertContext(
  memory: { readonly buffer: ArrayBufferLike },
  contextPointer: number,
): void {
  const end = contextPointer + CONTEXT_PENDING_WRITES_OFFSET + 8;
  if (
    !Number.isSafeInteger(contextPointer) ||
    contextPointer < 0 ||
    end < contextPointer ||
    end > memory.buffer.byteLength
  ) {
    throw new TypeError("JIT context points outside Wasm memory");
  }
}

function readForm(value: number): number | null {
  return value === 0xffff ? null : value;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get position(): number { return this.offset; }

  byte(): number {
    const value = this.bytes[this.offset];
    if (value === undefined) throw new TypeError("truncated JIT Wasm module");
    this.offset += 1;
    return value;
  }

  u32(): number {
    let value = 0;
    for (let index = 0; index < 5; index += 1) {
      const byte = this.byte();
      if (index === 4 && byte > 0x0f) throw new TypeError("invalid JIT Wasm integer");
      value += (byte & 0x7f) * 2 ** (index * 7);
      if ((byte & 0x80) === 0) return value;
    }
    throw new TypeError("invalid JIT Wasm integer");
  }

  sized(): Uint8Array {
    return this.take(this.u32());
  }

  name(): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.sized());
  }

  rest(): Uint8Array {
    return this.take(this.bytes.byteLength - this.offset);
  }

  done(): boolean {
    return this.offset === this.bytes.byteLength;
  }

  finish(label: string): void {
    if (!this.done()) throw new TypeError(`${label} has trailing data`);
  }

  private take(length: number): Uint8Array {
    const end = this.offset + length;
    if (!Number.isSafeInteger(end) || end > this.bytes.byteLength) {
      throw new TypeError("truncated JIT Wasm module");
    }
    const value = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return value;
  }
}
