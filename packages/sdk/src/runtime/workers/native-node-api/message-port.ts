import { exactKeys, integer, record } from "../../decode.js";
import { VMError } from "../../errors.js";
import type { AsyncContext } from "../assistance/async-context.js";
import { bindAsyncEvents, EventEmitter } from "../assistance/node-streams.js";
import { SharedMessageInbox } from "./message-inbox.js";
import { decodeSynchronousMessage, encodeSynchronousMessage } from "./message-serialization.js";

const PlatformChannel = globalThis.MessageChannel, PlatformPort = globalThis.MessagePort;
const platformClone = globalThis.structuredClone.bind(globalThis);
const MAX_BYTES = 64 * 1024 * 1024;
interface InboxMetadata { readonly port: MessagePort; readonly input: SharedArrayBuffer; readonly output: SharedArrayBuffer }

export interface NodeMessagePort extends EventEmitter {
  postMessage(value: unknown, transferList?: unknown): void;
  start(): void;
  ref(): this;
  unref(): this;
  hasRef(): boolean;
  readonly hasPendingOutput: boolean;
  close(): void;
}
interface NodePorts {
  readonly MessagePort: new (port: MessagePort, authority: object) => NodeMessagePort;
  readonly MessageChannel: new () => { readonly port1: NodeMessagePort; readonly port2: NodeMessagePort };
  wrap(port: MessagePort): NodeMessagePort;
  clone(input: unknown, transfers?: unknown, maximum?: number): { readonly value: unknown; readonly transfers: readonly (ArrayBuffer | MessagePort)[]; readonly bytes: number };
  receive(input: unknown): unknown;
  readonly receiveMessageOnPort: (port: unknown) => { readonly message: unknown } | undefined;
  readonly markAsUntransferable: (value: unknown) => void;
  readonly markAsUncloneable: (value: unknown) => void;
  readonly isMarkedAsUntransferable: (value: unknown) => boolean;
  readonly hasReferences: boolean;
  dispose(): void;
}

