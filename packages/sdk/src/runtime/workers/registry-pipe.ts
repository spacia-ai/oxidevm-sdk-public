import { VMError } from "../errors.js";
import { decodeRegistryRequest, decodeRegistryReply, type RegistryReply, type RegistryRequest } from "../protocol/registry.js";
import { decodeRegistryWire, encodeRegistryWire } from "../protocol/registry-wire.js";
import type { RegistryBudget, RegistryTransport } from "./registry-transport.js";

/** The caller supplies the authenticated pipe and bounded native stream source.
 * This window covers framing, JSON working copies, incoming chunks, and the
 * separately bounded 1 MiB outgoing queue. It stays charged through shutdown. */
export function registryBytePipe(input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>,
  traffic: Pick<RegistryBudget, "reserve" | "release">): RegistryTransport & { readonly done: Promise<void> } {
  return bytePipe(input, output, traffic, "request");
}

/** Network-to-guest half of the same authenticated framing contract. Flush the
 * terminal reply before closing; cancellation still interrupts both directions. */
export function registryReplyPipe(input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>,
  traffic: Pick<RegistryBudget, "reserve" | "release">): Omit<RegistryTransport, "send"> & {
    send(reply: RegistryReply): void; flush(): Promise<void>; readonly done: Promise<void>;
  } {
  return bytePipe(input, output, traffic, "reply");
}

function bytePipe(input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>,
  traffic: Pick<RegistryBudget, "reserve" | "release">, direction: "request" | "reply") {
  if (input.locked || output.locked) throw new VMError("PROTOCOL_ERROR", "Registry pipe is already owned");
  const reservation = traffic.reserve("data", 3 * 1024 * 1024);
  const reader = input.getReader(); const writer = output.getWriter();
  const completion = Promise.withResolvers<undefined>();
  void completion.promise.catch(() => {});
  let closing = false; let started = false;
  const isClosing = (): boolean => closing;
  let failure: unknown; let hasFailure = false;
  let failed: ((error: unknown) => void) | undefined;
  let queuedBytes = 0; let queuedEntries = 0;
  let writing = Promise.resolve(); let reading = Promise.resolve();
  let chunk: Uint8Array = new Uint8Array(); let offset = 0;

  function close(): void {
    if (isClosing()) return;
    closing = true;
    // Abort both directions independently: a blocked write must not prevent a
    // read from being cancelled. Rejected cleanup is not a retirement receipt.
    const cancel = Promise.resolve().then(() => reader.cancel());
    const abort = Promise.resolve().then(() => writer.abort());
    void Promise.allSettled([cancel, abort, writing, reading]).then(results => {
      if (results[0].status === "fulfilled" && results[1].status === "fulfilled") {
        chunk = new Uint8Array(); offset = 0;
        reader.releaseLock(); writer.releaseLock();
        traffic.release(reservation);
      }
      const rejected = results.find(result => result.status === "rejected");
      if (rejected?.status === "rejected") completion.reject(rejected.reason);
      else if (hasFailure) completion.reject(failure);
      else completion.resolve(undefined);
    }).catch(completion.reject);
  }
  function fail(error: unknown): void {
    if (!hasFailure) { failure = error; hasFailure = true; }
    close(); failed?.(error);
  }
  async function exact(length: number): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = new Uint8Array(length);
    let position = 0;
    while (position < length) {
      if (isClosing()) throw new VMError("ABORTED", "Registry pipe closed");
      if (offset === chunk.byteLength) {
        const next = await reader.read();
        if (isClosing()) throw new VMError("ABORTED", "Registry pipe closed");
        if (next.done) throw new VMError("PROTOCOL_ERROR", "Registry pipe ended before retirement");
        if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0 || next.value.byteLength > 65_536) {
          throw new VMError("PROTOCOL_ERROR", "Invalid registry pipe fragment");
        }
        chunk = next.value; offset = 0;
      }
      const count = Math.min(length - position, chunk.byteLength - offset);
      bytes.set(chunk.subarray(offset, offset + count), position);
      offset += count; position += count;
    }
    return bytes;
  }
  return {
    done: completion.promise,
    start(receive: (value: unknown) => void, onFailure: (error: unknown) => void) {
      if (started || closing) throw new VMError("PROTOCOL_ERROR", "Registry pipe already started or closed");
      started = true; failed = onFailure;
      reading = (async () => {
        while (!isClosing()) {
          const prefix = await exact(4);
          const size = new DataView(prefix.buffer).getUint32(0, true);
          if (size < 4 || size > 128 * 1024) throw new VMError("PROTOCOL_ERROR", "Invalid registry pipe frame size");
          const frame = await exact(size);
          if (isClosing()) return;
          const message = direction === "request" ? decodeRegistryWire(frame, "reply") : decodeRegistryWire(frame, "request");
          receive(message);
          // The network owner owes only its terminal reply after retirement.
          // Do not mistake the peer closing its writer for a fresh read failure.
          if (direction === "reply" && message.kind === "retire") return;
        }
      })().catch((error: unknown) => { if (!isClosing()) fail(error); });
    },
    send(value: unknown) {
      if (!started || closing) throw new VMError("ABORTED", "Registry pipe is inactive");
      const decoded = direction === "request" ? decodeRegistryRequest(value) : decodeRegistryReply(value);
      const charge = queueBytes(decoded);
      if (queuedEntries >= 128 || queuedBytes + charge > 1024 * 1024) throw new VMError("QUOTA_EXCEEDED", "Registry pipe queue exhausted");
      // A port transfers buffers immediately. A byte writer queues them, so own
      // a copy before returning to the sender, after reserving its queue space.
      const message = decoded.kind === "data" ? { ...decoded, bytes: decoded.bytes.slice() } : decoded;
      queuedBytes += charge; queuedEntries++;
      writing = writing.then(async () => {
        if (isClosing()) return;
        const bytes = encodeRegistryWire(message, direction);
        // The prefix rides with the frame and slices fill the peer's admitted
        // 65,536-byte writes: each slice is one credited guest exchange.
        const frame = new Uint8Array(4 + bytes.byteLength);
        new DataView(frame.buffer).setUint32(0, bytes.byteLength, true);
        frame.set(bytes, 4);
        for (let position = 0; position < frame.byteLength; position += 65_536) {
          if (isClosing()) return;
          await writer.write(frame.slice(position, position + 65_536));
        }
      }).catch((error: unknown) => { if (!isClosing()) fail(error); }).finally(() => { queuedBytes -= charge; queuedEntries--; });
    },
    async flush(): Promise<void> {
      await writing;
      if (hasFailure) throw failure;
      if (isClosing()) throw new VMError("ABORTED", "Registry pipe closed before flushing");
    },
    close,
  };
}

function queueBytes(message: RegistryRequest | RegistryReply): number {
  switch (message.kind) {
    case "start": return 512 + message.url.length * 2;
    case "data": return 1024 + message.bytes.byteLength * 2;
    case "headers": return 1024 + message.headers.reduce((total, [name, value]) => total + 2 * (name.length + value.length), 0);
    case "failure": return 2048 + message.error.message.length * 2;
    case "retired": return 4096;
    case "started": case "read": case "cancel": case "cancelled":
    case "retire": case "acknowledge": case "acknowledge-control": return 512;
  }
}
