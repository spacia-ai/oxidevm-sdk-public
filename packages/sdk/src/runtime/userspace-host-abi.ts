import { decodeUserspaceCommandRequest, type UserspaceCommandHostRequest } from "./userspace-command-abi.ts";
import { VMError } from "./errors.ts";
import { integer } from "./decode.ts";

export interface UserspaceStorageHostRequest {
  readonly kind: "storage";
  readonly generation: bigint;
  readonly id: bigint;
  readonly path: string;
  /** Size of the whole file the range belongs to. */
  readonly expectedBytes: number;
  readonly expectedSha256?: string;
  /** First byte of the range within the file; zero for a whole-file read. */
  readonly offset: number;
  /** Bytes this request transfers; equal to `expectedBytes` for a whole-file read. */
  readonly length: number;
}

/** Largest single host transfer in either direction (the Rust engine's `MAX_HOST_TRANSFER_BYTES`). */
const MAX_HOST_TRANSFER_BYTES = 128n * 1024n * 1024n;
/** Largest host file a ranged read may describe; the guest's memory budget is far below it. */
const MAX_RANGED_FILE_BYTES = 4n * 1024n * 1024n * 1024n;

export type UserspaceNetworkOperation =
  | { readonly kind: "connect"; readonly socket: bigint; readonly family: 2 | 10; readonly address: Uint8Array; readonly port: number }
  | { readonly kind: "send"; readonly socket: bigint; readonly bytes: Uint8Array }
  | { readonly kind: "send-to"; readonly socket: bigint; readonly family: 2 | 10; readonly address: Uint8Array; readonly port: number; readonly bytes: Uint8Array }
  | { readonly kind: "receive"; readonly socket: bigint; readonly maxBytes: number }
  | { readonly kind: "receive-from"; readonly socket: bigint; readonly maxBytes: number }
  | { readonly kind: "shutdown"; readonly socket: bigint; readonly how: 0 | 1 | 2 }
  | { readonly kind: "close"; readonly socket: bigint };

export interface UserspaceNetworkHostRequest {
  readonly kind: "network";
  readonly generation: bigint;
  readonly id: bigint;
  readonly operation: UserspaceNetworkOperation;
}

export interface UserspaceDurabilityHostRequest {
  readonly kind: "durability";
  readonly generation: bigint;
  readonly id: bigint;
  readonly workspace?: bigint;
  readonly root?: bigint;
}
export type UserspaceDurabilityHostCompletion =
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly errno: 4 | 5 | 12 | 28 };

export type UserspaceHostRequest = UserspaceStorageHostRequest | UserspaceNetworkHostRequest | UserspaceDurabilityHostRequest | UserspaceCommandHostRequest;

export type UserspaceHostCompletion =
  | { readonly kind: "ok"; readonly bytes: Uint8Array; readonly sha256?: string }
  | { readonly kind: "not-found" | "io" | "aborted" };

export type UserspaceNetworkHostCompletion =
  | { readonly kind: "connected" | "shutdown" | "closed" }
  | { readonly kind: "sent"; readonly bytes: number }
  | { readonly kind: "received"; readonly bytes: Uint8Array }
  | { readonly kind: "received-from"; readonly family: 2 | 10; readonly address: Uint8Array; readonly port: number; readonly bytes: Uint8Array }
  | { readonly kind: "error"; readonly errno: 1 | 4 | 5 | 11 | 22 | 32 | 93 | 95 | 101 | 104 | 113 | 107 | 110 | 111 | 114 | 115 };

export function decodeUserspaceHostRequest(bytes: Uint8Array): UserspaceHostRequest {
  if (new TextDecoder().decode(bytes.subarray(0, 4)) === "OXCR") return decodeUserspaceCommandRequest(bytes);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) === "OXDR") return decodeDurabilityHostRequest(bytes);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) === "OXNR") {
    return decodeNetworkHostRequest(bytes);
  }
  if (bytes.byteLength < 44 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "OXHR") {
    throw malformedHostRequest();
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  const headerLength = version === 1 ? 44 : version === 2 ? 76 : version === 3 ? 92 : 0;
  const pathLength = view.getUint32(36, true);
  if (
    headerLength === 0
    || view.getUint16(6, true) !== 0
    || view.getUint32(8, true) !== bytes.byteLength - 12
    || pathLength === 0
    || pathLength > 4096
    || pathLength !== bytes.byteLength - headerLength
    || (version === 1
      ? bytes.subarray(40, 44).some((byte) => byte !== 0)
      : bytes.subarray(72, 76).some((byte) => byte !== 0))
  ) {
    throw malformedHostRequest();
  }
  const expected = view.getBigUint64(28, true);
  // A whole-file read must fit one transfer. A version 3 range may describe a larger file, but the
  // range itself must fit one transfer and lie inside the file.
  const offset = version === 3 ? view.getBigUint64(76, true) : 0n;
  const length = version === 3 ? view.getBigUint64(84, true) : expected;
  if (version !== 3 && expected > MAX_HOST_TRANSFER_BYTES) throw malformedHostRequest();
  if (
    version === 3
    && (expected > MAX_RANGED_FILE_BYTES
      || length === 0n
      || length > MAX_HOST_TRANSFER_BYTES
      || offset + length > expected)
  ) throw malformedHostRequest();
  let path: string;
  try {
    path = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(headerLength));
  } catch {
    throw malformedHostRequest();
  }
  if (!path.startsWith("/") || path.includes("\0")) throw malformedHostRequest();
  return {
    kind: "storage",
    generation: view.getBigUint64(12, true),
    id: view.getBigUint64(20, true),
    path,
    expectedBytes: Number(expected),
    ...(version >= 2 ? { expectedSha256: hex(bytes.subarray(40, 72)) } : {}),
    offset: Number(offset),
    length: Number(length),
  };
}

