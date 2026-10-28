import { exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeBytes } from "../protocol/decoders.js";
import { SNAPSHOT_CHUNK_BYTES } from "./snapshot-manifest.js";

export type NativePayloadStorageRequest =
  | { readonly type: "native-payload-round-open"; readonly round: number }
  | { readonly type: "native-payload-round-put"; readonly round: number; readonly index: number; readonly data: Uint8Array }
  | { readonly type: "native-payload-round-seal"; readonly round: number; readonly bytes: number }
  | { readonly type: "native-live-index-put"; readonly index: number; readonly data: Uint8Array }
  | { readonly type: "native-live-index-seal"; readonly bytes: number }
  | { readonly type: "native-payload-consolidate" };
const MAX_STREAM_BYTES = 16 * 1024 ** 3;

export function decodeNativePayloadRequest(value: unknown): NativePayloadStorageRequest {
  const input = record(value, "native payload storage request");
  switch (input["type"]) {
    case "native-payload-round-open":
      exactKeys(input, ["type", "round"]);
      return { type: input["type"], round: round(input["round"]) };
    case "native-payload-round-put":
      exactKeys(input, ["type", "round", "index", "data"]);
      return { type: input["type"], round: round(input["round"]), index: index(input["index"]), data: bytes(input["data"]) };
    case "native-payload-round-seal":
      exactKeys(input, ["type", "round", "bytes"]);
      return { type: input["type"], round: round(input["round"]), bytes: length(input["bytes"]) };
    case "native-live-index-put":
      exactKeys(input, ["type", "index", "data"]);
      return { type: input["type"], index: index(input["index"]), data: bytes(input["data"]) };
    case "native-live-index-seal":
      exactKeys(input, ["type", "bytes"]);
      return { type: input["type"], bytes: length(input["bytes"]) };
    case "native-payload-consolidate":
      exactKeys(input, ["type"]); return { type: input["type"] };
    default: throw new VMError("PROTOCOL_ERROR", "Unknown native payload storage operation");
  }
}
function round(value: unknown): number { return integer(value, "native payload round", 0, 3); }
function index(value: unknown): number { return integer(value, "native payload chunk", 0, MAX_STREAM_BYTES / SNAPSHOT_CHUNK_BYTES - 1); }
function length(value: unknown): number { return integer(value, "native payload stream bytes", 16, MAX_STREAM_BYTES); }
function bytes(value: unknown): Uint8Array {
  const data = decodeBytes(value);
  if (data.length === 0 || data.length > SNAPSHOT_CHUNK_BYTES) throw new VMError("PROTOCOL_ERROR", "Native payload chunk exceeds its bound");
  return data;
}
