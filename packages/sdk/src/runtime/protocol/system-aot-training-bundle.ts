import { decodeCodeSegmentContext } from "./code-segment-context.js";
import { JIT_DISPATCH_TABLE_ENTRIES, JIT_REGION_MAX_INSTRUCTIONS } from "../jit-cache.js";
import type { SystemTraceJitModule } from "./system.js";
import {
  decodeJitAotTrainingSource,
  type JitAotTrainingEdge,
  type JitAotTrainingSource,
} from "./system-trace-jit-aot.js";
import type { JitRuntimeIdentity } from "./system-trace-jit.js";

const MAGIC = [0x4f, 0x58, 0x41, 0x54] as const;
const VERSION = 4;
const HEADER_BYTES = 24;
const RECORD_FIXED_BYTES = 88;
const RUNTIME_HEADER_BYTES = 32;
const LEGACY_RUNTIME_HEADER_BYTES = 16;
const RUNTIME_PAGE_BYTES = 32;
const SOURCE_HEADER_BYTES = 8;
const SOURCE_INSTRUCTION_BYTES = 48;
const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
const NULL_U64 = 0xffff_ffff_ffff_ffffn;

export interface SystemAotTrainingBundle {
  readonly version: 1 | 2 | 3 | 4;
  readonly droppedModules: number;
  readonly modules: readonly SystemTraceJitModule[];
}

export function encodeSystemAotTrainingBundle(
  modules: readonly SystemTraceJitModule[],
  droppedModules: number,
): Uint8Array<ArrayBuffer> {
  if (
    modules.length > JIT_DISPATCH_TABLE_ENTRIES
    || !Number.isSafeInteger(droppedModules)
    || droppedModules < 0
    || droppedModules > 0xffff_ffff
  ) throw new TypeError("invalid system AOT training bundle cardinality");
  let records = modules.map(module => ({ module, length: recordLength(module) }));
  let byteLength = HEADER_BYTES + records.reduce((total, record) => total + record.length, 0);
  if (byteLength > MAX_BUNDLE_BYTES) {
    records.sort((left, right) => {
      const tier = Number(right.module.tier === "tier2") - Number(left.module.tier === "tier2");
      if (tier !== 0) return tier;
      const retired = right.module.aotTraining.outerRetired - left.module.aotTraining.outerRetired;
      return retired > 0n ? 1 : retired < 0n ? -1
        : right.module.aotTraining.outerEntries - left.module.aotTraining.outerEntries
          || left.module.profileModuleId.localeCompare(right.module.profileModuleId);
    });
    byteLength = HEADER_BYTES;
    records = records.filter(record => {
      if (byteLength + record.length > MAX_BUNDLE_BYTES) return false;
      byteLength += record.length;
      return true;
    });
    droppedModules += modules.length - records.length;
    if (droppedModules > 0xffff_ffff) throw new TypeError("system AOT dropped modules overflow");
  }
  const bytes = new Uint8Array(byteLength);
  const output = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  output.setUint16(4, VERSION, true);
  output.setUint16(6, HEADER_BYTES, true);
  output.setUint32(8, records.length, true);
  output.setUint32(12, droppedModules, true);
  output.setBigUint64(16, BigInt(byteLength - HEADER_BYTES), true);
  let offset = HEADER_BYTES;
  records.forEach(({ module, length }) => {
    writeRecord(bytes, output, offset, length, module);
    offset += length;
  });
  return bytes;
}

export function validateSystemAotTrainingBundle(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError("system AOT training bundle must be bytes");
  readBundle(value, false);
  return value;
}

export function decodeSystemAotTrainingBundle(bytes: Uint8Array): SystemAotTrainingBundle {
  return readBundle(bytes, true);
}

