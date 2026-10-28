import type { AgentProtocolVersion } from "../../agent-protocol.js";
import { requireKnownAgentCapabilities } from "../../agent-protocol.js";
import { VMError } from "../../errors.js";
import { MAX_RESUME_OUTBOUND_BYTES } from "./agent-input.js";

const MAGIC = [0x4f, 0x58, 0x48, 0x41]; // "OXHA"
const VERSION = 1;
/** Partial guest→host bytes a resumed decoder replays (`AgentDecoder.resumeInbound`). */
const MAX_INBOUND_BYTES = 1024 * 1024;
const MAX_PROCESSES = 256;
/** The newest output a process or the console keeps for a resumed screen. */
export const MAX_RESUME_TAIL_BYTES = 64 * 1024;
/** A relayed process's command line, as a resumed page names it. */
export const MAX_RESUME_COMMAND_BYTES = 4096;

/** A guest process the host relayed when the snapshot was taken, adoptable after a restore. */
export interface AdoptableProcess {
  /** The spawn request whose output frames the process sends. */
  readonly agentRequestId: number;
  readonly pid: number;
  readonly terminal: boolean;
  readonly stdinOpen: boolean;
  /** The command line it was spawned with, at most 4 KiB of UTF-8. */
  readonly command: string;
  /** The newest output the process produced, at most 64 KiB. */
  readonly tail: Uint8Array;
}

/**
 * OXHA v1: the host side of a guest-agent session at a snapshot's cut. The guest side is in the
 * snapshot's RAM; this record lets the host continue the same session after a restore.
 */
export interface AgentResumeState {
  /** The negotiated frame dialect, or null when the agent had not announced itself. */
  readonly dialect: AgentProtocolVersion | null;
  /** The HELLO capability bits. */
  readonly capabilities: number;
  /** The next request id; replies to lower ids the host no longer waits for are dropped. */
  readonly nextRequestId: number;
  /**
   * Guest→host bytes since the host's decoder was last idle: replaying them into a fresh decoder
   * rebuilds its partial frame and fragment reassembly.
   */
  readonly inbound: Uint8Array;
  /** How many frames replaying `inbound` completes that the host already handled. */
  readonly inboundSkip: number;
  /**
   * The host was part way through more than 1 MiB of one guest→host transfer: the stream cannot
   * continue, so the restored agent is unavailable until Linux restarts.
   */
  readonly inboundLost: boolean;
  /** Host→guest bytes that complete every frame the guest had only partly received. */
  readonly outbound: Uint8Array;
  /** The host's last fragment transfer sequence; the guest refuses lower ones. */
  readonly outboundSequence: number;
  readonly processes: readonly AdoptableProcess[];
  /** The newest hvc0 console output, at most 64 KiB. */
  readonly consoleTail: Uint8Array;
}

/** The largest record `encodeAgentResumeState` writes, which a restore point must be able to store. */
export const MAX_AGENT_RESUME_STATE_BYTES = 24 + 4 + MAX_INBOUND_BYTES + 4 + MAX_RESUME_OUTBOUND_BYTES + 4
  + MAX_PROCESSES * (9 + 4 + MAX_RESUME_COMMAND_BYTES + 4 + MAX_RESUME_TAIL_BYTES) + 4 + MAX_RESUME_TAIL_BYTES;

/**
 * Encodes `state` within the bounds its decoder reads: tails longer than 64 KiB keep their newest
 * bytes, a command longer than 4 KiB keeps its start (cut at a character), and only the first 256
 * processes stay adoptable. Transport bytes past their bounds cannot occur (the decoder and the
 * input queue bound them) and are refused, so a restore point never holds a record it cannot read.
 */
export function encodeAgentResumeState(state: AgentResumeState): Uint8Array<ArrayBuffer> {
  if (state.inbound.byteLength > MAX_INBOUND_BYTES || state.outbound.byteLength > MAX_RESUME_OUTBOUND_BYTES) {
    throw new VMError("PROTOCOL_ERROR", "the guest agent session exceeds what a restore point can hold");
  }
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(24);
  const view = new DataView(header.buffer);
  header.set(MAGIC);
  view.setUint16(4, VERSION, true);
  view.setUint8(6, state.dialect ?? 0);
  view.setUint8(7, state.inboundLost ? 1 : 0);
  view.setUint32(8, state.capabilities, true);
  view.setUint32(12, state.nextRequestId, true);
  view.setUint32(16, state.inboundSkip, true);
  view.setUint32(20, state.outboundSequence, true);
  const processes = state.processes.slice(0, MAX_PROCESSES);
  parts.push(header, lengthPrefixed(state.inbound), lengthPrefixed(state.outbound), u32(processes.length));
  for (const process of processes) {
    const entry = new Uint8Array(9);
    const fields = new DataView(entry.buffer);
    fields.setUint32(0, process.agentRequestId, true);
    fields.setUint32(4, process.pid, true);
    fields.setUint8(8, (process.terminal ? 1 : 0) | (process.stdinOpen ? 2 : 0));
    parts.push(entry, lengthPrefixed(commandBytes(process.command)), lengthPrefixed(newest(process.tail)));
  }
  parts.push(lengthPrefixed(newest(state.consoleTail)));
  const encoded = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    encoded.set(part, offset);
    offset += part.byteLength;
  }
  return encoded;
}

