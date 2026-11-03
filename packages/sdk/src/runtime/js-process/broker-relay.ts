import { exactKeys, integer, record } from "../decode.js";
import { JS_MAILBOX_BYTES, JS_MAX_OPERATION, JS_PROCESS_PROTOCOL_VERSION, protocol } from "./codec.js";
import { writeWorkerMailbox } from "./worker-mailbox.js";

/**
 * The relay core of a broker on another origin (the native execution broker, ADR 0023, and the module frame's broker,
 * ADR 0028). A process worker's Linux requests arrive on a local channel; shared memory stays on the broker's side, so
 * each request goes upstream to the execution worker as an asynchronous message, with one notice to the attention port,
 * and a synchronous request's reply is written back into the broker's own mailbox. Every message from the process
 * worker is hostile input: exact keys, bounded payloads, at most 38 pending requests; a malformed one fails only its
 * own process.
 */
export interface BrokerRelayOptions {
  /** Ends this process: a malformed message, from either side. */
  readonly fail: (error: unknown) => void;
  /** Requests must arrive in sequence (the module broker); the native broker keeps its looser check. */
  readonly sequential?: boolean;
  /** Upstream messages other than replies, in order with them; returns false for a message it does not know. */
  readonly control?: (message: Readonly<Record<string, unknown>>) => boolean;
  /** The process worker's messages other than requests: true forwards the checked message upstream, counted. */
  readonly local?: (message: Readonly<Record<string, unknown>>) => boolean;
  /** Called after each upstream message, so the broker can retry what waits on the process (interrupts). */
  readonly after?: () => void;
  /** An errno to answer a request with here, without forwarding it (the module broker's reach check); undefined forwards it. */
  readonly refuse?: (operation: number, payload: Uint8Array) => number | undefined;
}

export interface BrokerRelay {
  /** The process worker's mailbox; the worker waits in it for synchronous replies. */
  readonly mailbox: SharedArrayBuffer;
  /** The process worker's end of the local request channel. */
  readonly port: MessagePort;
  /** Posts a message to the process worker on its request channel (the broker's signal nudge). */
  post(message: unknown): void;
  /** Connects the execution worker's service port and the attention notices port. Once. */
  attach(upstream: MessagePort, attention: MessagePort | null): void;
  /** Wakes a worker waiting in its mailbox and closes every port. */
  close(): void;
}

const MAX_PENDING = 38;

export function createBrokerRelay(options: BrokerRelayOptions): BrokerRelay {
  const local = new MessageChannel(), mailbox = new SharedArrayBuffer(JS_MAILBOX_BYTES), header = new Int32Array(mailbox, 0, 4), body = new Uint8Array(mailbox, 16);
  // Pending requests by the sequence the Userspace worker sees. That stream has no gaps (the worker ends a process whose
  // requests skip one), so each request the broker answers itself shifts every later one down by one; replies are mapped
  // back to the process's own sequence.
  const pending = new Map<number, { readonly sequence: number; readonly sync: boolean }>();
  let upstream: MessagePort | undefined, attention: MessagePort | null = null, last = 0, refusals = 0, closed = false;
  local.port1.onmessage = (event: MessageEvent<unknown>) => {
    try {
      if (upstream === undefined) protocol("Broker service port is absent");
      const request = record(event.data, "relayed Linux request");
      if (request["type"] !== "request" && options.local?.(request) === true) { attention?.postMessage(null); upstream.postMessage(request); return; }
      exactKeys(request, ["version", "type", "sequence", "sync", "operation", "payload"]);
      const sequence = integer(request["sequence"], "Linux request sequence", 1, 0x7fff_ffff);
      if (request["version"] !== JS_PROCESS_PROTOCOL_VERSION || request["type"] !== "request" || typeof request["sync"] !== "boolean" || !(request["payload"] instanceof Uint8Array) || request["payload"].byteLength > JS_MAILBOX_BYTES || pending.has(sequence - refusals) || pending.size >= MAX_PENDING) protocol("Malformed relayed Linux request");
      if (options.sequential === true && sequence !== last + 1) protocol("Relayed Linux request out of sequence");
      integer(request["operation"], "Linux request operation", 0, JS_MAX_OPERATION);
      last = sequence;
      const refused = options.refuse?.(integer(request["operation"], "Linux request operation", 0, JS_MAX_OPERATION), request["payload"]);
      if (refused !== undefined) {
        refusals++;
        if (request["sync"]) writeWorkerMailbox(header, body, sequence, refused, 0n, new Uint8Array());
        else local.port1.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "reply", sequence, errno: refused, value: 0n, payload: new Uint8Array() });
        return;
      }
      const forwarded = integer(sequence - refusals, "forwarded Linux request sequence", 1, 0x7fff_ffff);
      pending.set(forwarded, { sequence, sync: request["sync"] });
      // Shared memory stays on this side. The execution worker receives the same bounded request asynchronously,
      // and its attention counter one notice for it.
      attention?.postMessage(null);
      upstream.postMessage({ ...request, sequence: forwarded, sync: false });
    } catch (error) { options.fail(error); }
  };
  local.port1.onmessageerror = options.fail; local.port1.start();
  const reply = (input: Readonly<Record<string, unknown>>): void => {
    exactKeys(input, ["version", "type", "sequence", "errno", "value", "payload"]);
    const forwarded = integer(input["sequence"], "Linux reply sequence", 1, 0x7fff_ffff), request = pending.get(forwarded);
    if (input["version"] !== JS_PROCESS_PROTOCOL_VERSION || input["type"] !== "reply" || request === undefined || typeof input["value"] !== "bigint" || !(input["payload"] instanceof Uint8Array) || input["payload"].byteLength > JS_MAILBOX_BYTES - 64) protocol("Malformed relayed Linux reply");
    const errno = integer(input["errno"], "Linux reply errno", 0, 4095); pending.delete(forwarded);
    if (request.sync) writeWorkerMailbox(header, body, request.sequence, errno, input["value"], input["payload"]);
    else local.port1.postMessage({ ...input, sequence: request.sequence });
  };
  return {
    mailbox, port: local.port2,
    post(message) { if (!closed) local.port1.postMessage(message); },
    attach(port, notices) {
      if (upstream !== undefined) protocol("Broker service port is already attached");
      upstream = port; attention = notices;
      port.onmessage = (event: MessageEvent<unknown>) => {
        try {
          const input = record(event.data, "relayed Linux reply");
          if (input["type"] !== "reply" && options.control?.(input) === true) return;
          reply(input);
        } catch (error) { options.fail(error); }
        finally { options.after?.(); }
      };
      port.onmessageerror = options.fail; port.start();
    },
    close() {
      if (closed) return; closed = true;
      // Chromium can retain a terminated worker until its synchronous wait wakes.
      Atomics.notify(header, 0);
      local.port1.close(); upstream?.close(); attention?.close();
    },
  };
}