/** Node message ports keep structured-clone identity and bound unacknowledged messages. */
export function createNodePorts(context: AsyncContext, deliver: (callback: () => void) => void, changed: () => void): NodePorts {
  const token = {}, wrappers = new WeakMap<MessagePort, Port>(), ports = new Set<Port>();
  const untransferable = new WeakSet<object>(), uncloneable = new WeakSet<object>();
  function graph(input: unknown, receiving: boolean) {
    const seen = new WeakMap<object, unknown>(), buffers = new WeakSet<ArrayBufferLike>(), inboxes = new Map<MessagePort, InboxMetadata>(); let bytes = 0, nodes = 0;
    function charge(length: number): void {
      bytes += length;
      if (bytes > MAX_BYTES) throw new VMError("QUOTA_EXCEEDED", "Worker message exceeds its byte limit");
    }
    function visit(value: unknown): unknown {
      charge(typeof value === "string" ? value.length * 2 : 8);
      if (++nodes > 65536 || bytes > MAX_BYTES) throw new VMError("QUOTA_EXCEEDED", "Worker message exceeds its resource limit");
      if (typeof value !== "object" || value === null) return value;
      if (seen.has(value)) return seen.get(value);
      if (!receiving && uncloneable.has(value)) throw new DOMException("Object is marked as uncloneable", "DataCloneError");
      if (value instanceof Port) {
        const metadata = value.inbox(token); if (metadata !== undefined) inboxes.set(metadata.port, metadata);
        return value.native(token);
      }
      if (value instanceof PlatformPort) return receiving ? wrap(value) : value;
      if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer || ArrayBuffer.isView(value)) {
        const backing = ArrayBuffer.isView(value) ? value.buffer : value;
        if (!buffers.has(backing)) { buffers.add(backing); charge(backing.byteLength); }
        return value;
      }
      if (value instanceof Error) {
        seen.set(value, value);
        for (const key of ["name", "message", "stack", "cause"]) visit(Reflect.get(value, key));
        return value;
      }
      if (value instanceof RegExp) { charge(value.source.length * 2 + value.flags.length * 2); return value; }
      if (value instanceof Date || value instanceof WebAssembly.Module) return value;
      if (value instanceof Map) { const result = new Map<unknown, unknown>(); seen.set(value, result); for (const [key, entry] of value) result.set(visit(key), visit(entry)); return result; }
      if (value instanceof Set) { const result = new Set<unknown>(); seen.set(value, result); for (const entry of value) result.add(visit(entry)); return result; }
      const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
      seen.set(value, result);
      for (const key of Object.keys(value)) {
        charge(key.length * 2);
        Object.defineProperty(result, key, { value: visit(Reflect.get(value, key)), enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
    const value = visit(input); return { value, bytes, inboxes: [...inboxes.values()] };
  }
  function clone(input: unknown, transfers: unknown = [], maximum = MAX_BYTES) {
    if (!Array.isArray(transfers) || transfers.length > 64) throw new TypeError("Worker transfer list must contain at most 64 entries");
    const native = transfers.map((value: unknown): ArrayBuffer | MessagePort => {
      if ((typeof value === "object" && value !== null) && untransferable.has(value)) throw new DOMException("Object is marked as untransferable", "DataCloneError");
      if (value instanceof Port) return value.transferable(token);
      if (value instanceof ArrayBuffer || value instanceof PlatformPort) return value;
      throw new DOMException("Invalid worker transfer object", "DataCloneError");
    });
    const prepared = graph(input, false);
    if (prepared.bytes > maximum) throw new VMError("QUOTA_EXCEEDED", "Worker port has too many unacknowledged bytes");
    const bundle = platformClone({ value: prepared.value, inboxes: prepared.inboxes, transfers: native }, { transfer: native });
    for (const value of transfers) if (value instanceof Port) value.detach(token);
    return { value: { version: 1, value: bundle.value, inboxes: bundle.inboxes }, transfers: bundle.transfers, bytes: prepared.bytes };
  }
  function receive(input: unknown) {
    const envelope = record(input, "worker clone envelope"); exactKeys(envelope, ["version", "value", "inboxes"]);
    const inboxes = envelope["inboxes"];
    if (envelope["version"] !== 1 || !Array.isArray(inboxes) || inboxes.length > 64) throw new VMError("PROTOCOL_ERROR", "Worker clone version or capacity mismatch");
    const seen = new Set<MessagePort>();
    for (const value of inboxes) {
      const metadata = record(value, "transferred worker inbox"); exactKeys(metadata, ["port", "input", "output"]);
      const port = metadata["port"], input = metadata["input"], output = metadata["output"];
      if (!(port instanceof PlatformPort) || !(input instanceof SharedArrayBuffer) || !(output instanceof SharedArrayBuffer) || input === output || seen.has(port)) throw new VMError("PROTOCOL_ERROR", "Invalid transferred worker inbox");
      seen.add(port); wrap(port, new SharedMessageInbox(input), new SharedMessageInbox(output));
    }
    return graph(envelope["value"], true);
  }
  class Port extends EventEmitter {
    readonly #native: MessagePort;
    #input: SharedMessageInbox | undefined;
    #output: SharedMessageInbox | undefined;
    readonly #inflight = new Map<number, number>();
    readonly #incoming: { readonly sequence: number; readonly bytes: number; readonly value: unknown }[] = [];
    #outboundBytes = 0; #inboundBytes = 0; #sequence = 0; #received = 0; #consumed = 0;
    #closed = false; #started = false; #referenced = false; #scheduled = false;
    constructor(port: MessagePort, authority: object, input?: SharedMessageInbox, output?: SharedMessageInbox) {
      super(); if (authority !== token) throw new TypeError("Illegal MessagePort constructor"); this.#native = port; ports.add(this); wrappers.set(port, this);
      this.#input = input; this.#output = output;
      bindAsyncEvents(this, context);
      this.on("newListener", name => { if (name === "message") { this.#referenced = true; this.start(); changed(); } });
      this.on("removeListener", name => { if (name === "message" && this.listenerCount("message") === 0) { this.#referenced = false; changed(); } });
      port.onmessage = (event: MessageEvent<unknown>) => {
        if (this.#closed) return;
        try {
          const frame = record(event.data, "worker port message");
          if (frame["version"] !== 2) throw new VMError("PROTOCOL_ERROR", "Worker port version mismatch");
          if (frame["type"] === "ack") {
            exactKeys(frame, ["version", "type", "sequence"]); const sequence = integer(frame["sequence"], "worker acknowledgement", 1);
            const bytes = this.#inflight.get(sequence); if (bytes === undefined) throw new VMError("PROTOCOL_ERROR", "Stale worker acknowledgement");
            this.#inflight.delete(sequence); this.#outboundBytes -= bytes;
            changed();
          } else {
            exactKeys(frame, ["version", "type", "sequence", "bytes", "value"]);
            const sequence = integer(frame["sequence"], "worker message sequence", 1), bytes = integer(frame["bytes"], "worker message bytes", 0, MAX_BYTES);
            if (frame["type"] !== "message" || sequence !== this.#received + 1 || this.#incoming.length >= 4096 || this.#inboundBytes + bytes > MAX_BYTES) throw new VMError("PROTOCOL_ERROR", "Invalid worker message identity or capacity");
            const prepared = receive(frame["value"]);
            if (prepared.bytes > bytes) throw new VMError("PROTOCOL_ERROR", "Worker message underreports cloned bytes");
            this.#received = sequence;
            if (sequence > this.#consumed) { this.#inboundBytes += bytes; this.#incoming.push({ sequence, bytes, value: prepared.value }); this.#flush(); }
          }
        } catch (error) { this.close(); deliver(() => { this.emit("messageerror", error); }); }
      };
      port.onmessageerror = error => deliver(() => { this.emit("messageerror", error); }); port.start();
    }
    native(authority: object): MessagePort { if (authority !== token || this.#closed) throw new DOMException("MessagePort is closed or detached", "DataCloneError"); return this.#native; }
    inbox(authority: object): InboxMetadata | undefined {
      const port = this.native(authority);
      return this.#input === undefined || this.#output === undefined ? undefined : { port, input: this.#input.buffer, output: this.#output.buffer };
    }
    transferable(authority: object): MessagePort {
      // shortcut: used endpoints cannot migrate wrapper state; add a state-carrying transfer before admitting them.
      if (this.#sequence !== 0 || this.#received !== 0 || this.#consumed !== 0) throw new VMError("FEATURE_NOT_AVAILABLE", "Transferring a used MessagePort is not qualified");
      return this.native(authority);
    }
    detach(authority: object): void { if (authority !== token) throw new TypeError("Invalid port transfer"); this.#closed = true; this.#input = undefined; this.#output = undefined; ports.delete(this); changed(); }
    #flush(): void {
      if (!this.#started || this.#closed || this.#scheduled || this.#incoming.length === 0) return;
      this.#scheduled = true;
      deliver(() => {
        this.#scheduled = false;
        try {
          for (let frame = this.#incoming.shift(); frame !== undefined && !this.#closed; frame = this.#incoming.shift()) {
            this.#inboundBytes -= frame.bytes;
            this.#consume(frame.sequence);
            try { this.emit("message", frame.value); }
            finally { this.#acknowledge(frame.sequence); }
          }
        } finally { this.#flush(); }
      });
    }
    #consume(sequence: number): void {
      if (sequence !== this.#consumed + 1) throw new VMError("PROTOCOL_ERROR", "Worker inbox sequence mismatch");
      this.#input?.consume(sequence); this.#consumed = sequence;
    }
    #acknowledge(sequence: number): void { if (!this.#closed) this.#native.postMessage({ version: 2, type: "ack", sequence }); }
    take(): { readonly message: unknown } | undefined {
      if (this.#closed) return undefined;
      const pending = this.#incoming[0];
      if (pending !== undefined) {
        this.#incoming.shift(); this.#inboundBytes -= pending.bytes; this.#consume(pending.sequence); this.#acknowledge(pending.sequence);
        return { message: pending.value };
      }
      if (this.#input === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Synchronous receipt requires a worker_threads MessageChannel");
      const shared = this.#input.peek(); if (shared === undefined) return undefined;
      if (shared.bytes === null) throw new VMError("FEATURE_NOT_AVAILABLE", "This worker message requires asynchronous platform capability delivery");
      const message = receive(decodeSynchronousMessage(shared.bytes)).value; this.#consume(shared.sequence); this.#acknowledge(shared.sequence);
      return { message };
    }
    postMessage(value: unknown, transferList?: unknown): void {
      if (this.#closed) return;
      if (this.#inflight.size >= 4096) throw new VMError("QUOTA_EXCEEDED", "Worker port has too many unacknowledged messages");
      const cloned = clone(value, transferList, MAX_BYTES - this.#outboundBytes), sequence = integer(++this.#sequence, "worker message sequence", 1, 0x7fff_ffff);
      this.#inflight.set(sequence, cloned.bytes); this.#outboundBytes += cloned.bytes;
      try {
        this.#output?.publish(sequence, encodeSynchronousMessage(cloned.value), 4096 - this.#inflight.size);
        this.#native.postMessage({ version: 2, type: "message", sequence, bytes: cloned.bytes, value: cloned.value }, cloned.transfers);
      } catch (error) { this.#inflight.delete(sequence); this.#outboundBytes -= cloned.bytes; this.close(); throw error; }
    }
    start(): void { this.#started = true; this.#flush(); }
    ref(): this { this.#referenced = true; changed(); return this; }
    unref(): this { this.#referenced = false; changed(); return this; }
    hasRef(): boolean { return !this.#closed && this.#referenced; }
    get hasPendingOutput(): boolean { return !this.#closed && this.#inflight.size !== 0; }
    close(): void {
      if (this.#closed) return; this.#closed = true; this.#native.close();
      this.#input = undefined; this.#output = undefined; this.#incoming.length = 0; this.#inflight.clear(); this.#inboundBytes = 0; this.#outboundBytes = 0;
      ports.delete(this); changed(); deliver(() => { this.emit("close"); });
    }
  }
  function wrap(port: MessagePort, input?: SharedMessageInbox, output?: SharedMessageInbox): Port {
    const existing = wrappers.get(port);
    if (existing === undefined) return new Port(port, token, input, output);
    const metadata = existing.inbox(token);
    if (input !== undefined && (metadata?.input !== input.buffer || metadata.output !== output?.buffer)) throw new VMError("PROTOCOL_ERROR", "Worker inbox authority changed");
    return existing;
  }
  class Channel {
    readonly port1: Port; readonly port2: Port;
    constructor() {
      const channel = new PlatformChannel(), first = new SharedMessageInbox(), second = new SharedMessageInbox();
      this.port1 = wrap(channel.port1, first, second); this.port2 = wrap(channel.port2, second, first);
    }
  }
  return { MessagePort: Port, MessageChannel: Channel, wrap, clone,
    receive: (value: unknown): unknown => receive(value).value,
    receiveMessageOnPort: (value: unknown) => { if (!(value instanceof Port)) throw new TypeError("receiveMessageOnPort requires a MessagePort"); return value.take(); },
    markAsUntransferable(value: unknown): void { if (typeof value === "object" && value !== null) untransferable.add(value); },
    markAsUncloneable(value: unknown): void { if (typeof value === "object" && value !== null) uncloneable.add(value); },
    isMarkedAsUntransferable: (value: unknown) => typeof value === "object" && value !== null && untransferable.has(value),
    get hasReferences() { return [...ports].some(port => port.hasRef()); },
    dispose() { for (const port of ports) port.close(); },
  };
}
