import { BinaryCursor, RECORD_HEADER_LENGTH, expectMagic, fault } from "./cursor.ts";

export const JIT_API_VERSION = 93;
export const JIT_ACTION_RECORD_VERSION = 6;
export const JIT_ACTION_PAYLOAD_LENGTH = 36;
export const JIT_OWNER_ACTION_RECORD_VERSION = 7;
export const JIT_OWNER_ACTION_PAYLOAD_LENGTH = 52;
export const JIT_ADDRESS_SPACE_OFFSET = 6_315_256;
export const JIT_CONTEXT_LENGTH = 6_315_496;
export const JIT_CONTEXT_VERSION = 40;
export const JIT_EXIT_PERFORMANCE_BOUNDARY = 5;
export type CoreJitModuleExit = "continue" | "guard" | "budget" | "halted" | "fault" | "performance-overflow-boundary";

export function decodeJitModuleExit(value: unknown): CoreJitModuleExit {
  switch (value) {
    case 0: return "continue";
    case 1: return "guard";
    case 2: return "budget";
    case 3: return "halted";
    case 4: return "fault";
    case JIT_EXIT_PERFORMANCE_BOUNDARY: return "performance-overflow-boundary";
    default: throw fault("invalid JIT module exit");
  }
}

export function isJitGuardExit(value: number): boolean {
  const exit = decodeJitModuleExit(value);
  return exit === "guard" || exit === "performance-overflow-boundary";
}

/** Reads the exact committed prefix before completion clears pending state. */
export function decodeJitRetiredInstructions(bytes: Uint8Array): bigint {
  if (bytes.byteLength !== JIT_CONTEXT_LENGTH) throw fault("invalid JIT context length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x434a584f || view.getUint16(4, true) !== JIT_CONTEXT_VERSION
    || view.getUint16(6, true) !== 0 || view.getUint32(8, true) !== JIT_CONTEXT_LENGTH - 12) {
    throw fault("invalid JIT context header");
  }
  return view.getBigUint64(208, true);
}
export const JIT_PROFILE_MODULE_IDS_OFFSET = 2_644_960;
export const JIT_OPERATION_SAMPLE_COUNT_OFFSET = 3_169_248;
export const JIT_OPERATION_SAMPLE_TOTAL_OFFSET = 3_169_256;
export const JIT_OPERATION_SAMPLE_DROPPED_OFFSET = 3_169_264;
export const JIT_OPERATION_SAMPLES_OFFSET = 3_169_272;
export const JIT_OPERATION_SAMPLE_ENTRIES = 4_096;
export const JIT_OPERATION_SAMPLE_ENTRY_LENGTH = 16;
export const JIT_OPERATION_SAMPLE_PERIOD = 65_536;
export const JIT_EDGE_SAMPLE_PERIOD = 1_048_576;
export const JIT_EDGE_SAMPLE_TOTAL_OFFSET = 5_856_248;
export const JIT_EDGE_SAMPLE_DROPPED_OFFSET = 5_856_256;
export const JIT_DISPATCH_SLOT_GENERATIONS_OFFSET = 5_856_360;
export const JIT_TRACE_RECORD_COUNT_OFFSET = 6_118_504;
export const JIT_TRACE_RECORD_DROPPED_OFFSET = 6_118_508;
export const JIT_TRACE_RECORD_TOTAL_OFFSET = 6_118_512;
export const JIT_TRACE_RECORDS_OFFSET = 6_118_520;
export const JIT_TRACE_RECORD_ENTRIES = 4_096;
export const JIT_TRACE_RECORD_ENTRY_LENGTH = 48;

/** Explicit wire codes; array positions carry no identity. */
export const JIT_INTERPRET_REASONS = [
  [1, "machine-not-jit-capable"],
  [2, "execution-budget"],
  [3, "halted"],
  [4, "partial-budget"],
  [5, "missing-code-identity"],
  [6, "cold-admission"],
  [7, "unsupported-semantic"],
  [8, "unsupported-form"],
  [9, "unsupported-context"],
  [10, "decode-or-translation-fault"],
  [11, "quarantined-semantic"],
  [12, "emission-failure"],
  [13, "module-size-limit"],
  [14, "candidate-limit"],
  [15, "performance-overflow-boundary"],
  [16, "pending-virtual-interrupt"],
  [17, "compile-pending"],
  [18, "code-page-fault"],
] as const;

export type CoreJitInterpretReason = typeof JIT_INTERPRET_REASONS[number][1];

export function jitInterpretReason(
  value: number,
): CoreJitInterpretReason | null {
  return JIT_INTERPRET_REASONS.find(([code]) => code === value)?.[1] ?? null;
}

