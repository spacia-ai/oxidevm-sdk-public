import { exactKeys, integer, record } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeAttentionCounter, type AttentionCounter } from "../host-attention.js";

/**
 * Host attention for producers on another origin. A native JS process (ADR 0023) and a System
 * assistance process (ADR 0012) run on a separate execution origin, whose broker cannot share
 * memory with the execution worker. For every message it posts to the execution worker the broker
 * also posts a one-value notice to the attention notices worker, a same-origin worker that never
 * runs guest code and counts each notice on the channel's counter. The message travels directly;
 * only the count takes the extra hop.
 */
export const ATTENTION_NOTICES_VERSION = 1;
const MAX_ID = 0x7fff_ffff;

export type AttentionNoticesRequest =
  | { readonly type: "watch"; readonly id: number; readonly port: MessagePort; readonly counter: AttentionCounter }
  | { readonly type: "release"; readonly id: number };

export function decodeAttentionNoticesRequest(value: unknown): AttentionNoticesRequest {
  const message = record(value, "attention notices request");
  if (message["version"] !== ATTENTION_NOTICES_VERSION) throw protocol("Attention notices version mismatch");
  if (message["type"] === "release") {
    exactKeys(message, ["version", "type", "id"]);
    return { type: "release", id: integer(message["id"], "attention notices ID", 1, MAX_ID) };
  }
  exactKeys(message, ["version", "type", "id", "port", "counter"]);
  const port = message["port"], counter = decodeAttentionCounter(message["counter"], "noticed");
  if (message["type"] !== "watch" || !(port instanceof MessagePort) || counter === null) throw protocol("Invalid attention notices watch");
  return { type: "watch", id: integer(message["id"], "attention notices ID", 1, MAX_ID), port, counter };
}

interface NoticesScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
}

/** The attention notices worker: counts every notice, or undeliverable notice, a watched port receives. */
export function serveAttentionNotices(scope: NoticesScope): void {
  const watched = new Map<number, MessagePort>();
  scope.onmessage = (event: MessageEvent<unknown>) => {
    const request = decodeAttentionNoticesRequest(event.data);
    if (request.type === "release") {
      watched.get(request.id)?.close();
      watched.delete(request.id);
      return;
    }
    if (watched.has(request.id)) throw protocol("Attention notices ID is already watched");
    const { port, counter } = request;
    const notice = (): void => { Atomics.add(counter, 0, 1); };
    port.onmessage = notice;
    port.onmessageerror = notice;
    port.start();
    watched.set(request.id, port);
  };
}

/** What `AttentionNotices` needs of its worker. */
export interface AttentionNoticesWorker {
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
  addEventListener(type: "error" | "messageerror", listener: () => void): void;
}

/** One cross-origin channel's notice port, for its producer, and its retirement. */
export interface AttentionNoticeChannel {
  readonly port: MessagePort;
  release(): void;
}

/** The execution worker's side: starts the notices worker on first use. A failed notices worker
 * stops counting; its channels then lose attention, never correctness (`AttentionReceipts`). */
export class AttentionNotices {
  readonly #start: () => AttentionNoticesWorker;
  #worker: AttentionNoticesWorker | undefined;
  #failed = false;
  #next = 0;

  constructor(start: () => AttentionNoticesWorker) {
    this.#start = start;
  }

  open(counter: AttentionCounter): AttentionNoticeChannel | undefined {
    if (this.#failed) return undefined;
    let worker: AttentionNoticesWorker;
    try {
      worker = this.#worker ??= this.#connect();
    } catch {
      this.#failed = true;
      return undefined;
    }
    const channel = new MessageChannel(), id = this.#next = this.#next === MAX_ID ? 1 : this.#next + 1;
    try {
      worker.postMessage({ version: ATTENTION_NOTICES_VERSION, type: "watch", id, port: channel.port2, counter }, [channel.port2]);
    } catch {
      channel.port1.close();
      return undefined;
    }
    let released = false;
    return {
      port: channel.port1,
      release: () => {
        if (released) return;
        released = true;
        channel.port1.close();
        try { worker.postMessage({ version: ATTENTION_NOTICES_VERSION, type: "release", id }, []); } catch { /* A failed worker holds no ports. */ }
      },
    };
  }

  dispose(): void {
    this.#worker?.terminate();
    this.#worker = undefined;
  }

  #connect(): AttentionNoticesWorker {
    const worker = this.#start();
    const failed = (): void => { this.#failed = true; };
    worker.addEventListener("error", failed);
    worker.addEventListener("messageerror", failed);
    return worker;
  }
}

/** The browser's notices worker, beside the execution worker that starts it. */
export function browserAttentionNoticesWorker(): AttentionNoticesWorker {
  return new Worker(new URL("./attention-notices.worker.js", import.meta.url), { type: "module", name: "oxidevm-attention-notices" });
}

function protocol(message: string): VMError {
  return new VMError("PROTOCOL_ERROR", message);
}
