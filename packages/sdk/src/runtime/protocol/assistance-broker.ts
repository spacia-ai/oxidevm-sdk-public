import { validateAssistanceCredit, type AssistanceCredit } from "./assistance-credit.js";
import { boolean, exactKeys, integer, record } from "../decode.js";
import { decodeSerializedError, VMError, type SerializedError } from "../errors.js";
import { ASSISTANCE_LIMITS, decodeAssistanceBinding, decodeAssistanceIdentity, decodeAssistanceOperation, type AssistanceIdentity, type AssistanceOperation } from "./assistance.js";

import { decodeAssistanceEvent } from "./assistance-event.js";
import { decodeAssistanceReply } from "./assistance-reply.js";
import { decodeForkExecArgv, decodeForkReply, decodeForkRequest, type ForkReply, type ForkRequest } from "./assistance-fork.js";

/** Control, broker validation and process mailboxes share one internal codec.
 * Guest transport independently decodes its negotiated legacy/current dialect. */
export const BROKER_REPLY_VERSION = 7;

export type ChildSignal = "TERM" | "KILL" | "INT" | "HUP";
/** Signals a JavaScript child can end with; KILL retires it from control. */
export type ExitSignal = 1 | 2 | 9 | 15;
export type ForkTermination =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "signal"; readonly signal: ExitSignal }
  | { readonly kind: "error"; readonly error: SerializedError };

/** Fork events carry the parent's identity; `child` names the child process
 * control allocated. A child's own termination uses its own identity. */
export type BrokerEvent =
  | { readonly kind: "input-ack"; readonly identity: AssistanceIdentity; readonly sequence: number }
  | { readonly kind: "ready"; readonly identity: AssistanceIdentity }
  | { readonly kind: "request"; readonly identity: AssistanceIdentity; readonly operation: AssistanceOperation }
  | { readonly kind: "output"; readonly identity: AssistanceIdentity; readonly stream: "stdout" | "stderr"; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: "exit" | "exit-request"; readonly identity: AssistanceIdentity; readonly code: number }
  | { readonly kind: "exit-signal"; readonly identity: AssistanceIdentity; readonly signal: ExitSignal }
  | { readonly kind: "failed"; readonly identity: AssistanceIdentity; readonly error: SerializedError }
  | { readonly kind: "fork"; readonly identity: AssistanceIdentity; readonly request: ForkRequest }
  | { readonly kind: "fork-input"; readonly identity: AssistanceIdentity; readonly child: number; readonly bytes: Uint8Array<ArrayBuffer> | null }
  | { readonly kind: "fork-signal"; readonly identity: AssistanceIdentity; readonly child: number; readonly signal: ChildSignal }
  | { readonly kind: "fork-output-ack"; readonly identity: AssistanceIdentity; readonly child: number; readonly chunk: number };

function child(value: unknown): number { return integer(value, "fork child process", 1, 0xffff_ffff); }
function exitSignal(value: unknown): ExitSignal {
  if (value !== 1 && value !== 2 && value !== 9 && value !== 15) throw new VMError("PROTOCOL_ERROR", "Unsupported exit signal");
  return value;
}
function childSignal(value: unknown): ChildSignal {
  if (value !== "TERM" && value !== "KILL" && value !== "INT" && value !== "HUP") throw new VMError("PROTOCOL_ERROR", "Unsupported child signal");
  return value;
}
function chunkBytes(value: unknown, nullable: boolean): Uint8Array<ArrayBuffer> | null {
  if (value === null && nullable) return null;
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) || value.byteLength > ASSISTANCE_LIMITS.chunk) {
    throw new VMError("PROTOCOL_ERROR", "Invalid fork stream bytes");
  }
  return value.slice();
}

