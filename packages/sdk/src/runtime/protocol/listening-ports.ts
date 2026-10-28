// Listening ports of a full-system guest (ADR 0015, capability 64): the page asks the control
// worker to watch them over a port of its own, or for one list, and decodes what comes back.
import { boolean, exactKeys, integer, record, string } from "../decode.js";
import { decodeSerializedError, VMError, type SerializedError } from "../errors.js";
import { MAX_LISTENING_PORTS, MAX_LISTENING_PROGRAM_LENGTH } from "../listening-ports.js";
import type { ListeningPort } from "../vm-types.js";
import { decodeUndefined } from "./decoders.js";
import { PROTOCOL_VERSION } from "./common.js";

/** Longest address text: a full IPv6 address with an IPv4 tail is 45 characters. */
const MAX_ADDRESS_LENGTH = 45;

export interface ListenerControlOperations {
  readonly "agent-listeners-watch": { readonly request: { readonly port: MessagePort }; readonly response: undefined };
  readonly "agent-listeners-unwatch": { readonly request: undefined; readonly response: undefined };
  readonly "agent-listeners-list": { readonly request: undefined; readonly response: readonly ListeningPort[] };
}

type Base = { readonly id: number; readonly version: typeof PROTOCOL_VERSION };

export type ListenerControlRequest =
  | (Base & { readonly type: "agent-listeners-watch"; readonly port: MessagePort })
  | (Base & { readonly type: "agent-listeners-unwatch" | "agent-listeners-list" });

/** What the control worker posts on a watching page's port. */
export type ListeningPortsMessage =
  | { readonly type: "ports"; readonly ports: readonly ListeningPort[] }
  | { readonly type: "failed"; readonly error: SerializedError };

export const listenerResponseDecoders = {
  "agent-listeners-watch": decodeUndefined,
  "agent-listeners-unwatch": decodeUndefined,
  "agent-listeners-list": decodeListeningPorts,
};

export function isListenerControlType(type: string): type is keyof ListenerControlOperations {
  return type === "agent-listeners-watch" || type === "agent-listeners-unwatch" || type === "agent-listeners-list";
}

export function decodeListenerControl(value: unknown): ListenerControlRequest {
  const input = record(value, "listener control request");
  const id = integer(input["id"], "request id", 1);
  integer(input["version"], "protocol version", PROTOCOL_VERSION, PROTOCOL_VERSION);
  const base: Base = { id, version: PROTOCOL_VERSION };
  const type = string(input["type"], "listener control operation");
  switch (type) {
    case "agent-listeners-watch": {
      exactKeys(input, ["id", "version", "type", "port"]);
      const port = input["port"];
      if (!(port instanceof MessagePort)) throw new VMError("PROTOCOL_ERROR", "the listener watch port must be a MessagePort");
      return { ...base, type, port };
    }
    case "agent-listeners-unwatch":
    case "agent-listeners-list":
      exactKeys(input, ["id", "version", "type"]);
      return { ...base, type };
    default:
      throw new VMError("PROTOCOL_ERROR", "unknown listener control operation");
  }
}

/** A list of listening ports, as the control worker sends it: at most 256 exact entries. */
export function decodeListeningPorts(value: unknown): readonly ListeningPort[] {
  if (!Array.isArray(value)) throw new VMError("PROTOCOL_ERROR", "listening ports must be a list");
  const entries: readonly unknown[] = value;
  if (entries.length > MAX_LISTENING_PORTS) throw new VMError("PROTOCOL_ERROR", "the listening-port list is too long");
  return entries.map(decodeListeningPort);
}

export function decodeListeningPortsMessage(value: unknown): ListeningPortsMessage {
  const input = record(value, "listening-port message");
  const type = string(input["type"], "listening-port message type");
  switch (type) {
    case "ports":
      exactKeys(input, ["type", "ports"]);
      return { type, ports: decodeListeningPorts(input["ports"]) };
    case "failed":
      exactKeys(input, ["type", "error"]);
      return { type, error: decodeSerializedError(input["error"]) };
    default:
      throw new VMError("PROTOCOL_ERROR", "unknown listening-port message");
  }
}

function decodeListeningPort(value: unknown): ListeningPort {
  const input = record(value, "listening port");
  exactKeys(input, ["port", "address", "program", "previewable"]);
  const address = string(input["address"], "listening address");
  if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH) throw new VMError("PROTOCOL_ERROR", "a listening address is invalid");
  const program = input["program"] === null ? null : string(input["program"], "listening program");
  if (program !== null && program.length > MAX_LISTENING_PROGRAM_LENGTH) throw new VMError("PROTOCOL_ERROR", "a listening program is too long");
  return {
    port: integer(input["port"], "listening port", 1, 65_535),
    address,
    program,
    previewable: boolean(input["previewable"], "previewable"),
  };
}
