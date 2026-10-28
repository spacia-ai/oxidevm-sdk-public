import type { ProcessExit } from "../../contracts.js";
import { exactKeys, integer, record, string } from "../../runtime/decode.js";
import { VMError, decodeSerializedError, serializeUnknownError } from "../../runtime/errors.js";
import type { SerializedError } from "../../runtime/errors.js";
import { decodeLinuxSignal, decodeSignalScope, knownLinuxSignal } from "../../runtime/process-signals.js";
import type { LinuxSignal } from "../../runtime/process-signals.js";

// One guest process between the runtime frame and the page, on a MessagePort of its own. Output
// moves as byte chunks against credit the page grants as its reader consumes them, and stdin moves
// against credit the frame grants as the guest takes it, so neither side buffers without bound and
// no stream is ever transferred (WebKit cannot transfer streams). Control calls carry an id and
// get one reply each.

/** Bytes either side may have in flight per stream before the other grants more. */
export const PROCESS_STREAM_CREDIT = 64 * 1024;
/** The largest chunk either side sends: a chunk never exceeds the window it is sent against. */
export const MAX_PROCESS_CHUNK = PROCESS_STREAM_CREDIT;

export type ProcessStreamName = "stdout" | "stderr" | "output";

export type ProcessControl =
  | { readonly op: "kill"; readonly signal: LinuxSignal; readonly scope: "process" | "process-group" }
  | { readonly op: "resize"; readonly columns: number; readonly rows: number }
  | { readonly op: "interrupt" };

/** What the page sends the frame about a process. */
export type ProcessPageMessage =
  | { readonly type: "credit"; readonly stream: ProcessStreamName; readonly bytes: number }
  | { readonly type: "cancel"; readonly stream: ProcessStreamName }
  | { readonly type: "stdin"; readonly bytes: Uint8Array }
  | { readonly type: "stdin-close" | "stdin-abort" }
  | ({ readonly type: "control"; readonly id: number } & ProcessControl);

/** What the frame sends the page about a process. */
export type ProcessFrameMessage =
  | { readonly type: "data"; readonly stream: ProcessStreamName; readonly bytes: Uint8Array }
  | { readonly type: "end"; readonly stream: ProcessStreamName }
  | { readonly type: "error"; readonly stream: ProcessStreamName; readonly error: SerializedError }
  | { readonly type: "stdin-credit"; readonly bytes: number }
  | { readonly type: "stdin-error"; readonly error: SerializedError }
  | { readonly type: "control-reply"; readonly id: number; readonly error: SerializedError | null }
  | { readonly type: "exit"; readonly exit: ExitWire }
  | { readonly type: "exit-error"; readonly error: SerializedError };

/** A process exit without the signal name: the page names the number itself. */
export type ExitWire = { readonly kind: "exited"; readonly code: number } | { readonly kind: "signaled"; readonly signalNumber: number };

export function encodeExit(exit: ProcessExit): ExitWire {
  return exit.kind === "exited" ? exit : { kind: "signaled", signalNumber: exit.signalNumber };
}

export function exitFromWire(exit: ExitWire): ProcessExit {
  return exit.kind === "exited" ? exit : { kind: "signaled", signal: knownLinuxSignal(exit.signalNumber), signalNumber: exit.signalNumber };
}

export function processError(error: unknown): SerializedError {
  return serializeUnknownError(error);
}

export function decodeProcessPageMessage(value: unknown): ProcessPageMessage {
  const message = record(value, "process message");
  switch (message["type"]) {
    case "credit":
      exactKeys(message, ["type", "stream", "bytes"]);
      return { type: "credit", stream: streamName(message["stream"]), bytes: integer(message["bytes"], "stream credit", 1, PROCESS_STREAM_CREDIT * 16) };
    case "cancel":
      exactKeys(message, ["type", "stream"]);
      return { type: "cancel", stream: streamName(message["stream"]) };
    case "stdin":
      exactKeys(message, ["type", "bytes"]);
      return { type: "stdin", bytes: chunk(message["bytes"]) };
    case "stdin-close": case "stdin-abort":
      exactKeys(message, ["type"]);
      return { type: message["type"] };
    case "control":
      return decodeControl(message);
    default:
      throw new VMError("PROTOCOL_ERROR", "process message type is invalid");
  }
}

export function decodeProcessFrameMessage(value: unknown): ProcessFrameMessage {
  const message = record(value, "process message");
  switch (message["type"]) {
    case "data":
      exactKeys(message, ["type", "stream", "bytes"]);
      return { type: "data", stream: streamName(message["stream"]), bytes: chunk(message["bytes"]) };
    case "end":
      exactKeys(message, ["type", "stream"]);
      return { type: "end", stream: streamName(message["stream"]) };
    case "error":
      exactKeys(message, ["type", "stream", "error"]);
      return { type: "error", stream: streamName(message["stream"]), error: decodeSerializedError(message["error"]) };
    case "stdin-credit":
      exactKeys(message, ["type", "bytes"]);
      return { type: "stdin-credit", bytes: integer(message["bytes"], "stdin credit", 1, PROCESS_STREAM_CREDIT * 16) };
    case "stdin-error": case "exit-error":
      exactKeys(message, ["type", "error"]);
      return { type: message["type"], error: decodeSerializedError(message["error"]) };
    case "control-reply":
      exactKeys(message, ["type", "id", "error"]);
      return { type: "control-reply", id: integer(message["id"], "control id", 1, 0x7fff_ffff), error: message["error"] === null ? null : decodeSerializedError(message["error"]) };
    case "exit":
      exactKeys(message, ["type", "exit"]);
      return { type: "exit", exit: decodeExit(message["exit"]) };
    default:
      throw new VMError("PROTOCOL_ERROR", "process message type is invalid");
  }
}

function decodeControl(message: Readonly<Record<string, unknown>>): ProcessPageMessage {
  const id = integer(message["id"], "control id", 1, 0x7fff_ffff);
  switch (message["op"]) {
    case "kill":
      exactKeys(message, ["type", "id", "op", "signal", "scope"]);
      return { type: "control", id, op: "kill", signal: decodeLinuxSignal(message["signal"]), scope: decodeSignalScope(message["scope"]) };
    case "resize":
      exactKeys(message, ["type", "id", "op", "columns", "rows"]);
      return { type: "control", id, op: "resize", columns: integer(message["columns"], "terminal columns", 1, 1000), rows: integer(message["rows"], "terminal rows", 1, 1000) };
    case "interrupt":
      exactKeys(message, ["type", "id", "op"]);
      return { type: "control", id, op: "interrupt" };
    default:
      throw new VMError("PROTOCOL_ERROR", "process control is invalid");
  }
}

function decodeExit(value: unknown): ExitWire {
  const exit = record(value, "process exit");
  if (exit["kind"] === "exited") {
    exactKeys(exit, ["kind", "code"]);
    return { kind: "exited", code: integer(exit["code"], "exit code", 0, 255) };
  }
  if (exit["kind"] !== "signaled") throw new VMError("PROTOCOL_ERROR", "process exit is invalid");
  exactKeys(exit, ["kind", "signalNumber"]);
  return { kind: "signaled", signalNumber: integer(exit["signalNumber"], "signal number", 1, 64) };
}

function streamName(value: unknown): ProcessStreamName {
  const name = string(value, "process stream");
  if (name !== "stdout" && name !== "stderr" && name !== "output") throw new VMError("PROTOCOL_ERROR", "process stream is invalid");
  return name;
}

function chunk(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_PROCESS_CHUNK) throw new VMError("PROTOCOL_ERROR", "process chunk is invalid");
  return value;
}
