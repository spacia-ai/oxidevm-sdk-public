import type { AgentPayloadReader, AgentPayloadWriter } from "../agent-protocol.js";
import { exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";

export interface AssistanceWatchEvent {
  readonly sequence: bigint;
  readonly watch: number | null;
  readonly change: "change" | "rename" | "retired" | "overflow";
  readonly mask: number;
  readonly cookie: number;
  readonly name: Uint8Array<ArrayBuffer> | null;
}
const changes = { change: 1, rename: 2, retired: 3, overflow: 4 } as const;
function fail(): never { throw new VMError("PROTOCOL_ERROR", "Invalid bounded watch events"); }

export function decodeWatchEvents(value: unknown): readonly AssistanceWatchEvent[] {
  if (!Array.isArray(value) || value.length > 256) fail();
  let previous: bigint | undefined; let bytes = 4;
  return value.map((entry: unknown, index) => {
    const item = record(entry, "watch event");
    exactKeys(item, ["sequence", "watch", "change", "mask", "cookie", "name"]);
    const sequence = item["sequence"];
    if (typeof sequence !== "bigint" || sequence < 1n || sequence > 0xffff_ffff_ffff_ffffn || (previous !== undefined && sequence !== previous + 1n)) fail();
    previous = sequence;
    const watch = item["watch"] === null ? null : integer(item["watch"], "watch identity", 1, 0xffff_ffff);
    const mask = integer(item["mask"], "watch mask", 0, 0xffff_ffff);
    const cookie = integer(item["cookie"], "watch cookie", 0, 0xffff_ffff);
    const change = mask & 0x4000 ? "overflow" : mask & 0xa000 ? "retired" : mask & 6 ? "change" : "rename";
    if ((mask & ~0x4000_efc6) !== 0 || (mask & 0xefc6) === 0 || item["change"] !== change || (!(mask & 0xc0) && cookie !== 0)) fail();
    const raw = item["name"];
    if (raw !== null && (!(raw instanceof Uint8Array) || !(raw.buffer instanceof ArrayBuffer) || raw.length === 0 || raw.length > 255 || raw.includes(0) || raw.includes(47))) fail();
    const name = raw === null ? null : raw.slice();
    if (change === "overflow") {
      if (watch !== null || name !== null || cookie !== 0 || mask !== 0x4000 || index + 1 !== value.length) fail();
    } else if (watch === null) fail();
    bytes += 22 + (name === null ? 0 : 4 + name.length);
    if (bytes > 16384) fail();
    return { sequence, watch, change, mask, cookie, name };
  });
}

export function readWatchEvents(input: AgentPayloadReader): readonly AssistanceWatchEvent[] {
  const count = integer(input.u32(), "watch event count", 0, 256);
  return decodeWatchEvents(Array.from({ length: count }, () => {
    const sequence = input.u64(); const watch = input.u32(); const tag = input.u8();
    const change = tag === 1 ? "change" : tag === 2 ? "rename" : tag === 3 ? "retired" : tag === 4 ? "overflow" : fail();
    const mask = input.u32(); const cookie = input.u32(); const present = input.u8();
    return { sequence, watch: watch === 0 ? null : watch, change, mask, cookie, name: present === 0 ? null : present === 1 ? input.bytes() : fail() };
  }));
}

export function writeWatchEvents(output: AgentPayloadWriter, events: readonly AssistanceWatchEvent[]): void {
  const checked = decodeWatchEvents(events);
  output.u32(checked.length);
  for (const event of checked) {
    output.u64(event.sequence).u32(event.watch ?? 0).u8(changes[event.change]).u32(event.mask).u32(event.cookie).u8(event.name === null ? 0 : 1);
    if (event.name !== null) output.bytes(event.name);
  }
}
