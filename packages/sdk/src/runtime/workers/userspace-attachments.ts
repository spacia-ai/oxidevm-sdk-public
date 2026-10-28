import { AgentPayloadReader, AgentPayloadWriter } from "../agent-protocol.js";
import { integer } from "../decode.js";
import { VMError } from "../errors.js";
import { MAX_AGENT_STATE_BYTES } from "./snapshot-manifest.js";

const MAGIC = 0x4155584f; // OXUA
const MAX_ATTACHMENTS = 4096;
const MAX_TAIL = 65536;
const MAX_COMMAND = 4096;
const ENTRY_BYTES = 43;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** This is the browser transport cut. Guest queues, PTYs and sizes remain Rust-owned. */
export interface NativeAttachment {
  readonly key: number;
  readonly identityKey: number;
  readonly pid: number;
  readonly command: string;
  readonly terminal: { readonly columns: number; readonly rows: number } | undefined;
  readonly stdinOpen: boolean;
  readonly sequence: number;
  readonly acknowledged: number;
  readonly pending?: { readonly stream: "stdout" | "stderr"; readonly count: number } | undefined;
  readonly tail: Uint8Array;
}
export interface NativeAttachments {
  readonly nextKey: number;
  readonly processes: readonly NativeAttachment[];
}

export function encodeNativeAttachments(state: NativeAttachments): Uint8Array<ArrayBuffer> {
  validate(state);
  const commands = state.processes.map(process => encoder.encode(process.command));
  const metadata = 16 + commands.reduce((sum, command) => sum + ENTRY_BYTES + command.length, 0);
  const tailLimit = Math.min(MAX_TAIL, Math.floor((MAX_AGENT_STATE_BYTES - metadata) / Math.max(1, commands.length)));
  if (tailLimit < 0) invalid("Native attachment metadata exceeds its bound");
  const output = new AgentPayloadWriter(MAX_AGENT_STATE_BYTES).u32(MAGIC).u32(1).u32(state.nextKey).u32(state.processes.length);
  for (const [index, process] of state.processes.entries()) {
    const command = commands[index]; if (command === undefined) invalid("Native attachment command is missing");
    output.u32(process.key).u32(process.identityKey).u32(process.pid).bytes(command).u8(process.stdinOpen ? 1 : 0).u8(process.terminal === undefined ? 0 : 1)
      .u32(process.terminal?.columns ?? 0).u32(process.terminal?.rows ?? 0)
      .u32(process.sequence).u32(process.acknowledged)
      .u8(process.pending === undefined ? 0 : process.pending.stream === "stdout" ? 1 : 2).u32(process.pending?.count ?? 0)
      .bytes(process.tail.subarray(Math.max(0, process.tail.length - tailLimit)));
  }
  return output.finish();
}

export function decodeNativeAttachments(bytes: Uint8Array): NativeAttachments {
  if (bytes.length > MAX_AGENT_STATE_BYTES) invalid("Native attachment record exceeds its bound");
  const input = new AgentPayloadReader(bytes);
  if (input.u32() !== MAGIC || input.u32() !== 1) invalid("Native attachment format is unsupported");
  const nextKey = input.u32(), count = input.u32();
  if (count > MAX_ATTACHMENTS || count * ENTRY_BYTES > bytes.length - 16) invalid("Native attachment count is invalid");
  const processes: NativeAttachment[] = [];
  for (let index = 0; index < count; index++) {
    const key = input.u32(), identityKey = input.u32(), pid = input.u32(), commandBytes = input.take(input.u32());
    if (commandBytes.length > MAX_COMMAND) invalid("Native attachment command exceeds its bound");
    let command: string;
    try { command = decoder.decode(commandBytes); } catch { invalid("Native attachment command is not UTF-8"); }
    const stdin = input.u8(), terminal = input.u8(), columns = input.u32(), rows = input.u32();
    const sequence = input.u32(), acknowledged = input.u32(), stream = input.u8(), pending = input.u32();
    const tail = input.take(input.u32());
    if (stdin > 1 || terminal > 1 || stream > 2 || stream === 0 && pending !== 0 || terminal === 0 && (columns !== 0 || rows !== 0)) invalid("Native attachment flags are invalid");
    processes.push({ key, identityKey, pid, command, stdinOpen: stdin === 1, terminal: terminal === 0 ? undefined : { columns, rows }, sequence, acknowledged,
      ...(stream === 0 ? {} : { pending: { stream: stream === 1 ? "stdout" : "stderr", count: pending } }), tail });
  }
  input.finish();
  const state = { nextKey, processes }; validate(state); return state;
}

export function appendNativeTail(tail: Uint8Array, bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const kept = bytes.subarray(Math.max(0, bytes.length - MAX_TAIL));
  const prior = tail.subarray(Math.max(0, tail.length - (MAX_TAIL - kept.length)));
  const result = new Uint8Array(prior.length + kept.length); result.set(prior); result.set(kept, prior.length); return result;
}

/** The label is bounded independently of the guest's authoritative argv bytes. */
export function nativeAttachmentCommand(command: string): string {
  const bytes = encoder.encode(command);
  let end = Math.min(bytes.length, MAX_COMMAND);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

function validate(state: NativeAttachments): void {
  integer(state.nextKey, "next attachment key", 1, 0xffff_ffff);
  if (state.processes.length > MAX_ATTACHMENTS) invalid("Too many native process attachments");
  const keys = new Set<number>(), identities = new Set<number>(), pids = new Set<number>();
  for (const process of state.processes) {
    integer(process.key, "attachment key", 1, state.nextKey - 1); integer(process.pid, "attachment PID", 1, 0x7fff_ffff);
    integer(process.identityKey, "stable attachment key", 1, state.nextKey - 1);
    integer(process.sequence, "output sequence", 0, 0xffff_ffff); integer(process.acknowledged, "acknowledged output", 0, process.sequence);
    if (keys.has(process.key) || identities.has(process.identityKey) || pids.has(process.pid) || encoder.encode(process.command).length > MAX_COMMAND || process.tail.length > MAX_TAIL) invalid("Native attachment identity or diagnostics are invalid");
    keys.add(process.key); identities.add(process.identityKey); pids.add(process.pid);
    if (process.terminal !== undefined) { integer(process.terminal.columns, "terminal columns", 0, 65535); integer(process.terminal.rows, "terminal rows", 0, 65535); }
    if (process.sequence - process.acknowledged !== (process.pending === undefined ? 0 : 1)) invalid("Native output acknowledgement cut is inconsistent");
    if (process.pending !== undefined) integer(process.pending.count, "pending output bytes", 1, 1024 * 1024);
  }
}
function invalid(message: string): never { throw new VMError("PROTOCOL_ERROR", message); }
