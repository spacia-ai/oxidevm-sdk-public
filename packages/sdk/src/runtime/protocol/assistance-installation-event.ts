import { AgentPayloadReader, AgentPayloadWriter } from "../agent-protocol.js";
import { exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";
import { ASSISTANCE_LIMITS, decodeAssistanceBinding, type AssistanceBinding } from "./assistance.js";
import { readChildEvent, writeChildEvent, type AssistanceChildEvent } from "./assistance-event.js";

export interface InstallationEvent extends AssistanceBinding {
  readonly installation: number;
  readonly sequence: number;
  readonly event: AssistanceChildEvent;
}

function installationDialect(version: number): void {
  if (version !== 6 && version !== 7) throw new VMError("PROTOCOL_ERROR", "Installation child events require guest six or seven");
}

export function encodeInstallationEvent(value: unknown, version: number): Uint8Array<ArrayBuffer> {
  installationDialect(version);
  const input = record(value, "installation event");
  exactKeys(input, ["session", "generation", "installation", "sequence", "event"]);
  const binding = decodeAssistanceBinding({ session: input["session"], generation: input["generation"] });
  const installation = integer(input["installation"], "installation", 1, 0xffff_ffff);
  const sequence = integer(input["sequence"], "installation event sequence", 1, 0xffff_ffff);
  const output = new AgentPayloadWriter(ASSISTANCE_LIMITS.request)
    .string(binding.session).u32(binding.generation).u32(installation).u32(sequence);
  writeChildEvent(output, input["event"]);
  return output.finish();
}

export function decodeInstallationEvent(bytes: Uint8Array, version: number): InstallationEvent {
  installationDialect(version);
  if (bytes.length > ASSISTANCE_LIMITS.request) throw new VMError("PROTOCOL_ERROR", "Installation event exceeds limit");
  const input = new AgentPayloadReader(new Uint8Array(bytes));
  const binding = decodeAssistanceBinding({ session: input.string(), generation: input.u32() });
  const installation = integer(input.u32(), "installation", 1, 0xffff_ffff);
  const sequence = integer(input.u32(), "installation event sequence", 1, 0xffff_ffff);
  const event = readChildEvent(input);
  input.finish();
  return { ...binding, installation, sequence, event };
}