export function decodeBrokerEvent(value: unknown): BrokerEvent {
  const input = record(value, "assistance broker event");
  const identity = decodeAssistanceIdentity(input["identity"]);
  switch (input["kind"]) {
    case "input-ack":
      exactKeys(input, ["kind", "identity", "sequence"]);
      return { kind: "input-ack", identity, sequence: integer(input["sequence"], "input acknowledgement", 1, 0xffff_ffff) };
    case "ready":
      exactKeys(input, ["kind", "identity"]);
      return { kind: "ready", identity };
    case "request": {
      exactKeys(input, ["kind", "identity", "operation"]);
      const operation = decodeAssistanceOperation(input["operation"]);
      if (operation.kind === "start" || operation.kind === "stop" || operation.kind === "terminal-ack" || operation.kind === "check-dependencies" || operation.kind === "fork") {
        throw new VMError("PROTOCOL_ERROR", "Process workers cannot acquire or retire guest tasks");
      }
      return { kind: "request", identity, operation };
    }
    case "output": {
      exactKeys(input, ["kind", "identity", "stream", "bytes"]);
      const stream = input["stream"];
      const bytes = input["bytes"];
      if ((stream !== "stdout" && stream !== "stderr") || !(bytes instanceof Uint8Array)
        || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteLength > ASSISTANCE_LIMITS.chunk) {
        throw new VMError("PROTOCOL_ERROR", "Invalid assisted output");
      }
      return { kind: "output", identity, stream, bytes: bytes.slice() };
    }
    case "exit": case "exit-request":
      exactKeys(input, ["kind", "identity", "code"]);
      return { kind: input["kind"], identity, code: integer(input["code"], "assisted exit", 0, 255) };
    case "exit-signal":
      exactKeys(input, ["kind", "identity", "signal"]);
      return { kind: "exit-signal", identity, signal: exitSignal(input["signal"]) };
    case "failed":
      exactKeys(input, ["kind", "identity", "error"]);
      return { kind: "failed", identity, error: decodeSerializedError(input["error"]) };
    case "fork":
      exactKeys(input, ["kind", "identity", "request"]);
      return { kind: "fork", identity, request: decodeForkRequest(input["request"]) };
    case "fork-input":
      exactKeys(input, ["kind", "identity", "child", "bytes"]);
      return { kind: "fork-input", identity, child: child(input["child"]), bytes: chunkBytes(input["bytes"], true) };
    case "fork-signal":
      exactKeys(input, ["kind", "identity", "child", "signal"]);
      return { kind: "fork-signal", identity, child: child(input["child"]), signal: childSignal(input["signal"]) };
    case "fork-output-ack":
      exactKeys(input, ["kind", "identity", "child", "chunk"]);
      return { kind: "fork-output-ack", identity, child: child(input["child"]), chunk: integer(input["chunk"], "fork output chunk", 1, 0xffff_ffff) };
    default: throw new VMError("PROTOCOL_ERROR", "Unknown assistance broker event");
  }
}

export function decodeForkTermination(value: unknown): ForkTermination {
  const input = record(value, "fork termination");
  switch (input["kind"]) {
    case "exit": exactKeys(input, ["kind", "code"]); return { kind: "exit", code: integer(input["code"], "fork exit code", 0, 255) };
    case "signal": exactKeys(input, ["kind", "signal"]); return { kind: "signal", signal: exitSignal(input["signal"]) };
    case "error": exactKeys(input, ["kind", "error"]); return { kind: "error", error: decodeSerializedError(input["error"]) };
    default: throw new VMError("PROTOCOL_ERROR", "Unknown fork termination");
  }
}

export interface AssistedDependencyIdentity { readonly generation: string; readonly inputsSha256: string }

/** `parent`/`silent`/`execArgv` mark a fork child; the broker creates its
 * private IPC channel and hands one end to the parent worker as `fork-channel`. */
export type BrokerCommand =
  | { readonly kind: "start"; readonly identity: AssistanceIdentity; readonly entry: string; readonly cwd: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly dependencies?: AssistedDependencyIdentity; readonly parent?: number; readonly silent?: boolean; readonly execArgv?: readonly string[] }
  | { readonly kind: "input"; readonly identity: AssistanceIdentity; readonly bytes: Uint8Array<ArrayBuffer> | null }
  | { readonly kind: "reserve"; readonly identity: AssistanceIdentity; readonly credits: readonly AssistanceCredit[] }
  | { readonly kind: "stop"; readonly identity: AssistanceIdentity }
  | { readonly kind: "reply" | "event"; readonly identity: AssistanceIdentity; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: "fork-reply"; readonly identity: AssistanceIdentity; readonly reply: ForkReply }
  | { readonly kind: "fork-channel"; readonly identity: AssistanceIdentity; readonly child: number; readonly port: MessagePort }
  | { readonly kind: "fork-output"; readonly identity: AssistanceIdentity; readonly child: number; readonly stream: "stdout" | "stderr"; readonly bytes: Uint8Array<ArrayBuffer>; readonly chunk: number }
  | { readonly kind: "fork-exit"; readonly identity: AssistanceIdentity; readonly child: number; readonly termination: ForkTermination }
  | { readonly kind: "signal"; readonly identity: AssistanceIdentity; readonly signal: "TERM" | "INT" | "HUP" };

