import { fault } from "./cursor.ts";

const HEADER_LENGTH = 64;
const SOURCE_LENGTH = 40;
const PACK_LENGTH = 48;
const MEMBER_LENGTH = 64;
const SPAN_LENGTH = 48;
const MAX_INDEX_BYTES = 128 * 1024 * 1024;
const MAX_SOURCES = 4_096;
const MAX_PACKS = 64;
const MAX_MEMBERS = MAX_PACKS * 256;
const MAX_SPANS = MAX_MEMBERS * 128;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const NO_TARGET = U64_MAX - 1n;
const SOURCE_ANCHOR_LENGTH = 64;

export type AotIndexPhase = "command" | "ready" | "first-request" | "warm-request" | "rebuild";

export interface AotIndexSpan {
  readonly imageOffset: bigint;
  readonly fileOffset: bigint;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly blockIndex: number;
  readonly semantic: number;
  readonly instructionForm: number;
  readonly edgeKind: number;
  readonly target: bigint;
  readonly continuation: bigint;
}

export interface AotIndexMember {
  readonly sourceIndex: number;
  readonly packIndex: number;
  readonly packMemberIndex: number;
  readonly codeAttributes: number;
  readonly capabilityRevision: 0 | 1;
  readonly entryOffset: bigint;
  readonly fingerprint: bigint;
  readonly instructionCount: number;
  readonly profileModuleId: bigint;
  readonly spans: readonly AotIndexSpan[];
}

export interface AotIndexPack {
  readonly sha256: string;
  readonly sourceIndex: number;
  readonly phase: AotIndexPhase;
  readonly memberStart: number;
  readonly memberCount: number;
  readonly byteLength: number;
}

export interface DecodedAotIndex {
  readonly sources: readonly string[];
  readonly packs: readonly AotIndexPack[];
  readonly members: readonly AotIndexMember[];
}

interface RawMember extends Omit<AotIndexMember, "spans"> {
  readonly spanStart: number;
  readonly spanCount: number;
}

export function decodeAotIndex(bytes: Uint8Array): DecodedAotIndex {
  if (bytes.byteLength < HEADER_LENGTH || bytes.byteLength > MAX_INDEX_BYTES) throw invalid("length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (text(bytes.subarray(0, 4)) !== "OXAI") throw invalid("magic");
  if (![1, 2].includes(view.getUint16(4, true)) || view.getUint16(6, true) !== HEADER_LENGTH) throw invalid("version");
  if (view.getUint32(8, true) !== bytes.byteLength) throw invalid("length");
  if (bytes.subarray(48, 64).some((byte) => byte !== 0)) throw invalid("reserved header");
  const sourceCount = view.getUint16(12, true);
  const packCount = view.getUint16(14, true);
  const memberCount = view.getUint32(16, true);
  const spanCount = view.getUint32(20, true);
  const byteCount = view.getUint32(24, true);
  if (
    sourceCount < 1 || sourceCount > MAX_SOURCES
    || packCount < 1 || packCount > MAX_PACKS
    || memberCount < 1 || memberCount > MAX_MEMBERS
    || spanCount < 1 || spanCount > MAX_SPANS
  ) throw invalid("table bounds");
  const sourcesOffset = view.getUint32(28, true);
  const packsOffset = view.getUint32(32, true);
  const membersOffset = view.getUint32(36, true);
  const spansOffset = view.getUint32(40, true);
  const dataOffset = view.getUint32(44, true);
  const expectedPacks = checkedEnd(HEADER_LENGTH, sourceCount, SOURCE_LENGTH);
  const expectedMembers = checkedEnd(expectedPacks, packCount, PACK_LENGTH);
  const expectedSpans = checkedEnd(expectedMembers, memberCount, MEMBER_LENGTH);
  const expectedData = checkedEnd(expectedSpans, spanCount, SPAN_LENGTH);
  if (
    sourcesOffset !== HEADER_LENGTH || packsOffset !== expectedPacks
    || membersOffset !== expectedMembers || spansOffset !== expectedSpans
    || dataOffset !== expectedData || dataOffset + byteCount !== bytes.byteLength
  ) throw invalid("table layout");

  const sources = decodeSources(
    bytes,
    view,
    sourcesOffset,
    sourceCount,
    dataOffset,
    byteCount,
  );
  const packs = decodePacks(bytes, view, packsOffset, packCount, sources.length, memberCount);
  const rawMembers = decodeMembers(bytes, view, membersOffset, memberCount, sources.length, packs.length, spanCount);
  const spans = decodeSpans(
    bytes,
    view,
    spansOffset,
    spanCount,
    dataOffset,
    byteCount,
    sourceCount * SOURCE_ANCHOR_LENGTH,
  );
  const expectedPackMembers = new Uint16Array(packs.length);
  const members = rawMembers.map((member, index) => {
    const pack = packs[member.packIndex];
    if (
      pack === undefined || member.sourceIndex !== pack.sourceIndex
      || index < pack.memberStart || index >= pack.memberStart + pack.memberCount
      || member.packMemberIndex !== expectedPackMembers[member.packIndex]
    ) throw invalid("member-to-pack identity");
    expectedPackMembers[member.packIndex] = (expectedPackMembers[member.packIndex] ?? 0) + 1;
    const memberSpans = spans.slice(member.spanStart, member.spanStart + member.spanCount);
    validateMemberSpans(member, memberSpans);
    const { spanStart: _spanStart, spanCount: _spanCount, ...identity } = member;
    void _spanStart;
    void _spanCount;
    return { ...identity, spans: memberSpans };
  });
  if (packs.some((pack, index) => expectedPackMembers[index] !== pack.memberCount)) {
    throw invalid("pack member coverage");
  }
  return { sources, packs, members };
}

function decodeSources(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  count: number,
  dataOffset: number,
  dataLength: number,
): string[] {
  const sources: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = offset + index * SOURCE_LENGTH;
    const digest = hex(bytes.subarray(start, start + 32));
    const previous = sources.at(-1);
    if (previous !== undefined && digest <= previous) throw invalid("source ordering");
    const anchorOffset = view.getUint32(start + 32, true);
    const anchorLength = view.getUint16(start + 36, true);
    if (
      anchorOffset !== index * SOURCE_ANCHOR_LENGTH
      || anchorLength !== SOURCE_ANCHOR_LENGTH
      || view.getUint16(start + 38, true) !== 1
      || anchorOffset + anchorLength > dataLength
      || text(bytes.subarray(dataOffset + anchorOffset, dataOffset + anchorOffset + 4)) !== "\x7fELF"
    ) throw invalid("source anchor");
    sources.push(digest);
  }
  return sources;
}

