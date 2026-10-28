import { exactKeys, integer, record, string } from "../decode.js";
import { decodeSerializedError, deserializeError, normalizeStorageError, serializeUnknownError, VMError } from "../errors.js";
import { decodeBytes } from "../protocol/decoders.js";
import { SNAPSHOT_CHANNEL_VERSION } from "./snapshot-channel.js";
import { SNAPSHOT_CHUNK_BYTES } from "./snapshot-manifest.js";

/** How many chunks the storage owner reads ahead of the restoring core, concurrently. */
export const RESTORE_STREAM_WINDOW = 8;

export type RestoreChunkArea = "ram" | "disk-base" | "disk-overlay" | "native-graph" | "native-payloads";

/** One chunk a restore needs; `read` returns its verified bytes in a buffer of their own. */
export interface RestoreStreamChunk {
  readonly area: RestoreChunkArea;
  readonly index: number;
  readonly read: () => Promise<Uint8Array<ArrayBuffer>>;
}

export interface RestoredChunk {
  readonly area: RestoreChunkArea;
  readonly index: number;
  readonly data: Uint8Array;
}

type ReaderMessage = { readonly type: "credit"; readonly count: number } | { readonly type: "cancel" };

type StreamMessage =
  | { readonly type: "chunk"; readonly sequence: number; readonly area: RestoreChunkArea; readonly index: number; readonly data: Uint8Array }
  | { readonly type: "end"; readonly count: number }
  | { readonly type: "error"; readonly error: VMError };

/**
 * Streams `chunks` in order over `port` (snapshot channel v8). The reader grants credit; up to
 * RESTORE_STREAM_WINDOW chunks are read concurrently ahead of it, each exactly once, and each
 * chunk's buffer is transferred. A failed read ends the stream with that error. Resolves after
 * the last chunk; rejects with ABORTED when the reader cancels or `signal` aborts.
 */
export async function serveRestoreStream(
  port: MessagePort,
  chunks: readonly RestoreStreamChunk[],
  signal: AbortSignal,
  window: 4 | 8 = RESTORE_STREAM_WINDOW,
): Promise<void> {
  const reads: Promise<Uint8Array<ArrayBuffer>>[] = [];
  let sent = 0;
  // Starts every read the reader's credit and the window allow; runs again on each grant.
  const readAhead = (granted: number): void => {
    for (let chunk = chunks[reads.length]; chunk !== undefined; chunk = chunks[reads.length]) {
      if (reads.length >= granted || reads.length - sent >= window) return;
      const read = chunk.read();
      // A read started ahead may fail after the stream has already stopped.
      void read.catch(() => undefined);
      reads.push(read);
    }
  };
  const credit = new StreamCredit(port, signal, readAhead);
  try {
    for (const chunk of chunks) {
      while (reads.length === sent) await credit.next();
      const pending = reads[sent];
      if (pending === undefined) throw new VMError("PROTOCOL_ERROR", "restore stream read is missing");
      const read = await credit.guard(pending);
      const data = read.byteOffset === 0 && read.byteLength === read.buffer.byteLength ? read : read.slice();
      port.postMessage(
        { version: SNAPSHOT_CHANNEL_VERSION, type: "chunk", sequence: sent, area: chunk.area, index: chunk.index, data },
        [data.buffer],
      );
      sent += 1;
      readAhead(credit.granted);
    }
    port.postMessage({ version: SNAPSHOT_CHANNEL_VERSION, type: "end", count: chunks.length });
  } catch (error) {
    if (!credit.cancelled) {
      port.postMessage({
        version: SNAPSHOT_CHANNEL_VERSION,
        type: "error",
        error: serializeUnknownError(normalizeStorageError(error)),
      });
    }
    throw error;
  } finally {
    credit.close();
    await Promise.allSettled(reads);
  }
}

/** The reader's side of a restore stream: chunks in order, with credit returned as each is taken. */
export class RestoreStreamReader {
  readonly #port: MessagePort;
  readonly #ready: RestoredChunk[] = [];
  readonly #window: 4 | 8;
  #sequence = 0;
  #ended = false;
  #failure: VMError | undefined;
  #wake: (() => void) | undefined;