/** Decodes an OXHA v1 record strictly; it may come from an imported backup. */
export function decodeAgentResumeState(bytes: Uint8Array): AgentResumeState {
  const input = new Reader(bytes);
  if (MAGIC.some((byte) => input.u8() !== byte)) invalid("the agent resume state is not an OXHA record");
  if (input.u16() !== VERSION) invalid("the agent resume state has an unsupported version");
  const dialectByte = input.u8();
  const flags = input.u8();
  if (flags > 1) invalid("the agent resume state header is invalid");
  const inboundLost = flags === 1;
  const dialect = dialectByte === 0 ? null : decodeDialect(dialectByte);
  const capabilities = input.u32();
  requireKnownAgentCapabilities(capabilities, dialect);
  const nextRequestId = input.u32();
  const inboundSkip = input.u32();
  const outboundSequence = input.u32();
  const inbound = input.bytes(MAX_INBOUND_BYTES);
  const outbound = input.bytes(MAX_RESUME_OUTBOUND_BYTES);
  const count = input.u32();
  if (count > MAX_PROCESSES) invalid("the agent resume state lists too many processes");
  const processes: AdoptableProcess[] = [];
  const ids = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    const agentRequestId = input.u32();
    const pid = input.u32();
    const flags = input.u8();
    const command = decodeCommand(input.bytes(MAX_RESUME_COMMAND_BYTES));
    const tail = input.bytes(MAX_RESUME_TAIL_BYTES);
    if (agentRequestId === 0 || agentRequestId >= nextRequestId || ids.has(agentRequestId) || pid === 0 || flags > 3) {
      invalid("an adoptable process in the agent resume state is invalid");
    }
    ids.add(agentRequestId);
    processes.push({ agentRequestId, pid, terminal: (flags & 1) !== 0, stdinOpen: (flags & 2) !== 0, command, tail });
  }
  const consoleTail = input.bytes(MAX_RESUME_TAIL_BYTES);
  input.finish();
  if (nextRequestId === 0) invalid("the agent resume state request id is invalid");
  if (inboundSkip > inbound.byteLength || (inboundLost && (inbound.byteLength !== 0 || inboundSkip !== 0))) {
    invalid("the agent resume state replay is invalid");
  }
  if (dialect === null && (capabilities !== 0 || inbound.byteLength !== 0 || outbound.byteLength !== 0 || processes.length !== 0)) {
    invalid("the agent resume state has a session without an agent");
  }
  return { dialect, capabilities, nextRequestId, inbound, inboundSkip, inboundLost, outbound, outboundSequence, processes, consoleTail };
}

function decodeCommand(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid("an adoptable process command in the agent resume state is not UTF-8");
  }
}

function decodeDialect(value: number): AgentProtocolVersion {
  if (value !== 3 && value !== 4 && value !== 5 && value !== 6 && value !== 7) {
    invalid("the agent resume state dialect is unsupported");
  }
  return value;
}

/** `command` as UTF-8, cut to its first 4 KiB at a character boundary. */
function commandBytes(command: string): Uint8Array {
  const bytes = new TextEncoder().encode(command);
  if (bytes.byteLength <= MAX_RESUME_COMMAND_BYTES) return bytes;
  let end = MAX_RESUME_COMMAND_BYTES;
  // A UTF-8 continuation byte is 10xxxxxx; the cut must not leave a character's head behind.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

function newest(bytes: Uint8Array): Uint8Array {
  return bytes.subarray(Math.max(0, bytes.byteLength - MAX_RESUME_TAIL_BYTES));
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const result = new Uint8Array(4 + bytes.byteLength);
  new DataView(result.buffer).setUint32(0, bytes.byteLength, true);
  result.set(bytes, 4);
  return result;
}

class Reader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(): number {
    this.#need(1);
    const value = this.#view.getUint8(this.#offset);
    this.#offset += 1;
    return value;
  }

  u16(): number {
    this.#need(2);
    const value = this.#view.getUint16(this.#offset, true);
    this.#offset += 2;
    return value;
  }

  u32(): number {
    this.#need(4);
    const value = this.#view.getUint32(this.#offset, true);
    this.#offset += 4;
    return value;
  }

  bytes(maximum: number): Uint8Array {
    const length = this.u32();
    if (length > maximum) invalid("a field of the agent resume state exceeds its bound");
    this.#need(length);
    const value = this.#bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  finish(): void {
    if (this.#offset !== this.#bytes.byteLength) invalid("the agent resume state has trailing bytes");
  }

  #need(length: number): void {
    if (this.#bytes.byteLength - this.#offset < length) invalid("the agent resume state is truncated");
  }
}

function invalid(message: string): never {
  throw new VMError("STORAGE_ERROR", message, { reason: "snapshot-damaged" });
}