function decodePacks(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  count: number,
  sourceCount: number,
  totalMembers: number,
): AotIndexPack[] {
  const packs: AotIndexPack[] = [];
  let aggregateBytes = 0;
  for (let index = 0; index < count; index += 1) {
    const start = offset + index * PACK_LENGTH;
    const sha256 = hex(bytes.subarray(start, start + 32));
    const previous = packs.at(-1);
    if (previous !== undefined && sha256 <= previous.sha256) throw invalid("pack ordering");
    const sourceIndex = view.getUint16(start + 32, true);
    const phase = phaseAt(view.getUint8(start + 34));
    const memberStart = view.getUint32(start + 36, true);
    const memberCount = view.getUint16(start + 40, true);
    const byteLength = view.getUint32(start + 44, true);
    if (
      sourceIndex >= sourceCount || view.getUint8(start + 35) !== 0
      || view.getUint16(start + 42, true) !== 0 || memberCount < 1
      || memberStart + memberCount > totalMembers || byteLength < 1
      || byteLength > 4 * 1024 * 1024
    ) throw invalid("pack record");
    aggregateBytes += byteLength;
    if (aggregateBytes > MAX_INDEX_BYTES) throw invalid("pack byte bound");
    packs.push({ sha256, sourceIndex, phase, memberStart, memberCount, byteLength });
  }
  return packs;
}

function decodeMembers(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  count: number,
  sourceCount: number,
  packCount: number,
  totalSpans: number,
): RawMember[] {
  const members: RawMember[] = [];
  let previous: readonly [number, bigint] | undefined;
  for (let index = 0; index < count; index += 1) {
    const start = offset + index * MEMBER_LENGTH;
    const sourceIndex = view.getUint16(start, true);
    const packIndex = view.getUint16(start + 2, true);
    const packMemberIndex = view.getUint16(start + 4, true);
    const entryOffset = view.getBigUint64(start + 12, true);
    const capabilityRevision = view.getUint8(start + 7);
    if (capabilityRevision > 1 || view.getUint16(4, true) === 1 && capabilityRevision !== 0) {
      throw invalid("capability revision");
    }
    const instructionCount = view.getUint16(start + 28, true);
    const spanCount = view.getUint16(start + 30, true);
    const spanStart = view.getUint32(start + 32, true);
    if (
      sourceIndex >= sourceCount || packIndex >= packCount
      || view.getUint8(start + 6) !== 3
      || instructionCount < 1 || instructionCount > 128
      || spanCount !== instructionCount || spanStart + spanCount > totalSpans
      || bytes.subarray(start + 44, start + MEMBER_LENGTH).some((byte) => byte !== 0)
      || previous !== undefined && (sourceIndex < previous[0]
        || sourceIndex === previous[0] && entryOffset <= previous[1])
    ) throw invalid("member record");
    members.push({
      sourceIndex,
      packIndex,
      packMemberIndex,
      codeAttributes: view.getUint32(start + 8, true),
      capabilityRevision: capabilityRevision === 1 ? 1 : 0,
      entryOffset,
      fingerprint: view.getBigUint64(start + 20, true),
      instructionCount,
      spanStart,
      spanCount,
      profileModuleId: view.getBigUint64(start + 36, true),
    });
    previous = [sourceIndex, entryOffset];
  }
  return members;
}

