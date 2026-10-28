import { exactKeys, record } from "../../decode.js";
import { VMError } from "../../errors.js";
import { ASSISTANCE_LIMITS } from "../../protocol/assistance.js";
import type { AsyncContext } from "./async-context.js";

const encoder = new TextEncoder();

/** In-band credit per direction: a sender may have this many serialized bytes
 * unacknowledged; later messages queue and send() reports the backlog. */
export const IPC_WINDOW_BYTES = ASSISTANCE_LIMITS.stream / 2;
const MESSAGE_BYTES = ASSISTANCE_LIMITS.stream;
const QUEUE_BYTES = ASSISTANCE_LIMITS.pending;

/** One end of a fork IPC channel: JSON messages over a private MessagePort
 * that never touches the broker, control or Linux. Node's json serialization
 * only; the channel keeps a process alive through its message listeners. */
export interface IpcChannel {
  readonly connected: boolean;
  readonly hasReferences: boolean;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
  disconnect(): void;
  ref(): void;
  unref(): void;
  setListeners(count: number): void;
}
export interface IpcOptions {
  readonly context: AsyncContext;
  readonly deliver: (callback: () => void) => void;
  readonly onMessage: (value: unknown) => void;
  readonly onDisconnect: () => void;
}
interface Queued { readonly text: string; readonly bytes: number; readonly callback: ((error: Error | null) => void) | undefined }

function channelClosed(): Error {
  return Object.assign(new Error("Channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" });
}

export function createIpcChannel(port: MessagePort, options: IpcOptions): IpcChannel {
  // The runtime creates the channel before any application code runs, so these
  // bound methods are the trusted port operations whatever the app installs later.
  const post = port.postMessage.bind(port);
  const close = port.close.bind(port);
  const start = port.start.bind(port);
  const { deliver } = options;
  const run = options.context.capture();
  const queue: Queued[] = [];
  const sent: Pick<Queued, "bytes" | "callback">[] = [];
  let connected = true;
  let referenced = true;
  let listeners = 0;
  let inFlight = 0;
  let queuedBytes = 0;
  function flush(): void {
    for (let next = queue[0]; connected && next !== undefined; next = queue[0]) {
      if (inFlight !== 0 && inFlight + next.bytes > IPC_WINDOW_BYTES) return;
      queue.shift();
      queuedBytes -= next.bytes;
      inFlight += next.bytes;
      sent.push({ bytes: next.bytes, callback: next.callback });
      post({ message: next.text });
    }
  }
  function end(): void {
    if (!connected) return;
    connected = false;
    port.onmessage = null; port.onmessageerror = null;
    close();
    for (const { callback } of [...queue.splice(0), ...sent.splice(0)]) {
      if (callback !== undefined) deliver(() => run(() => { callback(channelClosed()); }));
    }
    queuedBytes = 0;
    deliver(() => run(() => { options.onDisconnect(); }));
  }
  port.onmessage = (event: MessageEvent<unknown>) => {
    try {
      const frame = record(event.data, "ipc frame");
      if ("message" in frame) {
        exactKeys(frame, ["message"]);
        const text = frame["message"];
        if (typeof text !== "string" || text.length > MESSAGE_BYTES) throw new VMError("PROTOCOL_ERROR", "Invalid IPC message");
        const value: unknown = JSON.parse(text);
        const bytes = encoder.encode(text).byteLength;
        if (bytes > MESSAGE_BYTES) throw new VMError("PROTOCOL_ERROR", "IPC message exceeds its byte limit");
        deliver(() => run(() => { options.onMessage(value); }));
        if (connected) post({ ack: bytes });
      } else if ("ack" in frame) {
        exactKeys(frame, ["ack"]);
        const bytes = frame["ack"];
        const next = sent[0];
        if (next === undefined || bytes !== next.bytes) throw new VMError("PROTOCOL_ERROR", "Invalid IPC acknowledgement");
        sent.shift();
        inFlight -= bytes;
        const callback = next.callback; if (callback !== undefined) deliver(() => run(() => { callback(null); }));
        flush();
      } else {
        exactKeys(frame, ["disconnect"]);
        if (frame["disconnect"] !== true) throw new VMError("PROTOCOL_ERROR", "Invalid IPC disconnect");
        end();
      }
    } catch { end(); }
  };
  port.onmessageerror = () => { end(); };
  start();
  return {
    get connected() { return connected; },
    get hasReferences() { return connected && ((referenced && listeners > 0) || inFlight !== 0 || queue.length !== 0); },
    send(message, callback) {
      if (callback !== undefined && typeof callback !== "function") throw new TypeError("The IPC send callback must be a function");
      if (message === undefined) throw Object.assign(new TypeError('The "message" argument must be specified'), { code: "ERR_MISSING_ARGS" });
      if (typeof message === "function" || typeof message === "symbol" || typeof message === "bigint") throw new TypeError("IPC messages must be JSON-serializable");
      if (!connected) {
        const error = channelClosed();
        if (callback === undefined) throw error;
        deliver(() => run(() => { callback(error); }));
        return false;
      }
      const text = JSON.stringify(message);
      if (typeof text !== "string") throw new TypeError("IPC messages must be JSON-serializable");
      const bytes = encoder.encode(text).byteLength;
      if (bytes > MESSAGE_BYTES || queuedBytes + bytes > QUEUE_BYTES || queue.length + sent.length >= 4096) throw new VMError("QUOTA_EXCEEDED", "IPC message or backlog exceeds its limit");
      queue.push({ text, bytes, callback });
      queuedBytes += bytes;
      flush();
      return queue.length === 0;
    },
    disconnect() {
      if (!connected) return;
      post({ disconnect: true });
      end();
    },
    ref() { referenced = true; },
    unref() { referenced = false; },
    setListeners(count) { listeners = count; },
  };
}