export function decodeBrokerCommand(value: unknown): BrokerCommand {
  const input = record(value, "assistance broker command");
  const identity = decodeAssistanceIdentity(input["identity"]);
  switch (input["kind"]) {
    case "start": {
      exactKeys(input, ["kind", "identity", "entry", "cwd", "args", "env"], ["dependencies", "parent", "silent", "execArgv"]);
      const operation = decodeAssistanceOperation({ kind: "spawn", command: input["entry"], cwd: input["cwd"], args: input["args"], env: input["env"] });
      if (operation.kind !== "spawn" || !operation.command.startsWith("/") || !operation.cwd.startsWith("/")) {
        throw new VMError("PROTOCOL_ERROR", "Assisted startup requires resolved guest paths");
      }
      let dependencies: AssistedDependencyIdentity | undefined;
      if (input["dependencies"] !== undefined) {
        const selected = record(input["dependencies"], "assisted dependency identity");
        exactKeys(selected, ["generation", "inputsSha256"]);
        const generation = selected["generation"]; const inputsSha256 = selected["inputsSha256"];
        if (typeof generation !== "string" || typeof inputsSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(generation) || !/^[a-f0-9]{64}$/u.test(inputsSha256)) {
          throw new VMError("PROTOCOL_ERROR", "Invalid assisted dependency identity");
        }
        dependencies = { generation, inputsSha256 };
      }
      const parent = input["parent"] === undefined ? undefined : child(input["parent"]);
      const silent = input["silent"] === undefined ? undefined : boolean(input["silent"], "fork silent flag");
      if (parent === identity.process) throw new VMError("PROTOCOL_ERROR", "A fork child cannot be its own parent");
      const execArgv = input["execArgv"] === undefined ? undefined : decodeForkExecArgv(input["execArgv"]);
      if ((silent !== undefined || execArgv !== undefined) && parent === undefined) throw new VMError("PROTOCOL_ERROR", "Only fork children carry silent or execArgv");
      return { kind: "start", identity, entry: operation.command, cwd: operation.cwd, args: operation.args, env: operation.env,
        ...(dependencies === undefined ? {} : { dependencies }), ...(parent === undefined ? {} : { parent }), ...(silent === undefined ? {} : { silent }),
        ...(execArgv === undefined ? {} : { execArgv }) };
    }
    case "input": {
      exactKeys(input, ["kind", "identity", "bytes"]);
      const bytes = input["bytes"];
      if (bytes !== null && (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.length > ASSISTANCE_LIMITS.chunk)) {
        throw new VMError("PROTOCOL_ERROR", "Invalid assisted input");
      }
      return { kind: "input", identity, bytes: bytes === null ? null : bytes.slice() };
    }
    case "reserve":
      exactKeys(input, ["kind", "identity", "credits"]);
      return { kind: "reserve", identity, credits: brokerCredits(input["credits"]) };
    case "stop":
      exactKeys(input, ["kind", "identity"]);
      return { kind: input["kind"], identity };
    case "fork-reply":
      exactKeys(input, ["kind", "identity", "reply"]);
      return { kind: "fork-reply", identity, reply: decodeForkReply(input["reply"]) };
    case "fork-channel": {
      exactKeys(input, ["kind", "identity", "child", "port"]);
      const port = input["port"];
      if (!(port instanceof MessagePort)) throw new VMError("PROTOCOL_ERROR", "Fork channel requires a message port");
      return { kind: "fork-channel", identity, child: child(input["child"]), port };
    }
    case "fork-output": {
      exactKeys(input, ["kind", "identity", "child", "stream", "bytes", "chunk"]);
      const stream = input["stream"];
      if (stream !== "stdout" && stream !== "stderr") throw new VMError("PROTOCOL_ERROR", "Invalid fork output stream");
      const bytes = chunkBytes(input["bytes"], false);
      if (bytes === null) throw new VMError("PROTOCOL_ERROR", "Invalid fork output bytes");
      return { kind: "fork-output", identity, child: child(input["child"]), stream, bytes, chunk: integer(input["chunk"], "fork output chunk", 1, 0xffff_ffff) };
    }
    case "fork-exit":
      exactKeys(input, ["kind", "identity", "child", "termination"]);
      return { kind: "fork-exit", identity, child: child(input["child"]), termination: decodeForkTermination(input["termination"]) };
    case "signal": {
      exactKeys(input, ["kind", "identity", "signal"]);
      const signal = childSignal(input["signal"]);
      if (signal === "KILL") throw new VMError("PROTOCOL_ERROR", "KILL retires a worker from control; it is never delivered");
      return { kind: "signal", identity, signal };
    }
    case "reply": case "event": {
      exactKeys(input, ["kind", "identity", "bytes"]);
      const bytes = input["bytes"];
      if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteLength > ASSISTANCE_LIMITS.request) {
        throw new VMError("PROTOCOL_ERROR", "Invalid broker reply bytes");
      }
      const owned = bytes.slice();
      const reply = input["kind"] === "reply" ? decodeAssistanceReply(owned, BROKER_REPLY_VERSION) : decodeAssistanceEvent(owned);
      if (reply.session !== identity.session || reply.generation !== identity.generation
        || reply.process !== identity.process || (input["kind"] === "reply" && reply.sequence !== identity.sequence)) {
        throw new VMError("PROTOCOL_ERROR", "Broker reply identity mismatch");
      }
      return { kind: input["kind"], identity, bytes: owned };
    }
    default: throw new VMError("PROTOCOL_ERROR", "Unknown assistance broker command");
  }
}