function recordLength(module: SystemTraceJitModule): number {
  const runtimeBytes = module.runtimeIdentity === null
    ? 0
    : RUNTIME_HEADER_BYTES + module.runtimeIdentity.codePages.length * RUNTIME_PAGE_BYTES;
  const sourceBytes = module.aotTrainingSource === null
    ? 0
    : SOURCE_HEADER_BYTES + module.aotTrainingSource.instructions.length * SOURCE_INSTRUCTION_BYTES;
  if (
    module.runtimeIdentity !== null
    && (module.runtimeIdentity.codePages.length === 0 || module.runtimeIdentity.codePages.length > 8)
  ) throw new TypeError("invalid system AOT runtime page count");
  if (
    module.aotTrainingSource !== null
    && (module.aotTrainingSource.instructions.length === 0
      || module.aotTrainingSource.instructions.length > JIT_REGION_MAX_INSTRUCTIONS)
  ) throw new TypeError("invalid system AOT source instruction count");
  if (module.aotTrainingSource !== null
    && module.aotTrainingSource.version !== (module.tier === "tier1" ? 1 : 2)) {
    throw new TypeError("system AOT source version does not match its tier");
  }
  return RECORD_FIXED_BYTES + runtimeBytes + sourceBytes;
}

function writeRecord(
  bytes: Uint8Array,
  output: DataView,
  start: number,
  length: number,
  module: SystemTraceJitModule,
): void {
  if (!/^[0-9a-f]{16}$/u.test(module.profileModuleId)) throw new TypeError("invalid system AOT module identity");
  output.setUint32(start, length, true);
  output.setBigUint64(start + 4, BigInt(`0x${module.profileModuleId}`), true);
  writeU64(output, start + 12, module.cacheKey, "system AOT cache key");
  output.setUint8(start + 20, module.tier === "tier1" ? 1 : 2);
  output.setUint8(start + 21, (module.runtimeIdentity === null ? 0 : 1) | (module.aotTrainingSource === null ? 0 : 2));
  output.setUint16(start + 22, 0, true);
  writeNullableU64(output, start + 24, module.recordedProfileGeneration);
  const training = module.aotTraining;
  writeU32(output, start + 32, training.emissions, "system AOT emissions");
  output.setUint32(start + 36, 0, true);
  writeNumberU64(output, start + 40, training.emittedBytes, "system AOT emitted bytes");
  writeFinite(output, start + 48, training.compilationMilliseconds, "system AOT compilation time");
  writeFinite(output, start + 56, training.instantiationMilliseconds, "system AOT instantiation time");
  writeFinite(output, start + 64, training.installationMilliseconds, "system AOT installation time");
  writeNumberU64(output, start + 72, training.outerEntries, "system AOT outer entries");
  writeU64(output, start + 80, training.outerRetired, "system AOT retired instructions");
  let offset = start + RECORD_FIXED_BYTES;
  if (module.runtimeIdentity !== null) offset = writeRuntime(output, offset, module.runtimeIdentity);
  if (module.aotTrainingSource !== null) offset = writeSource(bytes, output, offset, module.aotTrainingSource);
  if (offset !== start + length) throw new TypeError("system AOT training record length diverged");
}

function writeRuntime(output: DataView, offset: number, runtime: JitRuntimeIdentity): number {
  output.setUint8(offset, encodeMode(runtime.mode));
  output.setUint8(offset + 1, runtime.cpl);
  output.setUint8(offset + 2, encodeProfile(runtime.profile));
  output.setUint8(offset + 3, runtime.addressSpaceScoped ? 1 : 0);
  output.setUint16(offset + 4, runtime.codeAttributes, true);
  output.setUint8(offset + 6, runtime.codePages.length);
  output.setUint8(offset + 7, runtime.capabilityRevision);
  writeNullableU64(output, offset + 8, runtime.addressSpaceId);
  const measured = runtime.codeSegmentBase !== null;
  const context = decodeCodeSegmentContext(runtime.codeSegmentBase, runtime.codeSegmentLimit, runtime.mode === "long", measured);
  writeU64(output, offset + 16, context.codeSegmentBase ?? 0n, "system AOT code-segment base");
  writeU32(output, offset + 24, context.codeSegmentLimit ?? 0, "system AOT code-segment limit");
  output.setUint32(offset + 28, measured ? 1 : 0, true);
  offset += RUNTIME_HEADER_BYTES;
  for (const page of runtime.codePages) {
    writeU64(output, offset, page.linear, "system AOT linear page");
    writeU64(output, offset + 8, page.physical, "system AOT physical page");
    writeU64(output, offset + 16, page.generation, "system AOT page generation");
    output.setBigUint64(offset + 24, page.globalSupervisor ? 1n : 0n, true);
    offset += RUNTIME_PAGE_BYTES;
  }
  return offset;
}