function decodeNetworkHostRequest(bytes: Uint8Array): UserspaceNetworkHostRequest {
  if (bytes.byteLength < 48) throw malformedHostRequest();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(44, true);
  if (
    view.getUint16(4, true) !== 1
    || view.getUint16(6, true) !== 0
    || view.getUint32(8, true) !== bytes.byteLength - 12
    || bytes.subarray(29, 32).some((byte) => byte !== 0)
    || length !== bytes.byteLength - 48
    || length > 1024 * 1024
  ) throw malformedHostRequest();
  const socket = view.getBigUint64(32, true);
  if (socket === 0n) throw malformedHostRequest();
  const value = view.getUint32(40, true);
  const payload = bytes.slice(48);
  let operation: UserspaceNetworkOperation;
  switch (view.getUint8(28)) {
    case 0: {
      if (value !== 0 || payload.byteLength !== 20) throw malformedHostRequest();
      const family = new DataView(payload.buffer, payload.byteOffset).getUint16(0, true);
      if (family !== 2 && family !== 10) throw malformedHostRequest();
      operation = {
        kind: "connect",
        socket,
        family,
        port: new DataView(payload.buffer, payload.byteOffset).getUint16(2, false),
        address: payload.slice(4),
      };
      break;
    }
    case 1:
      if (value !== 0) throw malformedHostRequest();
      operation = { kind: "send", socket, bytes: payload };
      break;
    case 2:
      if (payload.byteLength !== 0 || value > 1024 * 1024) throw malformedHostRequest();
      operation = { kind: "receive", socket, maxBytes: value };
      break;
    case 3:
      if (payload.byteLength !== 0 || value > 2) throw malformedHostRequest();
      operation = { kind: "shutdown", socket, how: shutdownMode(value) };
      break;
    case 4:
      if (payload.byteLength !== 0 || value !== 0) throw malformedHostRequest();
      operation = { kind: "close", socket };
      break;
    case 5: {
      if (value !== 0 || payload.byteLength < 20) throw malformedHostRequest();
      const family = new DataView(payload.buffer, payload.byteOffset).getUint16(0, true);
      if (family !== 2 && family !== 10) throw malformedHostRequest();
      operation = {
        kind: "send-to",
        socket,
        family,
        port: new DataView(payload.buffer, payload.byteOffset).getUint16(2, false),
        address: payload.slice(4, 20),
        bytes: payload.slice(20),
      };
      break;
    }
    case 6:
      if (payload.byteLength !== 0 || value > 1024 * 1024) throw malformedHostRequest();
      operation = { kind: "receive-from", socket, maxBytes: value };
      break;
    default:
      throw malformedHostRequest();
  }
  return {
    kind: "network",
    generation: view.getBigUint64(12, true),
    id: view.getBigUint64(20, true),
    operation,
  };
}

function shutdownMode(value: number): 0 | 1 | 2 {
  if (value === 0 || value === 1 || value === 2) return value;
  throw malformedHostRequest();
}

export function encodeUserspaceHostCompletion(
  generation: bigint,
  id: bigint,
  completion: UserspaceHostCompletion,
): Uint8Array<ArrayBuffer> {
  const bytes = completion.kind === "ok" ? completion.bytes : new Uint8Array();
  if (bytes.byteLength > 128 * 1024 * 1024) {
    throw new VMError("PROTOCOL_ERROR", "Userspace host completion is too large");
  }
  if (completion.kind === "ok" && completion.sha256 !== undefined && !/^[0-9a-f]{64}$/u.test(completion.sha256)) {
    throw new VMError("PROTOCOL_ERROR", "Userspace host completion digest is malformed");
  }
  const version = completion.kind === "ok" && completion.sha256 !== undefined ? 2 : 1;
  const headerLength = version === 2 ? 76 : 44;
  const record = new Uint8Array(headerLength + bytes.byteLength);
  const view = new DataView(record.buffer);
  record.set(new TextEncoder().encode("OXHC"));
  view.setUint16(4, version, true);
  view.setUint32(8, record.byteLength - 12, true);
  view.setBigUint64(12, generation, true);
  view.setBigUint64(20, id, true);
  view.setUint8(28, hostCompletionTag(completion.kind));
  view.setUint32(36, bytes.byteLength, true);
  if (completion.kind === "ok" && completion.sha256 !== undefined) {
    record.set(hexBytes(completion.sha256), 40);
  }
  record.set(bytes, headerLength);
  return record;
}

