import { AgentPayloadReader, AgentPayloadWriter } from "../agent-protocol.js";
import { exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";
import { ASSISTANCE_LIMITS, decodeAssistanceBinding, type AssistanceBinding } from "./assistance.js";

interface CreditEnvelope extends AssistanceBinding {
  /** Issuer correlation echoed by returns; outer transports sequence delivery independently. */
  readonly sequence: number;
  readonly kind: "grant" | "return";
  readonly pool: "data" | "control";
  readonly reservation: number;
  /** Encoded bytes and simultaneous copies, not just application payload bytes. */
  readonly bytes: number;
  readonly entries: number;
}
export type AssistanceCredit = CreditEnvelope & (
  | { readonly producer: "bootstrap" | "network" | "storage" | "installation" | "installation-gateway" | "installation-process"; readonly process: null }
  | { readonly producer: "broker" | "guest" | "watch" | "ipc" | "socket"; readonly process: number }
);

const PRODUCERS = ["bootstrap", "broker", "guest", "network", "storage", "installation", "watch", "ipc", "socket", "installation-gateway", "installation-process"] as const;

function fail(): never { throw new VMError("PROTOCOL_ERROR", "Invalid assistance credit envelope"); }
function id(value: unknown): number { return integer(value, "credit identity", 1, 0xffff_ffff); }

export function validateAssistanceCredit(value: unknown, version: 5 | 6 | 7 = 5): AssistanceCredit {
  const input = record(value, "assistance credit");
  exactKeys(input, ["session", "generation", "sequence", "kind", "producer", "pool", "process", "reservation", "bytes", "entries"]);
  const kind = input["kind"]; const producer = input["producer"]; const pool = input["pool"];
  if ((kind !== "grant" && kind !== "return") || (pool !== "data" && pool !== "control")) fail();
  const envelope: CreditEnvelope = {
    ...decodeAssistanceBinding({ session: input["session"], generation: input["generation"] }),
    sequence: id(input["sequence"]), kind, pool, reservation: id(input["reservation"]),
    bytes: integer(input["bytes"], "credit bytes", 1, pool === "control" ? ASSISTANCE_LIMITS.stream : ASSISTANCE_LIMITS.pending - ASSISTANCE_LIMITS.stream),
    entries: integer(input["entries"], "credit entries", 1, pool === "control" ? 1024 : 4096),
  };
  if (version === 5 && producer !== "bootstrap" && producer !== "broker" && producer !== "guest") fail();
  if (producer === "bootstrap" || producer === "network" || producer === "storage" || producer === "installation" || producer === "installation-gateway" || producer === "installation-process") {
    if (input["process"] !== null) fail();
    return { ...envelope, producer, process: null };
  }
  if (producer !== "broker" && producer !== "guest" && producer !== "watch" && producer !== "ipc" && producer !== "socket") fail();
  return { ...envelope, producer, process: id(input["process"]) };
}

export function encodeAssistanceCredit(value: unknown, version: 5 | 6 | 7 = 5): Uint8Array<ArrayBuffer> {
  const credit = validateAssistanceCredit(value, version);
  const out = new AgentPayloadWriter(68).string(credit.session).u32(credit.generation).u32(credit.sequence)
    .u8(credit.kind === "grant" ? 0 : 1).u8(PRODUCERS.indexOf(credit.producer))
    .u8(credit.pool === "data" ? 0 : 1).u8(credit.process === null ? 0 : 1);
  if (credit.process !== null) out.u32(credit.process);
  return out.u32(credit.reservation).u32(credit.bytes).u32(credit.entries).finish();
}

export function decodeAssistanceCredit(bytes: Uint8Array, version: 5 | 6 | 7 = 5): AssistanceCredit {
  if (bytes.length !== 64 && bytes.length !== 68) fail();
  const input = new AgentPayloadReader(new Uint8Array(bytes));
  const session = input.string(); const generation = input.u32(); const sequence = input.u32();
  const kind = input.u8(); const producer = input.u8(); const pool = input.u8(); const scope = input.u8();
  if (scope !== 0 && scope !== 1) fail();
  const process = scope === 0 ? null : input.u32();
  const reservation = input.u32(); const size = input.u32(); const entries = input.u32();
  input.finish();
  return validateAssistanceCredit({ session, generation, sequence,
    kind: kind === 0 ? "grant" : kind === 1 ? "return" : undefined,
    producer: PRODUCERS[producer],
    pool: pool === 0 ? "data" : pool === 1 ? "control" : undefined,
    process, reservation, bytes: size, entries }, version);
}

export function matchAssistanceCreditReply(request: AssistanceCredit, bytes: Uint8Array, version: 5 | 6 | 7 = 5): AssistanceCredit {
  const actual = decodeAssistanceCredit(bytes, version);
  const expected = encodeAssistanceCredit(request, version);
  if (bytes.length !== expected.length || bytes.some((value, index) => value !== expected[index])) {
    throw new VMError("PROTOCOL_ERROR", "Assistance credit reply does not match its reservation");
  }
  return actual;
}