function writeSource(
  bytes: Uint8Array,
  output: DataView,
  offset: number,
  source: JitAotTrainingSource,
): number {
  output.setUint32(offset, source.version, true);
  output.setUint32(offset + 4, source.instructions.length, true);
  offset += SOURCE_HEADER_BYTES;
  for (const instruction of source.instructions) {
    writeU64(output, offset, instruction.rip, "system AOT instruction RIP");
    const instructionBytes = decodeHex(instruction.bytes);
    output.setUint8(offset + 8, instructionBytes.length);
    bytes.set(instructionBytes, offset + 9);
    output.setUint8(offset + 24, encodeEdgeKind(instruction.edge));
    output.setUint32(offset + 25, instruction.semantic, true);
    output.setUint16(offset + 29, instruction.instructionForm ?? 0xffff, true);
    output.setUint8(offset + 31, 0);
    const [target, continuation] = encodeEdgeTargets(instruction.edge);
    output.setBigUint64(offset + 32, target, true);
    output.setBigUint64(offset + 40, continuation, true);
    offset += SOURCE_INSTRUCTION_BYTES;
  }
  return offset;
}

function readBundle(bytes: Uint8Array, collect: boolean): SystemAotTrainingBundle {
  if (bytes.byteLength < HEADER_BYTES || bytes.byteLength > MAX_BUNDLE_BYTES) throw new TypeError("invalid system AOT training bundle length");
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (MAGIC.some((byte, index) => input.getUint8(index) !== byte)) throw new TypeError("invalid system AOT training bundle magic");
  const count = input.getUint32(8, true);
  const droppedModules = input.getUint32(12, true);
  const version = input.getUint16(4, true);
  if (
    (version !== 1 && version !== 2 && version !== 3 && version !== VERSION)
    || input.getUint16(6, true) !== HEADER_BYTES
    || count > JIT_DISPATCH_TABLE_ENTRIES
    || input.getBigUint64(16, true) !== BigInt(bytes.byteLength - HEADER_BYTES)
  ) throw new TypeError("invalid system AOT training bundle header");
  const modules: SystemTraceJitModule[] = [];
  const identities = new Set<string>();
  let offset = HEADER_BYTES;
  for (let index = 0; index < count; index += 1) {
    const decoded = readRecord(bytes, input, offset, version);
    if (version === 1 && decoded.module.aotTrainingSource?.version === 2) {
      throw new TypeError("legacy system AOT bundle cannot contain Tier-2 source");
    }
    if (identities.has(decoded.module.profileModuleId)) throw new TypeError("duplicate system AOT module identity");
    identities.add(decoded.module.profileModuleId);
    if (collect) modules.push(decoded.module);
    offset = decoded.next;
  }
  if (offset !== bytes.byteLength) throw new TypeError("system AOT training bundle has trailing bytes");
  return { version, droppedModules, modules };
}

