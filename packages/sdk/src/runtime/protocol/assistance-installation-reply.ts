import { AgentPayloadReader, AgentPayloadWriter } from "../agent-protocol.js";
import { exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";
import { ASSISTANCE_LIMITS, decodeAssistanceBinding, type AssistanceBinding } from "./assistance.js";
import type { InstallationRequest } from "./assistance-installation.js";

export interface InstallationReply extends AssistanceBinding {
  readonly installation: number;
  readonly sequence: number;
  readonly result: { readonly kind: "ready"; readonly port: number }
    | { readonly kind: "stopped" | "unit" | "retired" | "materialized" }
    | { readonly kind: "capture-ready"; readonly bytes: number }
    | { readonly kind: "capture-retired"; readonly errno: number }
    | { readonly kind: "spawned"; readonly child: number; readonly pid: number }
    | { readonly kind: "acknowledged" }
    | { readonly kind: "data"; readonly bytes: Uint8Array }
    | { readonly kind: "written"; readonly count: number }
    | { readonly kind: "error"; readonly errno: number };
}
function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Invalid installation reply"); }
function decode(value: unknown): InstallationReply {
  const input = record(value, "installation reply");
  exactKeys(input, ["session", "generation", "installation", "sequence", "result"]);
  const common = { ...decodeAssistanceBinding({ session: input["session"], generation: input["generation"] }),
    installation: integer(input["installation"], "installation identity", 1, 0xffff_ffff),
    sequence: integer(input["sequence"], "installation sequence", 1, 0xffff_ffff) };
  const result = record(input["result"], "installation result");
  switch (result["kind"]) {
    case "capture-ready":
      exactKeys(result, ["kind", "bytes"]);
      return { ...common, result: { kind: "capture-ready", bytes: integer(result["bytes"], "capture bytes", 0, 2 ** 40) } };
    case "capture-retired":
      exactKeys(result, ["kind", "errno"]);
      return { ...common, result: { kind: "capture-retired", errno: integer(result["errno"], "capture errno", 0, 4095) } };
    case "ready":
      exactKeys(result, ["kind", "port"]);
      return { ...common, result: { kind: "ready", port: integer(result["port"], "gateway port", 1, 65535) } };
    case "spawned":
      exactKeys(result, ["kind", "child", "pid"]);
      return { ...common, result: { kind: "spawned", child: integer(result["child"], "child", 1, 0xffff_ffff), pid: integer(result["pid"], "native pid", 1, 0x7fff_ffff) } };
    case "materialized": case "retired": case "unit": case "stopped": case "acknowledged":
      exactKeys(result, ["kind"]);
      return { ...common, result: { kind: result["kind"] } };
    case "written":
      exactKeys(result, ["kind", "count"]);
      return { ...common, result: { kind: "written", count: integer(result["count"], "installation write count", 0, ASSISTANCE_LIMITS.chunk) } };
    case "error":
      exactKeys(result, ["kind", "errno"]);
      return { ...common, result: { kind: "error", errno: integer(result["errno"], "installation errno", 1, 4095) } };
    case "data": {
      exactKeys(result, ["kind", "bytes"]);
      const bytes = result["bytes"];
      if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.length > ASSISTANCE_LIMITS.chunk) invalid();
      return { ...common, result: { kind: "data", bytes } };
    }
    default: return invalid();
  }
}
export function encodeInstallationReply(value: unknown, version: number): Uint8Array<ArrayBuffer> {
  if (version !== 6 && version !== 7) invalid();
  const reply = decode(value);
  const output = new AgentPayloadWriter(57 + ASSISTANCE_LIMITS.chunk).string(reply.session)
    .u32(reply.generation).u32(reply.installation).u32(reply.sequence);
  const result = reply.result;
  switch (result.kind) {
    case "ready": output.u8(1).u32(result.port); break;
    case "stopped": output.u8(2); break;
    case "retired": output.u8(9); break;
    case "materialized": output.u8(10); break;
    case "capture-ready": output.u8(11).u64(BigInt(result.bytes)); break;
    case "capture-retired": output.u8(12).u32(result.errno); break;
    case "unit": output.u8(8); break;
    case "spawned": output.u8(7).u32(result.child).u32(result.pid); break;
    case "acknowledged": output.u8(6); break;
    case "data": output.u8(3).bytes(result.bytes); break;
    case "written": output.u8(4).u32(result.count); break;
    case "error": output.u8(5).u32(result.errno); break;
  }
  return output.finish();
}
export function decodeInstallationReply(bytes: Uint8Array, version: number): InstallationReply {
  if ((version !== 6 && version !== 7) || bytes.length < 53 || bytes.length > 57 + ASSISTANCE_LIMITS.chunk) invalid();
  const input = new AgentPayloadReader(bytes);
  const common = { session: input.string(), generation: input.u32(), installation: input.u32(), sequence: input.u32() };
  let result: InstallationReply["result"];
  switch (input.u8()) {
    case 1: result = { kind: "ready", port: input.u32() }; break;
    case 2: result = { kind: "stopped" }; break;
    case 9: result = { kind: "retired" }; break;
    case 10: result = { kind: "materialized" }; break;
    case 11: result = { kind: "capture-ready", bytes: Number(input.u64()) }; break;
    case 12: result = { kind: "capture-retired", errno: input.u32() }; break;
    case 6: result = { kind: "acknowledged" }; break;
    case 7: result = { kind: "spawned", child: input.u32(), pid: input.u32() }; break;
    case 8: result = { kind: "unit" }; break;
    case 3: result = { kind: "data", bytes: input.bytes() }; break;
    case 4: result = { kind: "written", count: input.u32() }; break;
    case 5: result = { kind: "error", errno: input.u32() }; break;
    default: return invalid();
  }
  input.finish();
  const reply = decode({ ...common, result });
  const encoded = encodeInstallationReply(reply, version);
  if (encoded.length !== bytes.length || encoded.some((byte, index) => byte !== bytes[index])) invalid();
  return reply;
}
export function installationReplyMatches(request: InstallationRequest, reply: InstallationReply): boolean {
  if (request.session !== reply.session || request.generation !== reply.generation
    || request.installation !== reply.installation || request.sequence !== reply.sequence) return false;
  const result = reply.result;
  if (result.kind === "error") return true;
  switch (request.operation.kind) {
    case "start": return result.kind === "ready";
    case "blocked-builds": return result.kind === "data" && result.bytes.length <= 65_536;
    case "validate-inputs": case "check-current": return result.kind === "data" && result.bytes.length === 64;
    case "execute": return result.kind === "spawned";
    case "set-build-policy": case "activate-materialized": case "close-stdin": case "signal": case "output-ack": return result.kind === "unit";
    case "stdin": return result.kind === "written" && result.count <= request.operation.bytes.length;
    case "stop": return result.kind === "stopped";
    case "retire": return result.kind === "retired";
    case "materialize": return result.kind === "materialized";
    case "workspace-capture": case "capture": return result.kind === "capture-ready";
    case "workspace-capture-retire": case "capture-retire": return result.kind === "capture-retired";
    case "acknowledge": return result.kind === "acknowledged";
    case "workspace-capture-read": case "capture-read": case "read": return result.kind === "data" && result.bytes.length <= request.operation.length;
    case "write": return result.kind === "written" && result.count <= request.operation.bytes.length;
  }
}
