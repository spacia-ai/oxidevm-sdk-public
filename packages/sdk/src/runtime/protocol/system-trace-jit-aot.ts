import { JIT_REGION_MAX_INSTRUCTIONS } from "../jit-cache.js";
import { exactKeys, integer, record, string } from "../decode.js";
import { nonnegativeBigint } from "./decoders.js";

const AOT_TRAINING_HEADER_BYTES = 8;
const AOT_TRAINING_ENTRY_BYTES = 48;
const AOT_TRAINING_NO_TARGET = 0xffff_ffff_ffff_ffffn;

export type JitAotTrainingEdge =
  | { readonly kind: "fallthrough"; readonly target: bigint }
  | { readonly kind: "direct"; readonly target: bigint }
  | { readonly kind: "call"; readonly target: bigint; readonly continuation: bigint }
  | { readonly kind: "guarded-indirect"; readonly target: bigint; readonly continuation: bigint | null }
  | { readonly kind: "branch"; readonly taken: bigint; readonly fallthrough: bigint }
  | { readonly kind: "indirect" }
  | { readonly kind: "exit" };

export interface JitAotTrainingInstruction {
  readonly rip: bigint;
  readonly bytes: string;
  readonly semantic: number;
  readonly instructionForm: number | null;
  readonly edge: JitAotTrainingEdge;
}

export interface JitAotTrainingSource {
  /** Version 1 is Tier-1 AOT input; version 2 is exact Tier-2 diagnostic source. */
  readonly version: 1 | 2;
  readonly instructions: readonly JitAotTrainingInstruction[];
}

export interface JitAotTrainingStats {
  readonly emissions: number;
  readonly emittedBytes: number;
  readonly compilationMilliseconds: number;
  readonly instantiationMilliseconds: number;
  readonly installationMilliseconds: number;
  readonly outerEntries: number;
  readonly outerRetired: bigint;
}

export const EMPTY_JIT_AOT_TRAINING_STATS: JitAotTrainingStats = {
  emissions: 0,
  emittedBytes: 0,
  compilationMilliseconds: 0,
  instantiationMilliseconds: 0,
  installationMilliseconds: 0,
  outerEntries: 0,
  outerRetired: 0n,
};

export function decodeJitAotTrainingSource(
  bytes: Uint8Array,
): JitAotTrainingSource {
  if (bytes.byteLength < AOT_TRAINING_HEADER_BYTES) {
    throw new TypeError("invalid JIT AOT training source");
  }
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = input.getUint32(0, true);
  const count = input.getUint32(4, true);
  if (
    (version !== 1 && version !== 2)
    || count === 0
    || count > JIT_REGION_MAX_INSTRUCTIONS
    || bytes.byteLength !== AOT_TRAINING_HEADER_BYTES + count * AOT_TRAINING_ENTRY_BYTES
  ) {
    throw new TypeError("invalid JIT AOT training source header");
  }
  const seenRips = new Set<bigint>();
  const instructions = Array.from({ length: count }, (_, index) => {
    const offset = AOT_TRAINING_HEADER_BYTES + index * AOT_TRAINING_ENTRY_BYTES;
    const rip = input.getBigUint64(offset, true);
    const length = input.getUint8(offset + 8);
    if (length === 0 || length > 15 || seenRips.has(rip)) {
      throw new TypeError("invalid JIT AOT training instruction identity");
    }
    seenRips.add(rip);
    for (let byte = length; byte < 15; byte += 1) {
      if (input.getUint8(offset + 9 + byte) !== 0) {
        throw new TypeError("invalid JIT AOT training instruction padding");
      }
    }
    if (input.getUint8(offset + 31) !== 0) {
      throw new TypeError("invalid JIT AOT training edge reserved byte");
    }
    const target = input.getBigUint64(offset + 32, true);
    const continuation = input.getBigUint64(offset + 40, true);
    return {
      rip,
      bytes: toHex(bytes.subarray(offset + 9, offset + 9 + length)),
      semantic: input.getUint32(offset + 25, true),
      instructionForm: readInstructionForm(input.getUint16(offset + 29, true)),
      edge: decodeEdge(input.getUint8(offset + 24), target, continuation),
    };
  });
  return { version, instructions };
}