function readRecord(
  bytes: Uint8Array,
  input: DataView,
  start: number,
  version: 1 | 2 | 3 | 4,
): { readonly module: SystemTraceJitModule; readonly next: number } {
  if (start + RECORD_FIXED_BYTES > bytes.byteLength) throw new TypeError("truncated system AOT training record");
  const length = input.getUint32(start, true);
  const next = start + length;
  if (length < RECORD_FIXED_BYTES || next > bytes.byteLength) throw new TypeError("invalid system AOT training record length");
  const flags = input.getUint8(start + 21);
  if (flags > 3 || input.getUint16(start + 22, true) !== 0 || input.getUint32(start + 36, true) !== 0) {
    throw new TypeError("invalid system AOT training record flags");
  }
  const rawTier = input.getUint8(start + 20);
  const tier = rawTier === 1 ? "tier1" : rawTier === 2 ? "tier2" : null;
  if (tier === null) throw new TypeError("invalid system AOT training tier");
  let offset = start + RECORD_FIXED_BYTES;
  const runtime = flags & 1 ? readRuntime(input, offset, next, version) : null;
  if (runtime !== null) offset = runtime.next;
  let source: JitAotTrainingSource | null = null;
  if (flags & 2) {
    if (offset + SOURCE_HEADER_BYTES > next) throw new TypeError("truncated system AOT training source");
    const count = input.getUint32(offset + 4, true);
    const length = SOURCE_HEADER_BYTES + count * SOURCE_INSTRUCTION_BYTES;
    if (count === 0 || count > JIT_REGION_MAX_INSTRUCTIONS || offset + length > next) {
      throw new TypeError("invalid system AOT training source length");
    }
    source = decodeJitAotTrainingSource(bytes.subarray(offset, offset + length));
    if (source.version !== (tier === "tier1" ? 1 : 2)) {
      throw new TypeError("system AOT source version does not match its tier");
    }
    offset += length;
  }
  if (offset !== next) throw new TypeError("system AOT training record has trailing bytes");
  const profileModuleId = input.getBigUint64(start + 4, true).toString(16).padStart(16, "0");
  const recorded = input.getBigUint64(start + 24, true);
  const instructions = source?.instructions.map((instruction) => ({
    rip: instruction.rip,
    semantic: instruction.semantic,
    retired: 1,
    instructionForm: instruction.instructionForm,
  })) ?? [];
  return {
    next,
    module: {
      profileModuleId,
      cacheKey: input.getBigUint64(start + 12, true),
      tier,
      recordedProfileGeneration: recorded === NULL_U64 ? null : recorded,
      runtimeIdentity: runtime?.identity ?? null,
      aotTrainingSource: source,
      aotTraining: {
        emissions: input.getUint32(start + 32, true),
        emittedBytes: readSafeNumber(input.getBigUint64(start + 40, true), "system AOT emitted bytes"),
        compilationMilliseconds: readFinite(input.getFloat64(start + 48, true), "system AOT compilation time"),
        instantiationMilliseconds: readFinite(input.getFloat64(start + 56, true), "system AOT instantiation time"),
        installationMilliseconds: readFinite(input.getFloat64(start + 64, true), "system AOT installation time"),
        outerEntries: readSafeNumber(input.getBigUint64(start + 72, true), "system AOT outer entries"),
        outerRetired: input.getBigUint64(start + 80, true),
      },
      instructions,
      operations: [],
      plan: { initialStateMask: 0n, dirtyStateMask: 0n, stateMaterializationBoundaries: 0, segmentGuards: 0 },
    },
  };
}

function readRuntime(
  input: DataView,
  offset: number,
  end: number,
  version: 1 | 2 | 3 | 4,
): { readonly identity: JitRuntimeIdentity; readonly next: number } {
  const runtimeHeaderBytes = version >= 4 ? RUNTIME_HEADER_BYTES : LEGACY_RUNTIME_HEADER_BYTES;
  if (offset + runtimeHeaderBytes > end) throw new TypeError("truncated system AOT runtime identity");
  const pageCount = input.getUint8(offset + 6);
  const next = offset + runtimeHeaderBytes + pageCount * RUNTIME_PAGE_BYTES;
  const flags = input.getUint8(offset + 3);
  if (pageCount === 0 || pageCount > 8 || flags > 1 || input.getUint8(offset + 7) > (version >= 3 ? 1 : 0) || next > end) {
    throw new TypeError("invalid system AOT runtime identity");
  }
  const availability = version >= 4 ? input.getUint32(offset + 28, true) : 0;
  if (availability > 1 || version >= 4 && availability === 0 && (input.getBigUint64(offset + 16, true) !== 0n || input.getUint32(offset + 24, true) !== 0)) {
    throw new TypeError("invalid system AOT code-segment identity");
  }
  const rawAddressSpace = input.getBigUint64(offset + 8, true);
  const codePages = Array.from({ length: pageCount }, (_, index) => {
    const page = offset + runtimeHeaderBytes + index * RUNTIME_PAGE_BYTES;
    const reserved = input.getBigUint64(page + 24, true);
    const linear = input.getBigUint64(page, true);
    const physical = input.getBigUint64(page + 8, true);
    if (reserved > 1n || ((linear | physical) & 0xfffn) !== 0n) throw new TypeError("invalid system AOT runtime page");
    return {
      linear,
      physical,
      generation: input.getBigUint64(page + 16, true),
      globalSupervisor: reserved === 1n,
    };
  });
  return {
    next,
    identity: {
      mode: decodeMode(input.getUint8(offset)),
      cpl: decodeCpl(input.getUint8(offset + 1)),
      profile: decodeProfile(input.getUint8(offset + 2)),
      codeAttributes: input.getUint16(offset + 4, true),
      ...decodeCodeSegmentContext(availability === 1 ? input.getBigUint64(offset + 16, true) : null, availability === 1 ? input.getUint32(offset + 24, true) : null, input.getUint8(offset) === 3, availability === 1),
      capabilityRevision: version >= 3 && input.getUint8(offset + 7) === 1 ? 1 : 0,
      addressSpaceId: rawAddressSpace === NULL_U64 ? null : rawAddressSpace,
      addressSpaceScoped: flags === 1,
      codePages,
    },
  };
}

