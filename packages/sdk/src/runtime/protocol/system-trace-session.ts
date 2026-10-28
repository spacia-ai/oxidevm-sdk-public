import { boolean, exactKeys, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import type { SystemTraceSessionState, SystemTraceSnapshot } from "./system.js";

const WAITS = ["none", "run", "yield-idle", "yield-task", "paused", "console-ack"] as const;

function isWait(value: string): value is SystemTraceSessionState["waiting"] {
  return WAITS.some(candidate => candidate === value);
}

/** The control worker's system session pump state, carried from schema 35:
 * whether a session is live and which wait it sits in, so a guest that stops
 * retiring instructions can be told from a scheduler that stopped running
 * slices. */
export function decodeSystemTraceSession(
  value: unknown,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): SystemTraceSessionState {
  if (schemaVersion < 35) throw new VMError("PROTOCOL_ERROR", "system session state requires trace schema 35");
  const session = record(value, "system session state");
  exactKeys(session, ["active", "paused", "stopping", "awaitingConsoleAck", "waiting"]);
  const waiting = string(session["waiting"], "system session wait");
  if (!isWait(waiting)) throw new VMError("PROTOCOL_ERROR", "system session wait is invalid");
  return {
    active: boolean(session["active"], "system session activity"),
    paused: boolean(session["paused"], "system session pause state"),
    stopping: boolean(session["stopping"], "system session stop state"),
    awaitingConsoleAck: boolean(session["awaitingConsoleAck"], "system session console acknowledgement"),
    waiting,
  };
}
