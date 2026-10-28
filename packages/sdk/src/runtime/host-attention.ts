import { exactKeys, record } from "./decode.js";
import { VMError } from "./errors.js";
import { PROTOCOL_VERSION } from "./protocol/common.js";

/**
 * Host attention for the execution workers, which serve their message queues only between guest
 * run slices. A producer that posts to an execution worker bumps the channel's shared counter
 * before each post, and the worker counts each message its event loop delivers on that channel.
 * A count ahead of the deliveries names messages waiting behind the current slice, so the guest's
 * run loop ends the slice early, at its existing action boundary, and the worker serves them. The
 * JIT compiler's ready counter (`control/jit-compiler-client.ts`) is the same counter for
 * compiled modules.
 *
 * Shared memory needs cross-origin isolation. Without it a channel has no counter, and its
 * messages wait for the end of the current slice, as before.
 */
export type AttentionCounter = Int32Array<SharedArrayBuffer>;

/** A fresh counter for one channel, or null where shared memory is unavailable. */
export function createAttentionCounter(): AttentionCounter | null {
  return typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated
    ? new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    : null;
}

export function isAttentionCounter(value: unknown): value is AttentionCounter {
  return value instanceof Int32Array
    && typeof SharedArrayBuffer === "function"
    && value.buffer instanceof SharedArrayBuffer
    && value.length === 1;
}

/** A channel's counter from a message: one shared Int32 slot, or null for a channel without one. */
export function decodeAttentionCounter(value: unknown, channel: string): AttentionCounter | null {
  if (value === null) return null;
  if (!isAttentionCounter(value)) throw new VMError("PROTOCOL_ERROR", `${channel} attention counter is invalid`);
  return value;
}

/** The first message on a channel into an execution worker. It names the counter its producer bumps
 * before every later message on that channel, and is itself uncounted. */
export interface AttentionAttachment {
  readonly version: typeof PROTOCOL_VERSION;
  readonly type: "attach-host-attention";
  readonly counter: AttentionCounter;
}

export function attentionAttachment(counter: AttentionCounter): AttentionAttachment {
  return { version: PROTOCOL_VERSION, type: "attach-host-attention", counter };
}

/** Whether a message on a worker channel is an attachment, before its protocol decoder runs. */
export function isAttentionAttachment(value: unknown): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "type") === "attach-host-attention";
}

export function decodeAttentionAttachment(value: unknown): AttentionCounter {
  const message = record(value, "host attention attachment");
  exactKeys(message, ["version", "type", "counter"]);
  if (message["version"] !== PROTOCOL_VERSION || message["type"] !== "attach-host-attention") {
    throw new VMError("PROTOCOL_ERROR", "host attention attachment version or type is invalid");
  }
  const counter = decodeAttentionCounter(message["counter"], "attached");
  if (counter === null) throw new VMError("PROTOCOL_ERROR", "attached attention counter is invalid");
  return counter;
}

/** Counts one message, then sends it with `post`. A post that throws sent nothing and stays uncounted. */
export function postCounted(counter: AttentionCounter | null, post: () => void): void {
  if (counter === null) {
    post();
    return;
  }
  Atomics.add(counter, 0, 1);
  try {
    post();
  } catch (error) {
    Atomics.sub(counter, 0, 1);
    throw error;
  }
}

/** The receiving end of one counter. Both sides count from zero and wrap as Int32. Only a count
 * ahead of the deliveries holds attention: a producer that counts through another worker
 * (`workers/attention-notices.ts`) can trail its own messages, and such a lag, or a
 * counting worker that stopped, must never hold attention. */
export class AttentionReceipts {
  readonly #counter: AttentionCounter;
  #delivered = 0;

  constructor(counter: AttentionCounter) {
    this.#counter = counter;
  }

  /** One message, or one message that failed to deserialize, reached the receiver's event loop. */
  delivered(): void {
    this.#delivered = (this.#delivered + 1) | 0;
  }

  /** Whether the producer posted messages the receiver's event loop has not delivered yet. */
  pending(): boolean {
    return ((Atomics.load(this.#counter, 0) - this.#delivered) | 0) > 0;
  }
}

/** One watched channel of an execution worker. */
export interface AttentionWatch {
  /** Call for every `message` and `messageerror` event the channel delivers. */
  delivered(): void;
  /** The channel closed: its undelivered messages no longer hold attention. */
  close(): void;
}

/** The channels of one execution worker whose producers count their posts, each named by a closed
 * channel kind, so a slice that ends for host attention is attributed to the channel that caused it. */
export class HostAttention<Channel extends string> {
  readonly #watched = new Set<{ readonly channel: Channel; readonly receipts: AttentionReceipts }>();

  get size(): number {
    return this.#watched.size;
  }

  watch(channel: Channel, counter: AttentionCounter): AttentionWatch {
    const entry = { channel, receipts: new AttentionReceipts(counter) };
    this.#watched.add(entry);
    return {
      delivered: () => { entry.receipts.delivered(); },
      close: () => { this.#watched.delete(entry); },
    };
  }

  /** The first watched channel with messages its event loop has not delivered yet. */
  pending(): Channel | undefined {
    for (const entry of this.#watched) if (entry.receipts.pending()) return entry.channel;
    return undefined;
  }
}

/** Host attention never ends a slice that has run less than this. */
export const ATTENTION_MINIMUM_QUANTUM_MILLISECONDS = 0.25;
/** Nor does a long service gap make the guest wait longer than a full run slice for it. */
export const ATTENTION_MAXIMUM_QUANTUM_MILLISECONDS = 32;

/**
 * The guest's share between attention yields. Host attention may end a slice only once the slice
 * has run as long as the worker spent between the previous runnable slice and this one, serving
 * messages, so continuous host traffic leaves the guest at least as much of the worker as the
 * host takes, up to one gap. The gap after a slice that blocked or exited is idle time, not
 * service, and grants no extra quantum.
 */
export class AttentionFairness {
  #runnableEnd: number | undefined;

  /** The quantum of a slice that starts at `now`. */
  begin(now: number): number {
    const gap = this.#runnableEnd === undefined ? 0 : now - this.#runnableEnd;
    this.#runnableEnd = undefined;
    return Math.min(ATTENTION_MAXIMUM_QUANTUM_MILLISECONDS, Math.max(ATTENTION_MINIMUM_QUANTUM_MILLISECONDS, gap));
  }

  /** The slice ended at `now`; `runnable` when its guest still has work and runs again. */
  end(now: number, runnable: boolean): void {
    this.#runnableEnd = runnable ? now : undefined;
  }
}
