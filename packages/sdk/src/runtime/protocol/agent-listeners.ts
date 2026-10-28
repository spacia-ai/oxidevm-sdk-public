// The guest agent's listening-port reports (ADR 0015, capability 64): the WATCH_LISTENERS request
// payload, and the LISTENERS event's list, decoded exactly. The layout is
// `spec/agent/listeners.hex`'s, shared with the agent's own tests.
import { AgentPayloadReader } from "../agent-protocol.js";
import { VMError } from "../errors.js";
import { formatListenerAddress } from "../listening-ports.js";

export const AGENT_LISTENERS_MAX = 256;
export const AGENT_PROGRAM_MAX_BYTES = 256;
/** 12 header bytes and 256 entries of 37 fixed bytes and a 256-byte program. */
export const AGENT_LISTENERS_MAX_BYTES = 12 + AGENT_LISTENERS_MAX * (37 + AGENT_PROGRAM_MAX_BYTES);

export interface AgentListener {
  readonly family: 4 | 6;
  /** RFC 5952 text; IPv4-mapped addresses as `::ffff:a.b.c.d`. */
  readonly address: string;
  readonly port: number;
  readonly inode: bigint;
  /** 0 when the agent found no process holding the socket. */
  readonly pid: number;
  readonly program: string | null;
}

export interface AgentListenerSnapshot {
  readonly listeners: readonly AgentListener[];
  readonly omitted: number;
  readonly malformed: number;
}

/** Addresses the router reaches: every address, 127.0.0.1 and the guest's own, mapped or not. */
const PREVIEWABLE: ReadonlySet<string> = new Set([
  "0.0.0.0",
  "127.0.0.1",
  "192.0.2.2",
  "::",
  "::ffff:0.0.0.0",
  "::ffff:127.0.0.1",
  "::ffff:192.0.2.2",
]);
const programs = new TextDecoder("utf-8", { fatal: true });

export function encodeWatchListeners(operation: "subscribe" | "unsubscribe"): Uint8Array<ArrayBuffer> {
  return Uint8Array.of(operation === "subscribe" ? 1 : 2);
}

export function decodeAgentListeners(payload: Uint8Array): AgentListenerSnapshot {
  if (payload.byteLength > AGENT_LISTENERS_MAX_BYTES) fail("the listener list is too large");
  const reader = new AgentPayloadReader(payload);
  const count = reader.u32();
  const omitted = reader.u32();
  const malformed = reader.u32();
  if (count > AGENT_LISTENERS_MAX) fail("the listener list has too many entries");
  const listeners: AgentListener[] = [];
  let previous: { readonly port: number; readonly family: number; readonly address: Uint8Array } | undefined;
  for (let index = 0; index < count; index += 1) {
    const family = reader.u8();
    if (family !== 4 && family !== 6) fail("a listener's family is neither IPv4 nor IPv6");
    const address = reader.take(16).slice();
    if (family === 4 && address.subarray(4).some((byte) => byte !== 0)) fail("an IPv4 listener's address has padding");
    const port = reader.u32();
    if (port < 1 || port > 65_535) fail("a listener's port is out of range");
    const inode = reader.u64();
    const pid = reader.u32();
    const programBytes = reader.take(reader.u32());
    if (programBytes.byteLength > AGENT_PROGRAM_MAX_BYTES) fail("a listener's program is too long");
    if (pid === 0 && programBytes.byteLength > 0) fail("a listener's program has no owning process");
    const program = programBytes.byteLength === 0 ? null : decodeProgram(programBytes);
    const key = { port, family, address };
    if (previous !== undefined && compare(previous, key) >= 0) fail("listeners are not strictly ascending");
    previous = key;
    listeners.push({ family, address: listenerAddressText(family, address), port, inode, pid, program });
  }
  reader.finish();
  return { listeners, omitted, malformed };
}

export function listenerAddressText(family: 4 | 6, bytes: Uint8Array): string {
  return formatListenerAddress(family, bytes);
}

/** Whether the router can reach a server bound to `address` (RC7). */
export function previewableAddress(address: string): boolean {
  return PREVIEWABLE.has(address);
}

function decodeProgram(bytes: Uint8Array): string {
  let text: string;
  try {
    text = programs.decode(bytes);
  } catch {
    fail("a listener's program is not UTF-8");
  }
  // C0 and C1 controls and DEL, which the agent replaces with spaces.
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) fail("a listener's program has a control character");
  }
  return text;
}

function compare(
  left: { readonly port: number; readonly family: number; readonly address: Uint8Array },
  right: { readonly port: number; readonly family: number; readonly address: Uint8Array },
): number {
  if (left.port !== right.port) return left.port - right.port;
  if (left.family !== right.family) return left.family - right.family;
  for (let index = 0; index < 16; index += 1) {
    const difference = (left.address[index] ?? 0) - (right.address[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function fail(message: string): never {
  throw new VMError("PROTOCOL_ERROR", message);
}