export function decodeJitAotTrainingSourceRecord(
  value: unknown,
): JitAotTrainingSource {
  const source = record(value, "JIT AOT training source");
  exactKeys(source, ["version", "instructions"]);
  const version = integer(source["version"], "JIT AOT training version", 1, 2);
  if (version !== 1 && version !== 2) {
    throw new TypeError("invalid JIT AOT training version");
  }
  if (
    !Array.isArray(source["instructions"])
    || source["instructions"].length === 0
    || source["instructions"].length > JIT_REGION_MAX_INSTRUCTIONS
  ) {
    throw new TypeError("invalid JIT AOT training instructions");
  }
  const seenRips = new Set<bigint>();
  const instructions = source["instructions"].map((value: unknown) => {
    const instruction = record(value, "JIT AOT training instruction");
    exactKeys(instruction, ["rip", "bytes", "semantic", "instructionForm", "edge"]);
    const rip = nonnegativeBigint(instruction["rip"], "JIT AOT training RIP");
    const bytes = string(instruction["bytes"], "JIT AOT training bytes");
    if (!/^(?:[0-9a-f]{2}){1,15}$/u.test(bytes) || seenRips.has(rip)) {
      throw new TypeError("invalid JIT AOT training instruction");
    }
    seenRips.add(rip);
    const instructionForm = instruction["instructionForm"] === null
      ? null
      : integer(instruction["instructionForm"], "JIT AOT training instruction form", 0, 0xfffe);
    return {
      rip,
      bytes,
      semantic: integer(instruction["semantic"], "JIT AOT training semantic", 0, 0xffff_ffff),
      instructionForm,
      edge: decodeEdgeRecord(instruction["edge"]),
    };
  });
  return { version, instructions };
}

function readInstructionForm(value: number): number | null {
  return value === 0xffff ? null : value;
}

function decodeEdge(
  kind: number,
  target: bigint,
  continuation: bigint,
): JitAotTrainingEdge {
  switch (kind) {
    case 0:
      requireZero(continuation);
      return { kind: "fallthrough", target };
    case 1:
      requireZero(continuation);
      return { kind: "direct", target };
    case 2:
      return { kind: "call", target, continuation };
    case 3:
      return {
        kind: "guarded-indirect",
        target,
        continuation: continuation === AOT_TRAINING_NO_TARGET ? null : continuation,
      };
    case 4:
      return { kind: "branch", taken: target, fallthrough: continuation };
    case 5:
      requireZero(target | continuation);
      return { kind: "indirect" };
    case 6:
      requireZero(target | continuation);
      return { kind: "exit" };
    default:
      throw new TypeError("invalid JIT AOT training edge kind");
  }
}

function requireZero(value: bigint): void {
  if (value !== 0n) throw new TypeError("invalid JIT AOT training edge payload");
}

function decodeEdgeRecord(value: unknown): JitAotTrainingEdge {
  const edge = record(value, "JIT AOT training edge");
  const kind = string(edge["kind"], "JIT AOT training edge kind");
  switch (kind) {
    case "fallthrough":
    case "direct":
      exactKeys(edge, ["kind", "target"]);
      return { kind, target: nonnegativeBigint(edge["target"], "JIT AOT edge target") };
    case "call":
      exactKeys(edge, ["kind", "target", "continuation"]);
      return { kind, target: nonnegativeBigint(edge["target"], "JIT AOT call target"), continuation: nonnegativeBigint(edge["continuation"], "JIT AOT call continuation") };
    case "guarded-indirect":
      exactKeys(edge, ["kind", "target", "continuation"]);
      return { kind, target: nonnegativeBigint(edge["target"], "JIT AOT guarded target"), continuation: edge["continuation"] === null ? null : nonnegativeBigint(edge["continuation"], "JIT AOT guarded continuation") };
    case "branch":
      exactKeys(edge, ["kind", "taken", "fallthrough"]);
      return { kind, taken: nonnegativeBigint(edge["taken"], "JIT AOT branch target"), fallthrough: nonnegativeBigint(edge["fallthrough"], "JIT AOT branch fallthrough") };
    case "indirect":
    case "exit":
      exactKeys(edge, ["kind"]);
      return { kind };
    default:
      throw new TypeError("invalid JIT AOT training edge kind");
  }
}

function toHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}
