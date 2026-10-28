import { fault } from "./cursor.ts";

const OXAP_HEADER_LENGTH = 112;
const OXAP_CODE_PAGE_LENGTH = 32;
const OXAP_MAX_CODE_PAGES = 3;

export interface CorePendingAotCodePage {
  readonly linear: bigint;
  readonly physical: bigint;
  readonly generation: bigint;
  readonly globalSupervisor: boolean;
}

export interface CorePendingAot {
  readonly generation: bigint;
  readonly token: readonly [bigint, bigint];
  readonly cacheKey: bigint;
  readonly imageBase: bigint;
  readonly packSha256: string;
  readonly packByteLength: number;
  readonly packMemberIndex: number;
  readonly instructionCount: number;
  readonly memberEntryOffset: bigint;
  readonly startRip: bigint;
  readonly codePages: readonly CorePendingAotCodePage[];
}

export function decodeCorePendingAot(bytes: Uint8Array): CorePendingAot {
  if (bytes.byteLength < OXAP_HEADER_LENGTH) throw invalid("length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint8(0) !== 0x4f
    || view.getUint8(1) !== 0x58
    || view.getUint8(2) !== 0x41
    || view.getUint8(3) !== 0x50
  ) throw invalid("magic");
  if (view.getUint16(4, true) !== 1) throw invalid("version");
  if (view.getUint16(6, true) !== bytes.byteLength) throw invalid("length");
  const codePageCount = view.getUint16(104, true);
  if (
    codePageCount > OXAP_MAX_CODE_PAGES
    || bytes.byteLength !== OXAP_HEADER_LENGTH + codePageCount * OXAP_CODE_PAGE_LENGTH
    || bytes.subarray(106, 112).some((byte) => byte !== 0)
  ) throw invalid("code pages");
  const instructionCount = view.getUint16(86, true);
  if (instructionCount === 0 || instructionCount > 128) {
    throw invalid("instruction count");
  }
  const packByteLength = view.getUint32(80, true);
  if (packByteLength === 0 || packByteLength > 4 * 1024 * 1024) {
    throw invalid("pack length");
  }
  const codePages = Array.from({ length: codePageCount }, (_, index) => {
    const offset = OXAP_HEADER_LENGTH + index * OXAP_CODE_PAGE_LENGTH;
    if (bytes.subarray(offset + 25, offset + 32).some((byte) => byte !== 0)) {
      throw invalid("code page reserved field");
    }
    const globalSupervisor = view.getUint8(offset + 24);
    if (globalSupervisor > 1) throw invalid("code page flags");
    return {
      linear: view.getBigUint64(offset, true),
      physical: view.getBigUint64(offset + 8, true),
      generation: view.getBigUint64(offset + 16, true),
      globalSupervisor: globalSupervisor === 1,
    };
  });
  return {
    generation: view.getBigUint64(8, true),
    token: [view.getBigUint64(16, true), view.getBigUint64(24, true)],
    cacheKey: view.getBigUint64(32, true),
    imageBase: view.getBigUint64(40, true),
    packSha256: [...bytes.subarray(48, 80)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
    packByteLength,
    packMemberIndex: view.getUint16(84, true),
    instructionCount,
    memberEntryOffset: view.getBigUint64(88, true),
    startRip: view.getBigUint64(96, true),
    codePages,
  };
}

function invalid(field: string): ReturnType<typeof fault> {
  return fault(`pending AOT record has invalid ${field}`);
}
