import { exactKeys, integer, record } from "../../runtime/decode.js";
import { VMError, decodeSerializedError, serializeUnknownError } from "../../runtime/errors.js";
import type { SerializedError } from "../../runtime/errors.js";
import { FRAME_PROTOCOL_VERSION } from "./handshake.js";
import { decodeKeeperCommand } from "./keepers.js";
import type { KeeperCommand } from "./keepers.js";

// What the runtime frame sends back on the connected port: one result per request, and any number
// of events before it (progress, watched ports, network states, restore point events). The value
// and event payloads are decoded by the request that is waiting for them.

export type FrameReply =
  | KeeperCommand
  | { readonly type: "result"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly type: "result"; readonly id: number; readonly ok: false; readonly error: SerializedError }
  | { readonly type: "event"; readonly id: number; readonly event: unknown };

export function frameResult(id: number, value: unknown): Readonly<Record<string, unknown>> {
  return { v: FRAME_PROTOCOL_VERSION, type: "result", id, ok: true, value };
}

export function frameFailure(id: number, error: unknown): Readonly<Record<string, unknown>> {
  return { v: FRAME_PROTOCOL_VERSION, type: "result", id, ok: false, error: serializeUnknownError(error) };
}

export function frameEvent(id: number, event: unknown): Readonly<Record<string, unknown>> {
  return { v: FRAME_PROTOCOL_VERSION, type: "event", id, event };
}

export function decodeFrameReply(value: unknown): FrameReply {
  const reply = record(value, "frame reply");
  integer(reply["v"], "frame protocol", FRAME_PROTOCOL_VERSION, FRAME_PROTOCOL_VERSION);
  if (reply["type"] === "keeper") return decodeKeeperCommand(reply);
  const id = integer(reply["id"], "frame request id", 1, 0x7fff_ffff);
  if (reply["type"] === "event") {
    exactKeys(reply, ["v", "type", "id", "event"]);
    return { type: "event", id, event: reply["event"] };
  }
  if (reply["type"] !== "result") throw new VMError("PROTOCOL_ERROR", "frame reply type is invalid");
  if (reply["ok"] === true) {
    exactKeys(reply, ["v", "type", "id", "ok", "value"]);
    return { type: "result", id, ok: true, value: reply["value"] };
  }
  exactKeys(reply, ["v", "type", "id", "ok", "error"]);
  if (reply["ok"] !== false) throw new VMError("PROTOCOL_ERROR", "frame reply outcome is invalid");
  return { type: "result", id, ok: false, error: decodeSerializedError(reply["error"]) };
}
