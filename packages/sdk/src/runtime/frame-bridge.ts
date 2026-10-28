// The shared-memory frame bridge between the control worker, which owns the core's network card,
// and the network worker, which runs the router (ADR 0015). One SharedArrayBuffer holds sixteen
// control words, a 512-byte slot for the router's counters, and two 1 MiB rings of frame records:
// to the router (control writes, network reads) and to Linux (network writes, control reads).
// Ring counters run free as u32 values in Int32 words; each word has exactly one writer.
import { exactKeys, integer, protocolError, record } from "./decode.ts";
import { PROTOCOL_VERSION } from "./protocol/common.ts";

export const FRAME_BRIDGE_VERSION = 1;
export const MIN_FRAME_BYTES = 14;
export const MAX_FRAME_BYTES = 1514;
export const FRAME_RECORD_HEADER_BYTES = 2;
export const FRAME_BRIDGE_RING_BYTES = 1 << 20;
export const ROUTER_COUNTERS_SLOT_BYTES = 512;
const CONTROL_WORDS = 16;
const COUNTERS_OFFSET = CONTROL_WORDS * 4;
const TO_ROUTER_OFFSET = COUNTERS_OFFSET + ROUTER_COUNTERS_SLOT_BYTES;
const TO_LINUX_OFFSET = TO_ROUTER_OFFSET + FRAME_BRIDGE_RING_BYTES;
export const FRAME_BRIDGE_TOTAL_BYTES = TO_LINUX_OFFSET + FRAME_BRIDGE_RING_BYTES;
const RING_MASK = FRAME_BRIDGE_RING_BYTES - 1;
const GENERATION_MASK = 0x7fff_ffff;
const MAX_NETSTACK_URL_LENGTH = 2_048;
const COUNTER_READ_ATTEMPTS = 4;

export const FRAME_BRIDGE_WORD = {
  version: 0,
  /** Advanced by control whenever the core's machine is replaced. */
  generation: 1,
  toRouterHead: 2,
  toRouterTail: 3,
  toLinuxHead: 4,
  toLinuxTail: 5,
  /** 1 from a doorbell until the network worker starts draining. */
  kickPending: 6,
  /** The generation the router was last initialised for. */
  routerGeneration: 7,
  /** Even when the counter slot is whole; odd while the network worker writes it. */
  routerCountersSequence: 8,
  routerCountersLength: 9,
} as const;

export type FrameDirection = "to-router" | "to-linux";

export function createFrameBridgeBuffer(): SharedArrayBuffer {
  const buffer = new SharedArrayBuffer(FRAME_BRIDGE_TOTAL_BYTES);
  Atomics.store(words(buffer), FRAME_BRIDGE_WORD.version, FRAME_BRIDGE_VERSION);
  return buffer;
}

export function validateFrameBridgeBuffer(value: unknown): SharedArrayBuffer {
  if (typeof SharedArrayBuffer !== "function" || !(value instanceof SharedArrayBuffer)
    || value.byteLength !== FRAME_BRIDGE_TOTAL_BYTES) {
    throw protocolError("the frame bridge is not a shared buffer of the expected size");
  }
  if (Atomics.load(words(value), FRAME_BRIDGE_WORD.version) !== FRAME_BRIDGE_VERSION) {
    throw protocolError("unsupported frame bridge version");
  }
  return value;
}

/** Where each record ends in `records`, which must be whole records of 14..=1514-byte frames. */
export function frameRecordEnds(records: Uint8Array): readonly number[] {
  const ends: number[] = [];
  let offset = 0;
  while (offset < records.byteLength) {
    if (records.byteLength - offset < FRAME_RECORD_HEADER_BYTES) throw protocolError("a frame record header is truncated");
    const length = (records[offset] ?? 0) | ((records[offset + 1] ?? 0) << 8);
    checkFrameLength(length);
    offset += FRAME_RECORD_HEADER_BYTES + length;
    if (offset > records.byteLength) throw protocolError("a frame record is truncated");
    ends.push(offset);
  }
  return ends;
}

