import { BinaryCursor, fault } from "./cursor.ts";

const RECORD_HEADER_LENGTH = 12;

export function pageEntry(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

export function recordPayload(
  bytes: Uint8Array,
  magic: string,
  version: number,
  payloadLength: number,
): BinaryCursor {
  const header = new BinaryCursor(bytes);
  expectMagic(header, magic);
  if (header.u16() !== version) {
    throw fault(`unsupported ${magic} record version`);
  }
  if (header.u16() !== 0) {
    throw fault(`${magic} record has a nonzero reserved header`);
  }
  if (
    header.u32() !== payloadLength ||
    bytes.byteLength !== RECORD_HEADER_LENGTH + payloadLength
  ) {
    throw fault(`${magic} record has an invalid length`);
  }
  return new BinaryCursor(bytes, RECORD_HEADER_LENGTH);
}

export function expectMagic(cursor: BinaryCursor, expected: string): void {
  for (let index = 0; index < expected.length; index += 1) {
    if (cursor.u8() !== expected.charCodeAt(index)) {
      throw fault("invalid core record magic");
    }
  }
}
