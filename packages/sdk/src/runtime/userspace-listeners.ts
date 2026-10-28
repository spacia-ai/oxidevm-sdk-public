// The Userspace runtime's listener record v1 (oxidevm_userspace_listeners), decoded exactly.
import { VMError } from "./errors.ts";
import { formatListenerAddress, MAX_LISTENING_PORTS, MAX_LISTENING_PROGRAM_LENGTH, type ListeningPortsRead } from "./listening-ports.ts";
import type { ListeningPort } from "./vm-types.js";

export const USERSPACE_LISTENER_RECORD_VERSION = 1;
const HEADER_BYTES = 16;
const ENTRY_BYTES = 22;
const PREVIEWABLE = 0b01;
const HAS_PROGRAM = 0b10;

export interface ListenerRecord {
  readonly generation: bigint;
  readonly ports: readonly ListeningPort[];
}

/** u32 version 1, u32 count (at most 256), u64 generation, then per listener u16 port (1 to
 * 65535), u8 family (4 or 6), u8 flags (bit 0 previewable, bit 1 has a program), 16 address
 * bytes (IPv4 in the first four, the rest zero), u16 program length (at most 256, zero exactly
 * when there is no program) and the program's UTF-8; strictly ascending by port, family and
 * address, with nothing after the last. */
export function decodeUserspaceListenerRecord(bytes: Uint8Array): ListenerRecord {
  if (bytes.byteLength < HEADER_BYTES) throw fault("is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== USERSPACE_LISTENER_RECORD_VERSION) throw fault("version is unsupported");
  const count = view.getUint32(4, true);
  if (count > MAX_LISTENING_PORTS) throw fault("lists too many ports");
  const generation = view.getBigUint64(8, true);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const ports: ListeningPort[] = [];
  let previous: readonly number[] | undefined;
  let offset = HEADER_BYTES;
  for (let index = 0; index < count; index += 1) {
    if (offset + ENTRY_BYTES > bytes.byteLength) throw fault("is truncated");
    const port = view.getUint16(offset, true);
    const family = view.getUint8(offset + 2);
    const flags = view.getUint8(offset + 3);
    const address = bytes.subarray(offset + 4, offset + 20);
    const programLength = view.getUint16(offset + 20, true);
    offset += ENTRY_BYTES;
    if (port === 0) throw fault("names port 0");
    if (family !== 4 && family !== 6) throw fault("names an unknown family");
    if ((flags & ~(PREVIEWABLE | HAS_PROGRAM)) !== 0) throw fault("sets reserved flags");
    if (family === 4 && address.subarray(4).some((byte) => byte !== 0)) throw fault("pads an IPv4 address with data");
    const hasProgram = (flags & HAS_PROGRAM) !== 0;
    if (programLength > MAX_LISTENING_PROGRAM_LENGTH || hasProgram !== (programLength !== 0)) throw fault("has an invalid program length");
    if (offset + programLength > bytes.byteLength) throw fault("is truncated");
    const program = hasProgram ? utf8(decoder, bytes.subarray(offset, offset + programLength)) : null;
    offset += programLength;
    const key = [port, family, ...address];
    if (previous !== undefined && compare(previous, key) >= 0) throw fault("is not in order");
    previous = key;
    ports.push({ port, address: formatListenerAddress(family, address), program, previewable: (flags & PREVIEWABLE) !== 0 });
  }
  if (offset !== bytes.byteLength) throw fault("has trailing bytes");
  return { generation, ports };
}

/** The Userspace worker's answer to a listening-ports read: none (no process has run yet, so
 * nothing listens), unchanged (the known generation), or a listener record. */
export function decodeUserspaceListenerRead(value: unknown): ListeningPortsRead {
  if (typeof value !== "object" || value === null || !("kind" in value)) throw fault("read is not a record");
  const keys = Object.keys(value).sort().join(",");
  if (value.kind === "none" && keys === "kind") return { generation: 0n, ports: [] };
  if (value.kind === "unchanged" && keys === "generation,kind" && "generation" in value) {
    const generation = value.generation;
    if (typeof generation !== "bigint" || generation < 0n || generation > 0xffff_ffff_ffff_ffffn) throw fault("read has an invalid generation");
    return { generation, ports: null };
  }
  if (value.kind === "listeners" && keys === "kind,record" && "record" in value && value.record instanceof Uint8Array) {
    return decodeUserspaceListenerRecord(value.record);
  }
  throw fault("read is malformed");
}

function utf8(decoder: TextDecoder, bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw fault("has a program that is not UTF-8");
  }
}

function compare(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function fault(problem: string): VMError {
  return new VMError("PROTOCOL_ERROR", `Userspace listener record ${problem}`);
}
