import { validateAssistanceCredit, type AssistanceCredit } from "./assistance-credit.js";
import { decodeAssistanceArtifacts, type AssistanceArtifacts } from "../assistance-artifacts.js";
import { exactKeys, record, string } from "../decode.js";
import { decodeSerializedError, VMError, type SerializedError } from "../errors.js";
import { decodeAssistanceBinding, type AssistanceBinding } from "./assistance-control.js";

export interface AssistanceBootstrap {
  readonly kind: "assistance-bootstrap";
  readonly binding: AssistanceBinding;
  readonly nonce: string;
  readonly artifacts: AssistanceArtifacts;
  readonly port: MessagePort;
  readonly credits?: readonly AssistanceCredit[];
}
export function decodeAssistanceBootstrap(value: unknown): AssistanceBootstrap {
  const input = record(value, "assistance bootstrap");
  exactKeys(input, ["kind", "binding", "nonce", "artifacts", "port"], ["credits"]);
  if (input["kind"] !== "assistance-bootstrap" || !(input["port"] instanceof MessagePort)) {
    throw new VMError("PROTOCOL_ERROR", "Invalid assistance bootstrap port");
  }
  const binding = decodeAssistanceBinding(input["binding"]);
  const artifacts = decodeAssistanceArtifacts(input["artifacts"]);
  return { kind: "assistance-bootstrap", binding, artifacts,
    nonce: nonce(input["nonce"]), port: input["port"],
    ...(input["credits"] === undefined ? {} : { credits: decodeBootstrapCredits(input["credits"], binding, artifacts.runtime.bytes) }) };

}
export function decodeAssistanceBootstrapResult(value: unknown):
  | { readonly kind: "broker-ready"; readonly binding: AssistanceBinding; readonly nonce: string; readonly receipt?: AssistanceCredit }
  | { readonly kind: "bootstrap-failed"; readonly binding: AssistanceBinding; readonly nonce: string; readonly error: SerializedError } {
  const input = record(value, "assistance bootstrap result");
  const binding = decodeAssistanceBinding(input["binding"]);
  const token = nonce(input["nonce"]);
  if (input["kind"] === "broker-ready") {
    exactKeys(input, ["kind", "binding", "nonce"], ["receipt"]);
    const receipt = input["receipt"] === undefined ? undefined : validateAssistanceCredit(input["receipt"]);
    if (receipt !== undefined && (receipt.kind !== "return" || receipt.producer !== "bootstrap"
      || receipt.pool !== "data" || receipt.session !== binding.session || receipt.generation !== binding.generation)) {
      throw new VMError("PROTOCOL_ERROR", "Invalid bootstrap credit receipt");
    }
    return { kind: "broker-ready" as const, binding, nonce: token, ...(receipt === undefined ? {} : { receipt }) };
  }
  if (input["kind"] === "bootstrap-failed") {
    exactKeys(input, ["kind", "binding", "nonce", "error"]);
    return { kind: "bootstrap-failed" as const, binding, nonce: token, error: decodeSerializedError(input["error"]) };
  }
  throw new VMError("PROTOCOL_ERROR", "Unknown assistance bootstrap result");
}
function nonce(value: unknown): string {
  const token = string(value, "bootstrap nonce");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(token)) {
    throw new VMError("PROTOCOL_ERROR", "Invalid bootstrap nonce");
  }
  return token;
}

export function decodeBootstrapCredits(value: unknown, binding: AssistanceBinding, runtimeBytes: number): readonly AssistanceCredit[] {
  if (!Array.isArray(value) || value.length !== 2) throw new VMError("PROTOCOL_ERROR", "Missing bootstrap grants");
  const credits = value.map((value: unknown) => validateAssistanceCredit(value));
  for (const [index, credit] of credits.entries()) {
    if (credit.kind !== "grant" || credit.producer !== "bootstrap" || credit.pool !== "data"
      || credit.session !== binding.session || credit.generation !== binding.generation
      || credit.bytes !== (index === 0 ? runtimeBytes : 2 * runtimeBytes + 4096)
      || credit.entries !== (index === 0 ? 1 : 32)) {
      throw new VMError("PROTOCOL_ERROR", "Bootstrap grant does not match its artifact");
    }
  }
  if (credits[0]?.reservation === credits[1]?.reservation || credits[0]?.sequence === credits[1]?.sequence) {
    throw new VMError("PROTOCOL_ERROR", "Duplicate bootstrap grant");
  }
  return credits;
}
