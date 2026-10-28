import { AgentPayloadReader, AgentPayloadWriter } from "../agent-protocol.js";
import { exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeAssistanceBinding, type AssistanceBinding } from "./assistance.js";

export interface AssistanceVmRequest extends AssistanceBinding {
  readonly sequence: number;
  readonly operation: "bind" | "fence" | "ping" | "abort";
}

function decode(value: unknown): AssistanceVmRequest {
  const input = record(value, "assistance VM request");
  exactKeys(input, ["session", "generation", "sequence", "operation"]);
  const operation = input["operation"];
  if (operation !== "bind" && operation !== "fence" && operation !== "ping" && operation !== "abort") throw new VMError("PROTOCOL_ERROR", "Unknown assistance VM operation");
  return { ...decodeAssistanceBinding({ session: input["session"], generation: input["generation"] }),
    sequence: integer(input["sequence"], "VM sequence", 1, 0xffff_ffff), operation };
}

export function encodeAssistanceVmRequest(value: unknown): Uint8Array<ArrayBuffer> {
  const request = decode(value);
  return new AgentPayloadWriter(49).string(request.session).u32(request.generation).u32(request.sequence)
    .u8(request.operation === "bind" ? 1 : request.operation === "fence" ? 2 : request.operation === "ping" ? 3 : 4).finish();
}

export function decodeAssistanceVmRequest(bytes: Uint8Array): AssistanceVmRequest {
  if (bytes.length !== 49) throw new VMError("PROTOCOL_ERROR", "Invalid assistance VM envelope length");
  const input = new AgentPayloadReader(bytes);
  const session = input.string(); const generation = input.u32(); const sequence = input.u32();
  const tag = input.u8(); input.finish();
  return decode({ session, generation, sequence, operation: tag === 1 ? "bind" : tag === 2 ? "fence" : tag === 3 ? "ping" : tag === 4 ? "abort" : undefined });
}

export function matchAssistanceVmReply(request: AssistanceVmRequest, bytes: Uint8Array): void {
  const reply = decodeAssistanceVmRequest(bytes);
  if (reply.session !== request.session || reply.generation !== request.generation
    || reply.sequence !== request.sequence || reply.operation !== request.operation) {
    throw new VMError("PROTOCOL_ERROR", "Wrong or stale assistance VM completion");
  }
}
