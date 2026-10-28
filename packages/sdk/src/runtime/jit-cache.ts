import { exactKeys, integer, record, string } from "./decode.ts";
import { VMError } from "./errors.ts";

export const MAX_JIT_MODULE_BYTES = 4 * 1024 * 1024;
/** Compiled JIT module bytes a system core keeps alive. The cost of a larger budget is browser
 * memory for compiled code: 2 GiB is the budget that removed every eviction from the first
 * `bun dev` request, at a 7.5 GB renderer peak in Userspace mode. */
export const JIT_CACHE_BYTES = 2048 * 1024 * 1024;
/** Match the Rust cache's 2 GiB limit to avoid recompiling the one-file typecheck's modules.
 * This accounts for module bytes; browser memory also includes compiled code and metadata. */
export const USERSPACE_JIT_CACHE_BYTES = JIT_CACHE_BYTES;
export const JIT_DISPATCH_TABLE_ENTRIES = 65_536;
export const JIT_REGION_MAX_INSTRUCTIONS = 4_096;
/** Tier-1 modules one linked JIT module holds; the core links no more (`MAX_LINKED_MEMBERS`). */
export const MAX_LINKED_JIT_MEMBERS = 256;
export const JIT_CACHE_INDEX_VERSION = 1;

const CACHE_KEY = /^[0-9a-f]{1,16}:[1-9][0-9]{0,6}$/;
const RUNTIME_KEY = /^[0-9a-f]{64}$/;

export function validateJitCacheKey(value: unknown): string {
  const key = string(value, "JIT cache key");
  if (!CACHE_KEY.test(key)) {
    throw new VMError("PROTOCOL_ERROR", "invalid JIT cache key");
  }
  return key;
}

export function validateJitRuntimeKey(value: unknown): string {
  const key = string(value, "JIT runtime key");
  if (!RUNTIME_KEY.test(key)) {
    throw new VMError("PROTOCOL_ERROR", "invalid JIT runtime key");
  }
  return key;
}

export function decodeJitCacheIndex(value: unknown): Map<string, number> {
  const index = record(value, "JIT cache index");
  exactKeys(index, ["version", "entries"]);
  if (
    integer(index["version"], "JIT cache index version", 1, 1) !==
    JIT_CACHE_INDEX_VERSION
  ) {
    throw new VMError("PROTOCOL_ERROR", "unsupported JIT cache index");
  }
  if (!Array.isArray(index["entries"])) {
    throw new VMError("PROTOCOL_ERROR", "JIT cache entries must be an array");
  }

  const entries = new Map<string, number>();
  let total = 0;
  for (const value of index["entries"]) {
    const entry = record(value, "JIT cache entry");
    exactKeys(entry, ["key", "bytes"]);
    const key = validateJitCacheKey(entry["key"]);
    const bytes = integer(
      entry["bytes"],
      "JIT cache entry bytes",
      1,
      MAX_JIT_MODULE_BYTES,
    );
    if (Number(key.slice(key.lastIndexOf(":") + 1)) !== bytes) {
      throw new VMError(
        "PROTOCOL_ERROR",
        "JIT cache key length does not match its entry",
      );
    }
    if (entries.has(key)) {
      throw new VMError("PROTOCOL_ERROR", "duplicate JIT cache entry");
    }
    total += bytes;
    if (total > JIT_CACHE_BYTES) {
      throw new VMError("PROTOCOL_ERROR", "JIT cache index exceeds its limit");
    }
    entries.set(key, bytes);
  }
  return entries;
}

export function encodeJitCacheIndex(entries: ReadonlyMap<string, number>): string {
  return JSON.stringify({
    version: JIT_CACHE_INDEX_VERSION,
    entries: [...entries].map(([key, bytes]) => ({ key, bytes })),
  });
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  const length = left.byteLength;
  if (length !== right.byteLength) return false;
  let index = 0;
  if (length >= 512) {
    const leftView = new DataView(left.buffer, left.byteOffset, length);
    const rightView = new DataView(right.buffer, right.byteOffset, length);
    for (; index + 4 <= length; index += 4) {
      if (leftView.getUint32(index, true) !== rightView.getUint32(index, true)) return false;
    }
  } else if (length === 0) {
    // Preserve detached-buffer validation when an empty view appears valid.
    return left.every(() => true) && right.every(() => true);
  }
  for (; index < length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function findContiguousJitSlots(
  occupied: { readonly size: number; has(slot: number): boolean },
  count: number,
  start: number,
  capacity: number,
): number | null {
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    start >= capacity ||
    !Number.isSafeInteger(capacity) ||
    capacity < count
  ) {
    throw new RangeError("invalid JIT dispatch slot search");
  }
  if (occupied.size === capacity) return null;

  const scan = (first: number, limit: number): number | null => {
    while (first < limit && first + count <= capacity) {
      let blocker: number | undefined;
      for (let slot = first; slot < first + count; slot += 1) {
        if (occupied.has(slot)) {
          blocker = slot;
          break;
        }
      }
      if (blocker === undefined) return first;
      first = blocker + 1;
    }
    return null;
  };

  return scan(start, capacity) ?? scan(0, start);
}