export function decodeBrokerFailure(value: unknown) {
  const input = record(value, "broker failure");
  exactKeys(input, ["kind", "binding", "error"]);
  if (input["kind"] !== "broker-failed") throw new VMError("PROTOCOL_ERROR", "Invalid broker failure");
  return { binding: decodeAssistanceBinding(input["binding"]), error: decodeSerializedError(input["error"]) };
}

/** Control's first command to a broker it attaches with host attention: the port that receives one
 * notice before every message the broker posts to control (`../host-attention.ts`). */
export function decodeBrokerAttention(value: unknown): { readonly binding: ReturnType<typeof decodeAssistanceBinding>; readonly port: MessagePort } {
  const input = record(value, "broker attention");
  exactKeys(input, ["kind", "binding", "port"]);
  const port = input["port"];
  if (input["kind"] !== "attention" || !(port instanceof MessagePort)) throw new VMError("PROTOCOL_ERROR", "Invalid broker attention");
  return { binding: decodeAssistanceBinding(input["binding"]), port };
}

export function decodeBrokerHeartbeat(value: unknown) {
  const input = record(value, "broker heartbeat");
  exactKeys(input, ["kind", "binding", "sequence"]);
  const kind = input["kind"];
  if (kind !== "ping" && kind !== "pong") throw new VMError("PROTOCOL_ERROR", "Invalid broker heartbeat");
  return { kind, binding: decodeAssistanceBinding(input["binding"]), sequence: integer(input["sequence"], "heartbeat sequence", 1, 0xffff_ffff) };
}

function brokerCredits(value: unknown): readonly AssistanceCredit[] {
  if (!Array.isArray(value) || value.length !== 2) throw new VMError("PROTOCOL_ERROR", "Invalid broker credits");
  return value.map((value: unknown) => validateAssistanceCredit(value));
}

export function decodeBrokerRetired(value: unknown) {
  const input = record(value, "broker retirement");
  exactKeys(input, ["kind", "identity", "credits"]);
  if (input["kind"] !== "retired") throw new VMError("PROTOCOL_ERROR", "Invalid broker retirement");
  return { identity: decodeAssistanceIdentity(input["identity"]), credits: brokerCredits(input["credits"]) };
}

export function decodeBrokerShutdown(value: unknown) {
  const input = record(value, "broker shutdown");
  exactKeys(input, ["kind", "binding", "sequence"]);
  const kind = input["kind"];
  if (kind !== "shutdown" && kind !== "stopped") throw new VMError("PROTOCOL_ERROR", "Invalid broker shutdown");
  return { kind, binding: decodeAssistanceBinding(input["binding"]), sequence: integer(input["sequence"], "shutdown sequence", 1, 0xffff_ffff) };
}