export function jitInterpretReasonName(value: unknown): CoreJitInterpretReason | null {
  return JIT_INTERPRET_REASONS.find(([, reason]) => reason === value)?.[1] ?? null;
}

export type CoreJitAction =
  | {
      readonly kind: "compile";
      readonly instructionCount: number;
      readonly startRip: bigint;
      readonly cacheKey: bigint;
      readonly moduleLength: number;
      readonly artifactCacheKey: bigint;
      readonly artifactModuleLength: number;
      readonly contextLength: number;
      readonly maximumInstructions: number;
    }
  | {
      readonly kind: "install";
      readonly instructionCount: number;
      readonly startRip: bigint;
      readonly cacheKey: bigint;
      readonly moduleLength: number;
      readonly artifactCacheKey: bigint;
      readonly artifactModuleLength: number;
      readonly contextLength: number;
      readonly maximumInstructions: number;
    }
  | {
      readonly kind: "interpreted-result";
      readonly instructionCount: number;
      readonly startRip: bigint;
      readonly maximumInstructions: number;
      readonly reason: CoreJitInterpretReason;
    };

export function decodeJitAction(bytes: Uint8Array): CoreJitAction {
  const { cursor, owner } = jitActionPayload(bytes);
  const kind = cursor.u8();
  const interpretReason = cursor.u8();
  cursor.zero(2, "JIT action reserved field");
  const instructionCount = cursor.u32();
  const startRip = cursor.u64();
  const cacheKey = cursor.u64();
  const moduleLength = cursor.u32();
  const contextLength = cursor.u32();
  const maximumInstructions = cursor.u32();
  const artifactCacheKey = owner ? cursor.u64() : cacheKey;
  const artifactModuleLength = owner ? cursor.u32() : moduleLength;
  if (owner) cursor.zero(4, "owner JIT action reserved field");
  cursor.finish("JIT action");

  if (kind === 0 || kind === 2) {
    const releasedOrAotArtifact = moduleLength === 0
      && artifactCacheKey === cacheKey
      && artifactModuleLength === 0;
    if (
      instructionCount === 0 ||
      contextLength !== JIT_CONTEXT_LENGTH ||
      maximumInstructions === 0 ||
      interpretReason !== 0 ||
      (!releasedOrAotArtifact && (
        moduleLength === 0
        || artifactCacheKey === 0n
        || artifactModuleLength === 0
        || artifactModuleLength > moduleLength
      ))
    ) {
      throw fault(
        `JIT ${kind === 0 ? "compile" : "install"} action has invalid fields: instructionCount=${instructionCount}, moduleLength=${moduleLength}, contextLength=${contextLength}, expectedContextLength=${JIT_CONTEXT_LENGTH}, maximumInstructions=${maximumInstructions}, interpretReason=${interpretReason}`,
      );
    }
    return {
      kind: kind === 0 ? "compile" : "install",
      instructionCount,
      startRip,
      cacheKey,
      moduleLength,
      artifactCacheKey,
      artifactModuleLength,
      contextLength,
      maximumInstructions,
    };
  }
  if (kind === 1) {
    if (
      instructionCount > maximumInstructions ||
      cacheKey !== 0n ||
      moduleLength !== 0 ||
      contextLength !== 0 ||
      maximumInstructions === 0
      || artifactCacheKey !== 0n
      || artifactModuleLength !== 0
    ) {
      throw fault("JIT interpreted-result action has unexpected data");
    }
    const reason = jitInterpretReason(interpretReason);
    if (reason === null) {
      throw fault("JIT interpreted-result action has an invalid reason");
    }
    return {
      kind: "interpreted-result",
      instructionCount,
      startRip,
      maximumInstructions,
      reason,
    };
  }
  throw fault(`unknown JIT action ${kind}`);
}

function jitActionPayload(
  bytes: Uint8Array,
): { readonly cursor: BinaryCursor; readonly owner: boolean } {
  const header = new BinaryCursor(bytes);
  expectMagic(header, "OXJA");
  const version = header.u16();
  if (header.u16() !== 0) {
    throw fault("OXJA record has a nonzero reserved header");
  }
  const owner = version === JIT_OWNER_ACTION_RECORD_VERSION;
  if (!owner && version !== JIT_ACTION_RECORD_VERSION) {
    throw fault("unsupported OXJA record version");
  }
  const payloadLength = owner
    ? JIT_OWNER_ACTION_PAYLOAD_LENGTH
    : JIT_ACTION_PAYLOAD_LENGTH;
  if (
    header.u32() !== payloadLength ||
    bytes.byteLength !== RECORD_HEADER_LENGTH + payloadLength
  ) {
    throw fault("OXJA record has an invalid length");
  }
  return { cursor: new BinaryCursor(bytes, RECORD_HEADER_LENGTH), owner };
}