export function encodeFrameRecords(frames: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const records = new Uint8Array(frames.reduce((total, next) => total + FRAME_RECORD_HEADER_BYTES + next.byteLength, 0));
  let offset = 0;
  for (const next of frames) {
    checkFrameLength(next.byteLength);
    records[offset] = next.byteLength & 0xff;
    records[offset + 1] = next.byteLength >> 8;
    records.set(next, offset + FRAME_RECORD_HEADER_BYTES);
    offset += FRAME_RECORD_HEADER_BYTES + next.byteLength;
  }
  return records;
}

export interface FramePeek {
  /** Bytes of whole records copied out. */
  readonly length: number;
  /** Where each copied record ends. */
  readonly recordEnds: readonly number[];
}

/** One direction's ring. The writer moves the head and the reader the tail. */
export class FrameRing {
  readonly #control: Int32Array;
  readonly #data: Uint8Array;
  readonly #head: number;
  readonly #tail: number;

  constructor(buffer: SharedArrayBuffer, direction: FrameDirection) {
    validateFrameBridgeBuffer(buffer);
    const toRouter = direction === "to-router";
    this.#control = words(buffer);
    this.#data = new Uint8Array(buffer, toRouter ? TO_ROUTER_OFFSET : TO_LINUX_OFFSET, FRAME_BRIDGE_RING_BYTES);
    this.#head = toRouter ? FRAME_BRIDGE_WORD.toRouterHead : FRAME_BRIDGE_WORD.toLinuxHead;
    this.#tail = toRouter ? FRAME_BRIDGE_WORD.toRouterTail : FRAME_BRIDGE_WORD.toLinuxTail;
  }