function encodeMode(value: JitRuntimeIdentity["mode"]): number {
  return value === "real" ? 0 : value === "protected" ? 1 : value === "compatibility" ? 2 : 3;
}

function decodeMode(value: number): JitRuntimeIdentity["mode"] {
  if (value === 0) return "real";
  if (value === 1) return "protected";
  if (value === 2) return "compatibility";
  if (value === 3) return "long";
  throw new TypeError("invalid system AOT runtime mode");
}

function encodeProfile(value: JitRuntimeIdentity["profile"]): number {
  return value === "baseline" ? 0 : value === "x86-64-v2" ? 1 : 2;
}

function decodeProfile(value: number): JitRuntimeIdentity["profile"] {
  if (value === 0) return "baseline";
  if (value === 1) return "x86-64-v2";
  if (value === 2) return "x86-64-v3";
  throw new TypeError("invalid system AOT runtime profile");
}

function decodeCpl(value: number): JitRuntimeIdentity["cpl"] {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  throw new TypeError("invalid system AOT runtime CPL");
}

function encodeEdgeKind(edge: JitAotTrainingEdge): number {
  return edge.kind === "fallthrough" ? 0
    : edge.kind === "direct" ? 1
      : edge.kind === "call" ? 2
        : edge.kind === "guarded-indirect" ? 3
          : edge.kind === "branch" ? 4
            : edge.kind === "indirect" ? 5
              : 6;
}

function encodeEdgeTargets(edge: JitAotTrainingEdge): readonly [bigint, bigint] {
  switch (edge.kind) {
    case "fallthrough":
    case "direct": return [edge.target, 0n];
    case "call": return [edge.target, edge.continuation];
    case "guarded-indirect": return [edge.target, edge.continuation ?? NULL_U64];
    case "branch": return [edge.taken, edge.fallthrough];
    case "indirect":
    case "exit": return [0n, 0n];
  }
}

function decodeHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2}){1,15}$/u.test(value)) throw new TypeError("invalid system AOT instruction bytes");
  return Uint8Array.from({ length: value.length / 2 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

function writeFinite(output: DataView, offset: number, value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`invalid ${name}`);
  output.setFloat64(offset, value, true);
}

function readFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`invalid ${name}`);
  return value;
}

function writeU32(output: DataView, offset: number, value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new TypeError(`invalid ${name}`);
  output.setUint32(offset, value, true);
}

function writeNumberU64(output: DataView, offset: number, value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid ${name}`);
  output.setBigUint64(offset, BigInt(value), true);
}

function writeNullableU64(output: DataView, offset: number, value: bigint | null): void {
  if (value === null) output.setBigUint64(offset, NULL_U64, true);
  else writeU64(output, offset, value, "system AOT optional u64");
}

function writeU64(output: DataView, offset: number, value: bigint, name: string): void {
  if (value < 0n || value >= NULL_U64) throw new TypeError(`invalid ${name}`);
  output.setBigUint64(offset, value, true);
}

function readSafeNumber(value: bigint, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${name} exceeds the safe integer bound`);
  return number;
}
