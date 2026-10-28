import { boolean, exactKeys, integer, record } from "../../runtime/decode.js";
import { VMError, decodeSerializedError } from "../../runtime/errors.js";
import type { SerializedError } from "../../runtime/errors.js";

// A backup destination the page picked (a native file handle) stays in the page; the runtime frame
// writes to it over a port of its own. Each call carries an id and waits for its reply, so a slow
// disk slows the export instead of filling memory.

/** The largest chunk the frame writes in one call. */
export const MAX_BACKUP_CHUNK = 8 * 1024 ** 2;

export type BackupCall =
  | { readonly type: "open"; readonly id: number; readonly keepExistingData: boolean }
  | { readonly type: "write"; readonly id: number; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly type: "close"; readonly id: number }
  | { readonly type: "abort"; readonly id: number; readonly reason: SerializedError | null };

export type BackupCallReply = { readonly type: "reply"; readonly id: number; readonly error: SerializedError | null };

export function decodeBackupCall(value: unknown): BackupCall {
  const call = record(value, "backup destination call");
  const id = integer(call["id"], "backup call id", 1, 0x7fff_ffff);
  switch (call["type"]) {
    case "open":
      exactKeys(call, ["type", "id", "keepExistingData"]);
      return { type: "open", id, keepExistingData: boolean(call["keepExistingData"], "keep existing data") };
    case "write": {
      exactKeys(call, ["type", "id", "bytes"]);
      const bytes = call["bytes"];
      if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteLength > MAX_BACKUP_CHUNK) throw new VMError("PROTOCOL_ERROR", "backup chunk is invalid");
      return { type: "write", id, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
    }
    case "close":
      exactKeys(call, ["type", "id"]);
      return { type: "close", id };
    case "abort":
      exactKeys(call, ["type", "id", "reason"]);
      return { type: "abort", id, reason: call["reason"] === null ? null : decodeSerializedError(call["reason"]) };
    default:
      throw new VMError("PROTOCOL_ERROR", "backup destination call is invalid");
  }
}

export function decodeBackupCallReply(value: unknown): BackupCallReply {
  const reply = record(value, "backup destination reply");
  exactKeys(reply, ["type", "id", "error"]);
  if (reply["type"] !== "reply") throw new VMError("PROTOCOL_ERROR", "backup destination reply is invalid");
  return { type: "reply", id: integer(reply["id"], "backup call id", 1, 0x7fff_ffff), error: reply["error"] === null ? null : decodeSerializedError(reply["error"]) };
}
