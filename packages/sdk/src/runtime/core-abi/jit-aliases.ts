import { BinaryCursor, expectMagic, fault } from "./cursor.ts";

export interface JitAliasEvent {
  readonly sequence: bigint;
  readonly artifactCacheKey: bigint;
  readonly artifactModuleLength: number;
  readonly cacheKey: bigint;
  readonly moduleLength: number;
  readonly suffix: Uint8Array;
}

/** OXJB v1 carries bounded identity suffixes, never executable replacements. */
export function decodeJitAliasEvents(bytes: Uint8Array): readonly JitAliasEvent[] {
  if (bytes.byteLength < 16 || bytes.byteLength > 1024 * 1024) throw fault("invalid JIT alias batch length");
  const cursor = new BinaryCursor(bytes);
  expectMagic(cursor, "OXJB");
  if (cursor.u16() !== 1 || cursor.u16() !== 0 || cursor.u32() !== bytes.byteLength - 12) {
    throw fault("invalid JIT alias batch header");
  }
  const count = cursor.u32();
  if (count === 0 || count > Math.floor((bytes.byteLength - 16) / 37)) throw fault("invalid JIT alias count");
  const events: JitAliasEvent[] = [];
  let previous = 0n;
  for (let index = 0; index < count; index++) {
    const sequence = cursor.u64();
    const artifactCacheKey = cursor.u64();
    const artifactModuleLength = cursor.u32();
    const cacheKey = cursor.u64();
    const moduleLength = cursor.u32();
    const length = cursor.u32();
    if (sequence === 0n || (index !== 0 && sequence !== previous + 1n)
      || artifactCacheKey === 0n || cacheKey === 0n || artifactModuleLength < 8
      || length === 0 || length > 16 * 1024 || artifactModuleLength + length !== moduleLength) {
      throw fault("invalid JIT alias identity");
    }
    const suffix = new Uint8Array(length);
    for (let byte = 0; byte < length; byte++) suffix[byte] = cursor.u8();
    events.push({ sequence, artifactCacheKey, artifactModuleLength, cacheKey, moduleLength, suffix });
    previous = sequence;
  }
  cursor.finish("JIT alias batch");
  return events;
}