  constructor(port: MessagePort, window: 4 | 8 = RESTORE_STREAM_WINDOW) {
    this.#port = port;
    this.#window = window;
    port.addEventListener("message", (event: MessageEvent<unknown>) => this.#receive(event.data));
    port.addEventListener("messageerror", () => {
      this.#stop(new VMError("PROTOCOL_ERROR", "a restore stream message could not be decoded"));
    });
    port.start();
    this.#post({ type: "credit", count: window });
  }

  /** The next chunk in stream order, or `undefined` after the last one. */
  async next(): Promise<RestoredChunk | undefined> {
    await this.ready();
    if(this.#failure!==undefined)throw this.#failure;
    const chunk = this.#ready.shift();
    if (chunk !== undefined && !this.#ended) this.#post({ type: "credit", count: 1 });
    return chunk;
  }

  /** Waits until the next chunk or the end has arrived, without taking it. */
  async ready(): Promise<void> {
    while (this.#ready.length === 0 && !this.#ended) {
      if (this.#failure !== undefined) throw this.#failure;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  /**
   * Stops the stream with `reason` (ABORTED by default); the storage owner stops reading and
   * settles its request. Does nothing once the stream has ended.
   */
  cancel(reason = new VMError("ABORTED", "restore stream cancelled")): void {
    if (this.#ended) return;
    if (this.#failure === undefined) this.#post({ type: "cancel" });
    this.#stop(reason);
  }

  #receive(value: unknown): void {
    if (this.#failure !== undefined || this.#ended) return;
    let message: StreamMessage;
    try {
      message = decodeStreamMessage(value);
    } catch (error) {
      this.#stop(error instanceof VMError ? error : new VMError("PROTOCOL_ERROR", String(error)));
      return;
    }
    if (message.type === "error") {
      this.#stop(message.error);
    } else if (message.type === "end") {
      if (message.count !== this.#sequence) {
        this.#stop(new VMError("PROTOCOL_ERROR", "the restore stream ended early"));
        return;
      }
      this.#ended = true;
      this.#port.close();
    } else if (message.sequence !== this.#sequence || this.#ready.length >= this.#window) {
      this.#stop(new VMError("PROTOCOL_ERROR", "a restore stream chunk is out of sequence"));
      return;
    } else {
      this.#sequence += 1;
      this.#ready.push({ area: message.area, index: message.index, data: message.data });
    }
    this.#signal();
  }

  #stop(error: VMError): void {
    this.#failure ??= error;
    this.#ready.length=0;
    this.#port.close();
    this.#signal();
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  #post(message: ReaderMessage): void {
    this.#port.postMessage({ version: SNAPSHOT_CHANNEL_VERSION, ...message });
  }
}

/** The credit a reader has granted, and its cancellation or the storage request's abort. */
class StreamCredit {
  granted = 0;
  cancelled = false;
  readonly #port: MessagePort;
  readonly #signal: AbortSignal;
  readonly #granted: (granted: number) => void;
  readonly #stopped = Promise.withResolvers<never>();
  #waiter: (() => void) | undefined;

  constructor(port: MessagePort, signal: AbortSignal, granted: (granted: number) => void) {
    this.#port = port;
    this.#signal = signal;
    this.#granted = granted;
    void this.#stopped.promise.catch(() => undefined);
    port.addEventListener("message", this.#receive);
    port.addEventListener("messageerror", this.#undecodable);
    signal.addEventListener("abort", this.#abort, { once: true });
    port.start();
    if (signal.aborted) this.#abort();
  }

  /** Waits for the reader's next grant. */
  next(): Promise<void> {
    return this.guard(new Promise<void>((resolve) => {
      this.#waiter = resolve;
    }));
  }

  /** `promise`, unless the stream stops first. */
  guard<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.#stopped.promise]);
  }

  close(): void {
    this.#port.removeEventListener("message", this.#receive);
    this.#port.removeEventListener("messageerror", this.#undecodable);
    this.#signal.removeEventListener("abort", this.#abort);
    this.#port.close();
  }

  readonly #receive = (event: MessageEvent<unknown>): void => {
    let message: ReaderMessage;
    try {
      message = decodeReaderMessage(event.data);
    } catch (error) {
      this.#stopped.reject(error instanceof VMError ? error : new VMError("PROTOCOL_ERROR", String(error)));
      return;
    }
    if (message.type === "cancel") {
      this.cancelled = true;
      this.#stopped.reject(new VMError("ABORTED", "restore stream cancelled"));
      return;
    }
    this.granted += message.count;
    this.#granted(this.granted);
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.();
  };

  readonly #undecodable = (): void => {
    this.#stopped.reject(new VMError("PROTOCOL_ERROR", "a restore stream message could not be decoded"));
  };

  readonly #abort = (): void => {
    this.#stopped.reject(new VMError("ABORTED", "restore stream request aborted"));
  };
}

function decodeReaderMessage(value: unknown): ReaderMessage {
  const message = record(value, "restore stream reader message");
  decodeVersion(message["version"]);
  const type = string(message["type"], "restore stream reader message type");
  if (type === "cancel") {
    exactKeys(message, ["version", "type"]);
    return { type };
  }
  if (type !== "credit") throw new VMError("PROTOCOL_ERROR", "restore stream reader message is invalid");
  exactKeys(message, ["version", "type", "count"]);
  return { type, count: integer(message["count"], "restore stream credit", 1, RESTORE_STREAM_WINDOW) };
}

function decodeStreamMessage(value: unknown): StreamMessage {
  const message = record(value, "restore stream message");
  decodeVersion(message["version"]);
  const type = string(message["type"], "restore stream message type");
  switch (type) {
    case "chunk": {
      exactKeys(message, ["version", "type", "sequence", "area", "index", "data"]);
      const area = message["area"];
      if (area !== "ram" && area !== "disk-base" && area !== "disk-overlay" && area !== "native-graph" && area !== "native-payloads") {
        throw new VMError("PROTOCOL_ERROR", "restore stream chunk area is invalid");
      }
      const data=decodeBytes(message["data"]);
      if((area==="native-graph"||area==="native-payloads")&&data.length>SNAPSHOT_CHUNK_BYTES)throw new VMError("PROTOCOL_ERROR","Native restore stream exceeds its byte bound");
      return {
        type,
        sequence: integer(message["sequence"], "restore stream sequence", 0),
        area,
        index: integer(message["index"], "restore stream chunk index", 0),
        data,
      };
    }
    case "end":
      exactKeys(message, ["version", "type", "count"]);
      return { type, count: integer(message["count"], "restore stream chunk count", 0) };
    case "error":
      exactKeys(message, ["version", "type", "error"]);
      return { type, error: deserializeError(decodeSerializedError(message["error"])) };
    default:
      throw new VMError("PROTOCOL_ERROR", "restore stream message is invalid");
  }
}

function decodeVersion(value: unknown): void {
  integer(value, "restore stream version", SNAPSHOT_CHANNEL_VERSION, SNAPSHOT_CHANNEL_VERSION);
}