function decodeSpans(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  count: number,
  dataOffset: number,
  dataLength: number,
  minimumDataStart: number,
): AotIndexSpan[] {
  return Array.from({ length: count }, (_, index) => {
    const start = offset + index * SPAN_LENGTH;
    const dataStart = view.getUint32(start + 8, true);
    const byteLength = view.getUint16(start + 12, true);
    const edgeKind = view.getUint8(start + 22);
    const target = view.getBigUint64(start + 24, true);
    const continuation = view.getBigUint64(start + 32, true);
    if (
      dataStart < minimumDataStart || byteLength < 1 || byteLength > 15
      || dataStart + byteLength > dataLength
      || view.getUint8(start + 23) !== 0 || !validEdge(edgeKind, target, continuation)
    ) throw invalid("span record");
    return {
      imageOffset: view.getBigUint64(start, true),
      fileOffset: view.getBigUint64(start + 40, true),
      bytes: bytes.slice(dataOffset + dataStart, dataOffset + dataStart + byteLength),
      blockIndex: view.getUint16(start + 14, true),
      semantic: view.getUint32(start + 16, true),
      instructionForm: view.getUint16(start + 20, true),
      edgeKind,
      target,
      continuation,
    };
  });
}

function validateMemberSpans(member: RawMember, spans: readonly AotIndexSpan[]): void {
  if (spans[0]?.imageOffset !== member.entryOffset) throw invalid("member entry span");
  const ranges: { readonly start: bigint; readonly end: bigint }[] = [];
  const fingerprint: number[] = [];
  let previousBlock = 0;
  for (const [index, span] of spans.entries()) {
    if (index === 0 ? span.blockIndex !== 0 : span.blockIndex < previousBlock) throw invalid("span block ordering");
    previousBlock = span.blockIndex;
    const end = span.imageOffset + BigInt(span.bytes.byteLength);
    if (end > U64_MAX) throw invalid("span address overflow");
    ranges.push({ start: span.imageOffset, end });
    fingerprint.push(...span.bytes.subarray(0, Math.max(0, 32 - fingerprint.length)));
  }
  ranges.sort((left, right) => left.start < right.start ? -1 : left.start > right.start ? 1 : 0);
  if (ranges.some((range, index) => {
    const previous = index === 0 ? undefined : ranges[index - 1];
    return previous !== undefined && previous.end > range.start;
  })) throw invalid("overlapping spans");
  if (fnv1a64(fingerprint) !== member.fingerprint) throw invalid("entry fingerprint");
}

function validEdge(kind: number, target: bigint, continuation: bigint): boolean {
  if ((kind === 0 || kind === 1) && continuation === 0n) return true;
  if (kind === 2 || kind === 4) return true;
  if (kind === 3) return continuation === NO_TARGET || continuation <= U64_MAX;
  return (kind === 5 || kind === 6) && target === 0n && continuation === 0n;
}

function phaseAt(value: number): AotIndexPhase {
  const phase = ["command", "ready", "first-request", "warm-request", "rebuild"] as const;
  const decoded = phase[value];
  if (decoded === undefined) throw invalid("pack phase");
  return decoded;
}

function fnv1a64(bytes: readonly number[]): bigint {
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x0000_0100_0000_01b3n);
  return hash;
}

function checkedEnd(start: number, count: number, length: number): number {
  const end = start + count * length;
  if (!Number.isSafeInteger(end) || end > MAX_INDEX_BYTES) throw invalid("table overflow");
  return end;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function text(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function invalid(field: string): ReturnType<typeof fault> {
  return fault(`AOT index has invalid ${field}`);
}
