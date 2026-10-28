import { AgentPayloadReader, AgentPayloadWriter } from "../agent-protocol.js";
import { exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";
import { ASSISTANCE_LIMITS, decodeAssistanceIdentity, type AssistanceIdentity } from "./assistance.js";

export type AssistanceChildEvent =
  | { readonly kind: "failure"; readonly errno: number }
  | { readonly kind: "output"; readonly child: number; readonly stream: "stdout" | "stderr"; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly kind: "eof"; readonly child: number; readonly stream: "stdout" | "stderr" }
  | { readonly kind: "exit"; readonly child: number; readonly code: number; readonly signal: null }
  | { readonly kind: "exit"; readonly child: number; readonly code: null; readonly signal: number };
export interface AssistanceEvent extends AssistanceIdentity { readonly event: AssistanceChildEvent }

function fail(message: string): never { throw new VMError("PROTOCOL_ERROR", message); }
function stream(value: unknown): "stdout" | "stderr" {
  if (value !== "stdout" && value !== "stderr") fail("invalid child stream");
  return value;
}
function event(value: unknown): AssistanceChildEvent {
  const input = record(value, "assistance child event");
  const kind = input["kind"];
  if (kind === "failure") { exactKeys(input, ["kind", "errno"]); return { kind, errno: integer(input["errno"], "task failure errno", 1, 4095) }; }
  const child = integer(input["child"], "child handle", 1, 0xffff_ffff);
  switch (kind) {
    case "output": {
      exactKeys(input, ["kind", "child", "stream", "bytes"]);
      const bytes = input["bytes"];
      if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > ASSISTANCE_LIMITS.chunk) fail("invalid child output length");
      return { kind, child, stream: stream(input["stream"]), bytes: new Uint8Array(bytes) };
    }
    case "eof": exactKeys(input, ["kind", "child", "stream"]); return { kind, child, stream: stream(input["stream"]) };
    case "exit": {
      exactKeys(input, ["kind", "child", "code", "signal"]);
      if (input["signal"] === null) return { kind, child, code: integer(input["code"], "child exit code", 0, 255), signal: null };
      if (input["code"] === null) return { kind, child, code: null, signal: integer(input["signal"], "child exit signal", 1, 64) };
      return fail("ambiguous child exit");
    }
    default: return fail("unknown child event");
  }
}

export function encodeAssistanceEvent(value: unknown): Uint8Array<ArrayBuffer> {
  const input = record(value, "assistance event");
  exactKeys(input, ["session", "generation", "process", "sequence", "event"]);
  const identity = decodeAssistanceIdentity({ session: input["session"], generation: input["generation"], process: input["process"], sequence: input["sequence"] });
  const output = new AgentPayloadWriter(ASSISTANCE_LIMITS.request).string(identity.session).u32(identity.generation).u32(identity.process).u32(identity.sequence);
  writeChildEvent(output, input["event"]);
  return output.finish();
}

export function decodeAssistanceEvent(bytes: Uint8Array): AssistanceEvent {
  if (bytes.byteLength > ASSISTANCE_LIMITS.request) fail("assistance event exceeds limit");
  const input = new AgentPayloadReader(new Uint8Array(bytes));
  const identity = decodeAssistanceIdentity({ session: input.string(), generation: input.u32(), process: input.u32(), sequence: input.u32() });
  const decoded = readChildEvent(input);
  input.finish();
  return { ...identity, event: decoded };
}

export function writeChildEvent(output: AgentPayloadWriter, value: unknown): void {
  const decoded = event(value);
  switch (decoded.kind) {
    case "failure": output.u8(4).u32(decoded.errno); break;
    case "output": output.u8(1).u32(decoded.child).u8(decoded.stream === "stdout" ? 1 : 2).bytes(decoded.bytes); break;
    case "eof": output.u8(2).u32(decoded.child).u8(decoded.stream === "stdout" ? 1 : 2); break;
    case "exit": output.u8(3).u32(decoded.child).u8(decoded.code === null ? 1 : 0).u8(decoded.code ?? decoded.signal); break;
  }
}

export function readChildEvent(input: AgentPayloadReader): AssistanceChildEvent {
  const tag = input.u8();
  if (tag === 4) return event({ kind: "failure", errno: input.u32() });
  const child = input.u32();
  let decoded: AssistanceChildEvent;
  if (tag === 1 || tag === 2) {
    const output = input.u8();
    if (output !== 1 && output !== 2) fail("invalid child stream tag");
    const stream = output === 1 ? "stdout" : "stderr";
    decoded = event(tag === 1 ? { kind: "output", child, stream, bytes: input.bytes() } : { kind: "eof", child, stream });
  } else if (tag === 3) {
    const exit = input.u8();
    if (exit !== 0 && exit !== 1) fail("invalid child exit tag");
    const value = input.u8();
    decoded = event({ kind: "exit", child, code: exit === 0 ? value : null, signal: exit === 1 ? value : null });
  } else return fail("unknown child event tag");
  return decoded;
}