export function encodeUserspaceNetworkHostCompletion(
  generation: bigint,
  id: bigint,
  completion: UserspaceNetworkHostCompletion,
): Uint8Array<ArrayBuffer> {
  const payload = completion.kind === "received"
    ? completion.bytes
    : completion.kind === "received-from"
      ? encodeReceivedFrom(completion)
      : new Uint8Array();
  if (payload.byteLength > 1024 * 1024) {
    throw new VMError("PROTOCOL_ERROR", "Userspace network completion is too large");
  }
  const record = new Uint8Array(44 + payload.byteLength);
  const view = new DataView(record.buffer);
  record.set(new TextEncoder().encode("OXNC"));
  view.setUint16(4, 1, true);
  view.setUint32(8, record.byteLength - 12, true);
  view.setBigUint64(12, generation, true);
  view.setBigUint64(20, id, true);
  const [tag, value] = networkCompletionHeader(completion);
  view.setUint8(28, tag);
  view.setUint32(32, value, true);
  record.set(payload, 44);
  return record;
}

function networkCompletionHeader(completion: UserspaceNetworkHostCompletion): readonly [number, number] {
  switch (completion.kind) {
    case "connected": return [0, 0];
    case "sent": return [1, integer(completion.bytes, "sent network bytes", 0, 1024 * 1024)];
    case "received": return [2, 0];
    case "shutdown": return [3, 0];
    case "closed": return [4, 0];
    case "error": return [5, completion.errno];
    case "received-from": return [6, 0];
  }
}

function encodeReceivedFrom(completion: Extract<UserspaceNetworkHostCompletion, { kind: "received-from" }>): Uint8Array {
  if (completion.address.byteLength !== 16 || completion.bytes.byteLength > 1024 * 1024 - 20) {
    throw new VMError("PROTOCOL_ERROR", "Userspace datagram completion is malformed");
  }
  const payload = new Uint8Array(20 + completion.bytes.byteLength);
  const view = new DataView(payload.buffer);
  view.setUint16(0, completion.family, true);
  view.setUint16(2, completion.port, false);
  payload.set(completion.address, 4);
  payload.set(completion.bytes, 20);
  return payload;
}

function hostCompletionTag(kind: UserspaceHostCompletion["kind"]): number {
  switch (kind) {
    case "ok": return 0;
    case "not-found": return 1;
    case "io": return 2;
    case "aborted": return 3;
  }
}

function malformedHostRequest(): VMError {
  return new VMError("PROTOCOL_ERROR", "Userspace host request is malformed");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function decodeDurabilityHostRequest(bytes: Uint8Array): UserspaceDurabilityHostRequest {
  if (bytes.byteLength !== 48) throw malformedHostRequest();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint16(6, true);
  const generation = view.getBigUint64(12, true), id = view.getBigUint64(20, true);
  const workspace = view.getBigUint64(28, true), root = view.getBigUint64(36, true);
  if (view.getUint16(4, true) !== 1 || flags === 0 || flags > 3
    || view.getUint32(8, true) !== 36 || view.getUint32(44, true) !== 0
    || generation === 0n || id === 0n
    || ((flags & 1) === 0 && workspace !== 0n) || ((flags & 2) === 0 && root !== 0n)
    || workspace === 0xffff_ffff_ffff_ffffn || root === 0xffff_ffff_ffff_ffffn) throw malformedHostRequest();
  return { kind: "durability", generation, id,
    ...((flags & 1) !== 0 ? { workspace } : {}), ...((flags & 2) !== 0 ? { root } : {}) };
}

export function encodeUserspaceDurabilityHostCompletion(generation: bigint, id: bigint,
  completion: UserspaceDurabilityHostCompletion): Uint8Array<ArrayBuffer> {
  if (generation <= 0n || generation > 0xffff_ffff_ffff_ffffn || id <= 0n || id > 0xffff_ffff_ffff_ffffn) {
    throw malformedHostRequest();
  }
  const record = new Uint8Array(32), view = new DataView(record.buffer);
  record.set(new TextEncoder().encode("OXDC")); view.setUint16(4, 1, true);
  view.setUint32(8, 20, true); view.setBigUint64(12, generation, true); view.setBigUint64(20, id, true);
  view.setUint32(28, completion.kind === "ok" ? 0 : completion.errno, true);
  return record;
}
