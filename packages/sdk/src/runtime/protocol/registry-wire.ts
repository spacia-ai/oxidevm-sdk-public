import { record } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeRegistryReply, decodeRegistryRequest, type RegistryReply, type RegistryRequest } from "./registry.js";

const LIMIT = 128 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Invalid private registry frame"); }

/** Private byte transport for the existing worker contract: a little-endian
 * metadata length, canonical JSON metadata, then raw data bytes (data only).
 * The transport owner must reserve envelope/copy credit before calling either
 * codec. Framing and authenticated installation authority belong to that owner. */
export function encodeRegistryWire(value: unknown, direction: "request" | "reply"): Uint8Array<ArrayBuffer> {
  const message = direction === "request" ? decodeRegistryRequest(value) : decodeRegistryReply(value);
  let metadata: string;
  let data: Uint8Array = new Uint8Array();
  if (message.kind === "data") {
    const { bytes, ...header } = message;
    data = bytes; metadata = JSON.stringify(header);
  } else metadata = JSON.stringify(message);
  const header = encoder.encode(metadata);
  if (4 + header.byteLength + data.byteLength > LIMIT) invalid();
  const frame = new Uint8Array(4 + header.byteLength + data.byteLength);
  new DataView(frame.buffer).setUint32(0, header.byteLength, true);
  frame.set(header, 4); frame.set(data, 4 + header.byteLength);
  return frame;
}

export function decodeRegistryWire(frame: Uint8Array, direction: "request"): RegistryRequest;
export function decodeRegistryWire(frame: Uint8Array, direction: "reply"): RegistryReply;
export function decodeRegistryWire(frame: Uint8Array, direction: "request" | "reply"): RegistryRequest | RegistryReply {
  if (frame.byteLength < 4 || frame.byteLength > LIMIT) invalid();
  const size = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, true);
  if (size === 0 || size > frame.byteLength - 4) invalid();
  let json: string;
  let value: unknown;
  try {
    json = decoder.decode(frame.subarray(4, 4 + size));
    value = JSON.parse(json);
  } catch { return invalid(); }
  // Reject duplicate keys, ambiguous encodings and ignored JSON whitespace.
  if (JSON.stringify(value) !== json) invalid();
  const header = record(value, "private registry metadata");
  if (direction === "reply" && header["kind"] === "data") {
    if (Object.hasOwn(header, "bytes") || frame.byteLength - 4 - size > 65_536) invalid();
    return decodeRegistryReply({ ...header, bytes: new Uint8Array(frame.subarray(4 + size)) });
  }
  if (frame.byteLength !== size + 4) invalid();
  return direction === "request" ? decodeRegistryRequest(header) : decodeRegistryReply(header);
}