  usedBytes(): number {
    const used = (Atomics.load(this.#control, this.#head) - Atomics.load(this.#control, this.#tail)) >>> 0;
    if (used > FRAME_BRIDGE_RING_BYTES) throw protocolError("frame ring counters claim more than the ring holds");
    return used;
  }

  freeBytes(): number {
    return FRAME_BRIDGE_RING_BYTES - this.usedBytes();
  }

  /** Appends whole records; a ring without room for all of them takes none. */
  write(records: Uint8Array): void {
    frameRecordEnds(records);
    if (records.byteLength > this.freeBytes()) throw protocolError("the frame ring has no room for these records");
    const head = Atomics.load(this.#control, this.#head);
    const start = head & RING_MASK;
    const first = Math.min(records.byteLength, FRAME_BRIDGE_RING_BYTES - start);
    this.#data.set(records.subarray(0, first), start);
    this.#data.set(records.subarray(first), 0);
    Atomics.store(this.#control, this.#head, (head + records.byteLength) | 0);
  }

  /** Copies the oldest whole records that fit into `destination`, without consuming them. */
  peek(destination: Uint8Array): FramePeek {
    const tail = Atomics.load(this.#control, this.#tail);
    const used = this.usedBytes();
    const recordEnds: number[] = [];
    let offset = 0;
    while (offset < used) {
      if (used - offset < FRAME_RECORD_HEADER_BYTES) throw protocolError("a queued frame record header is truncated");
      const length = this.#byte(tail + offset) | (this.#byte(tail + offset + 1) << 8);
      checkFrameLength(length);
      const end = offset + FRAME_RECORD_HEADER_BYTES + length;
      if (end > used) throw protocolError("a queued frame record is truncated");
      if (end > destination.byteLength) break;
      this.#copyOut(tail + offset, destination.subarray(offset, end));
      recordEnds.push(end);
      offset = end;
    }
    return { length: offset, recordEnds };
  }

  /** Consumes `bytes`, which must end on a record the reader peeked. */
  advance(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.usedBytes()) {
      throw protocolError("a frame ring cannot advance past what it holds");
    }
    const tail = Atomics.load(this.#control, this.#tail);
    Atomics.store(this.#control, this.#tail, (tail + bytes) | 0);
  }

  /** Drops everything queued: the frames belong to a machine that was replaced. */
  skipAll(): void {
    Atomics.store(this.#control, this.#tail, Atomics.load(this.#control, this.#head));
  }

  #byte(position: number): number {
    return this.#data[position & RING_MASK] ?? 0;
  }

  #copyOut(position: number, destination: Uint8Array): void {
    const start = position & RING_MASK;
    const first = Math.min(destination.byteLength, FRAME_BRIDGE_RING_BYTES - start);
    destination.set(this.#data.subarray(start, start + first));
    destination.set(this.#data.subarray(0, destination.byteLength - first), first);
  }
}

/** Tells the network worker that records wait for the router; at most one notice per drain. */
export class FrameBridgeDoorbell {
  readonly #buffer: SharedArrayBuffer;
  readonly #control: Int32Array;
  readonly #port: { postMessage(message: unknown): void };

  constructor(buffer: SharedArrayBuffer, port: { postMessage(message: unknown): void }) {
    this.#buffer = validateFrameBridgeBuffer(buffer);
    this.#control = words(buffer);
    this.#port = port;
  }

  ring(): boolean {
    if (Atomics.compareExchange(this.#control, FRAME_BRIDGE_WORD.kickPending, 0, 1) !== 0) return false;
    const notice: FrameBridgeNotice = {
      version: FRAME_BRIDGE_VERSION,
      type: "frames",
      generation: frameBridgeGeneration(this.#buffer),
    };
    this.#port.postMessage(notice);
    return true;
  }
}

/** The network worker clears the kick before it drains, so writes after that ring again. */
export function clearFrameBridgeKick(buffer: SharedArrayBuffer): void {
  Atomics.store(words(buffer), FRAME_BRIDGE_WORD.kickPending, 0);
}

export function advanceFrameBridgeGeneration(buffer: SharedArrayBuffer): number {
  const control = words(buffer);
  const next = (Atomics.load(control, FRAME_BRIDGE_WORD.generation) + 1) & GENERATION_MASK;
  Atomics.store(control, FRAME_BRIDGE_WORD.generation, next);
  return next;
}

export function frameBridgeGeneration(buffer: SharedArrayBuffer): number {
  return Atomics.load(words(buffer), FRAME_BRIDGE_WORD.generation);
}

export function publishRouterGeneration(buffer: SharedArrayBuffer, generation: number): void {
  Atomics.store(words(buffer), FRAME_BRIDGE_WORD.routerGeneration, generation & GENERATION_MASK);
}

export function routerGeneration(buffer: SharedArrayBuffer): number {
  return Atomics.load(words(buffer), FRAME_BRIDGE_WORD.routerGeneration);
}

/** Writes the router's counter record under the sequence lock. */
export function publishRouterCounters(buffer: SharedArrayBuffer, counters: Uint8Array): void {
  if (counters.byteLength === 0 || counters.byteLength > ROUTER_COUNTERS_SLOT_BYTES) {
    throw protocolError("router counters do not fit their slot");
  }
  const control = words(buffer);
  const odd = Atomics.add(control, FRAME_BRIDGE_WORD.routerCountersSequence, 1) + 1;
  new Uint8Array(buffer, COUNTERS_OFFSET, counters.byteLength).set(counters);
  Atomics.store(control, FRAME_BRIDGE_WORD.routerCountersLength, counters.byteLength);
  Atomics.store(control, FRAME_BRIDGE_WORD.routerCountersSequence, (odd + 1) | 0);
}

/** A copy of the last whole counter record, or undefined before the first publish or while every
 * attempt overlapped a publish. */
export function readRouterCounters(
  buffer: SharedArrayBuffer,
  attempts = COUNTER_READ_ATTEMPTS,
): Uint8Array<ArrayBuffer> | undefined {
  const control = words(buffer);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = Atomics.load(control, FRAME_BRIDGE_WORD.routerCountersSequence);
    if (before === 0) return undefined;
    if ((before & 1) !== 0) continue;
    const length = Atomics.load(control, FRAME_BRIDGE_WORD.routerCountersLength);
    if (length <= 0 || length > ROUTER_COUNTERS_SLOT_BYTES) return undefined;
    const copy = new Uint8Array(buffer, COUNTERS_OFFSET, length).slice();
    if (Atomics.load(control, FRAME_BRIDGE_WORD.routerCountersSequence) === before) return copy;
  }
  return undefined;
}

export interface FrameBridgeNotice {
  readonly version: typeof FRAME_BRIDGE_VERSION;
  readonly type: "frames";
  readonly generation: number;
}

/** Why the router failed: loading it (fetch through init), a trap, or a broken bridge (protocol). */
export type RouterFailure = "fetch" | "compile" | "exports" | "version" | "init" | "trap" | "protocol";
const ROUTER_FAILURES: ReadonlySet<string> = new Set<RouterFailure>(["fetch", "compile", "exports", "version", "init", "trap", "protocol"]);

export type FrameBridgeReply =
  | { readonly version: typeof FRAME_BRIDGE_VERSION; readonly type: "router-ready" }
  | { readonly version: typeof FRAME_BRIDGE_VERSION; readonly type: "router-failed"; readonly reason: RouterFailure };

export function decodeFrameBridgeNotice(value: unknown): FrameBridgeNotice {
  const message = record(value, "frame bridge notice");
  exactKeys(message, ["version", "type", "generation"]);
  if (message["version"] !== FRAME_BRIDGE_VERSION || message["type"] !== "frames") {
    throw protocolError("invalid frame bridge notice");
  }
  const generation = integer(message["generation"], "frame bridge generation", 0, GENERATION_MASK);
  return { version: FRAME_BRIDGE_VERSION, type: "frames", generation };
}

export function decodeFrameBridgeReply(value: unknown): FrameBridgeReply {
  const message = record(value, "frame bridge reply");
  if (message["version"] !== FRAME_BRIDGE_VERSION) throw protocolError("unsupported frame bridge reply version");
  switch (message["type"]) {
    case "router-ready":
      exactKeys(message, ["version", "type"]);
      return { version: FRAME_BRIDGE_VERSION, type: "router-ready" };
    case "router-failed": {
      exactKeys(message, ["version", "type", "reason"]);
      const reason = message["reason"];
      if (!isRouterFailure(reason)) throw protocolError("unknown router failure");
      return { version: FRAME_BRIDGE_VERSION, type: "router-failed", reason };
    }
    default:
      throw protocolError("unknown frame bridge reply");
  }
}

/** The main thread's hand-off of the bridge to the network worker. */
export interface NetworkLinkConnection {
  readonly version: typeof PROTOCOL_VERSION;
  readonly type: "connect-link";
  readonly bridge: SharedArrayBuffer | "message";
  readonly doorbell: MessagePort;
  /** The router module's absolute http(s) URL, which the network worker fetches. */
  readonly netstackWasmUrl: string;
}

export function decodeNetworkLinkConnection(message: Readonly<Record<string, unknown>>): NetworkLinkConnection {
  exactKeys(message, ["version", "type", "bridge", "doorbell", "netstackWasmUrl"]);
  const { doorbell, netstackWasmUrl } = message;
  if (message["version"] !== PROTOCOL_VERSION || message["type"] !== "connect-link" || !(doorbell instanceof MessagePort)) {
    throw protocolError("invalid connect-link message");
  }
  return {
    version: PROTOCOL_VERSION,
    type: "connect-link",
    bridge: message["bridge"] === "message" ? "message" : validateFrameBridgeBuffer(message["bridge"]),
    doorbell,
    netstackWasmUrl: netstackUrl(netstackWasmUrl),
  };
}

function netstackUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_NETSTACK_URL_LENGTH || !URL.canParse(value)) {
    throw protocolError("the router module URL must be an absolute URL of at most 2,048 characters");
  }
  const { protocol, origin } = new URL(value);
  if (protocol !== "https:" && protocol !== "http:" && !(protocol === "blob:" && origin !== "null")) throw protocolError("the router module URL must use http, https or an owned origin blob");
  return value;
}

function isRouterFailure(value: unknown): value is RouterFailure {
  return typeof value === "string" && ROUTER_FAILURES.has(value);
}

function checkFrameLength(length: number): void {
  if (length < MIN_FRAME_BYTES || length > MAX_FRAME_BYTES) {
    throw protocolError(`a ${String(length)}-byte frame is outside 14..=1514 bytes`);
  }
}

function words(buffer: SharedArrayBuffer): Int32Array {
  return new Int32Array(buffer, 0, CONTROL_WORDS);
}
