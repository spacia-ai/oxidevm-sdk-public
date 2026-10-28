import { Buffer } from "buffer";
import { type Duplex, Readable, Stream, Writable } from "readable-stream";
import EventEmitter from "events/";
import browserProcess from "process/";
import { VMError, deserializeError, serializeUnknownError } from "../../errors.js";
import { ASSISTANCE_LIMITS } from "../../protocol/assistance.js";
import type { AsyncContext } from "./async-context.js";

export { EventEmitter, Readable, Writable };

/** One builtin per isolated process. Reuse the pinned implementation, including
 * its Stream constructor identity and promisify descriptors. Its private task
 * scheduler cannot capture our async context, so bind completion callbacks here. */
export function createNodeStreamModule(context: AsyncContext, retain: () => () => void, dispatch: (callback: () => void) => void = browserProcess.nextTick, stdio?: { readonly stdout: Writable; readonly stderr: Writable }) {
  const restore: (() => void)[] = [];
  if (stdio !== undefined) for (const name of ["stdout", "stderr"] as const) {
    const previous = Object.getOwnPropertyDescriptor(browserProcess, name);
    // The pinned stream library exempts these exact identities from pipe EOF.
    Object.defineProperty(browserProcess, name, { configurable: true, writable: true, value: stdio[name] });
    restore.push(() => { if (previous === undefined) Reflect.deleteProperty(browserProcess, name); else Object.defineProperty(browserProcess, name, previous); });
  }
  for (const name of ["pipeline", "finished"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(Stream, name);
    const operation: unknown = descriptor?.value;
    if (descriptor === undefined || typeof operation !== "function") throw new TypeError(`Missing stream.${name}`);
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      const callback = args.at(-1);
      if (typeof callback === "function") {
        const run = context.capture();
        args[args.length - 1] = function (this: unknown, ...values: unknown[]): unknown {
          return run(() => { const result: unknown = Reflect.apply(callback, this, values); return result; });
        };
      }
      const result: unknown = Reflect.apply(operation, this, args);
      return result;
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(operation));
    Object.defineProperty(Stream, name, { ...descriptor, value: wrapped });
    restore.push(() => { Object.defineProperty(Stream, name, descriptor); });
  }
  // The library's private browser nextTick queue bypasses application timers.
  // Account each scheduled callback, not stream objects: an unused stream must
  // not keep a process alive, while queued completion work must retire first.
  const nextTick = browserProcess.nextTick;
  browserProcess.nextTick = (callback, ...args) => {
    if (typeof callback !== "function") throw new TypeError("nextTick requires a function");
    const run = context.capture();
    const release = retain();
    try {
      dispatch(() => {
        try { run(() => callback(...args)); } finally { release(); }
      });
    } catch (error) { release(); throw error; }
  };
  restore.push(() => { browserProcess.nextTick = nextTick; });
  return { module: Stream, restore: () => { for (const reset of restore.splice(0).reverse()) reset(); } };
}

export function streamError(error: unknown): Error {
  return error instanceof Error ? error : deserializeError(serializeUnknownError(error));
}

/** Only asynchronous resource adapters bind registrations. The exported plain
 * EventEmitter keeps synchronous emit semantics and the emitter's context. */
export function bindAsyncEvents(emitter: EventEmitter, context: AsyncContext): void {
  const on = emitter.on.bind(emitter);
  const prepend = emitter.prependListener.bind(emitter);
  function subscribe(event: string | symbol, listener: (...args: unknown[]) => void, once: boolean, first = false): EventEmitter {
    if (typeof listener !== "function") throw new TypeError("Event listener must be a function");
    const run = context.capture();
    const wrapped = (...args: unknown[]) => {
      if (once) emitter.removeListener(event, wrapped);
      run(() => { Reflect.apply(listener, emitter, args); });
    };
    Object.defineProperty(wrapped, "listener", { value: listener });
    return (first ? prepend : on)(event, wrapped);
  }
  Object.defineProperties(emitter, {
    on: { configurable: true, writable: true, value: (event: string | symbol, listener: (...args: unknown[]) => void) => subscribe(event, listener, false) },
    addListener: { configurable: true, writable: true, value: (event: string | symbol, listener: (...args: unknown[]) => void) => subscribe(event, listener, false) },
    once: { configurable: true, writable: true, value: (event: string | symbol, listener: (...args: unknown[]) => void) => subscribe(event, listener, true) },
    prependListener: { configurable: true, writable: true, value: (event: string | symbol, listener: (...args: unknown[]) => void) => subscribe(event, listener, false, true) },
    prependOnceListener: { configurable: true, writable: true, value: (event: string | symbol, listener: (...args: unknown[]) => void) => subscribe(event, listener, true, true) },
  });
}

/** Capture queued write/end callbacks at registration, for both writable and
 * duplex adapters. The pinned stream still owns its queue and completion order. */
export function bindAsyncWritable(output: Writable | Duplex, context: AsyncContext): void {
  const write = output.write.bind(output);
  const end = output.end.bind(output);
  Object.defineProperties(output, {
    end: { configurable: true, writable: true, value: (...args: unknown[]) => {
      if (args.length > 3) throw new TypeError("Unsupported stream end arguments");
      const [data, second, third] = args;
      const callback = typeof data === "function" ? data : typeof second === "function" ? second : third;
      if (callback !== undefined && typeof callback !== "function") throw new TypeError("Invalid stream end callback");
      if (typeof data === "function" && args.length !== 1) throw new TypeError("Unsupported stream end arguments");
      if (data !== undefined && data !== null && typeof data !== "function") {
        if (second === undefined || typeof second === "function") output.write(data);
        else if (typeof second === "string") output.write(data, second);
        else throw new TypeError("Invalid stream end encoding");
      } else if (second !== undefined || third !== undefined) throw new TypeError("Unsupported stream end arguments");
      const run = context.capture();
      end(error => { if (callback !== undefined) run(() => { Reflect.apply(callback, output, error === undefined ? [] : [error]); }); });
      return output;
    } },
    write: { configurable: true, writable: true, value: (...args: unknown[]) => {
      const [value, second, third] = args;
      if (args.length > 3 || (typeof value !== "string" && !(value instanceof Uint8Array))) {
        throw new TypeError("Only strings and binary stream writes are supported");
      }
      const callback = typeof second === "function" ? second : third;
      if ((second !== undefined && typeof second !== "function" && (typeof second !== "string" || !Buffer.isEncoding(second)))
        || (callback !== undefined && typeof callback !== "function")) throw new TypeError("Unsupported stream write arguments");
      const bytes = typeof value === "string" ? Buffer.from(value, typeof second === "string" ? second : "utf8") : value;
      if (output.writableLength + bytes.byteLength > ASSISTANCE_LIMITS.stream) {
        throw new VMError("QUOTA_EXCEEDED", "Writable stream queue exhausted");
      }
      const run = context.capture();
      return write(bytes, error => {
        if (callback !== undefined) run(() => { Reflect.apply(callback, output, error === undefined ? [] : [error]); });
      });
    } },
  });
}

/** Writable's existing queue owns ordering/backpressure; the Linux/browser
 * acknowledgement completes each write. Capture user callbacks at registration. */
export function createOutputStream(
  send: (bytes: Uint8Array) => Promise<void> | void, context: AsyncContext,
  end?: () => Promise<void>,
): Writable {
  const output = new Writable({ highWaterMark: ASSISTANCE_LIMITS.chunk, autoDestroy: false,
    write(chunk, _encoding, complete) {
      if (!(chunk instanceof Uint8Array)) { complete(new TypeError("Invalid stream chunk")); return; }
      try {
        const sent = send(chunk);
        if (sent === undefined) complete();
        else void sent.then(() => complete(), (error: unknown) => complete(streamError(error)));
      } catch (error) { complete(streamError(error)); }
    },
    final(complete) {
      if (end === undefined) { complete(); return; }
      void end().then(() => complete(), (error: unknown) => complete(streamError(error)));
    },
  });
  bindAsyncEvents(output, context);
  bindAsyncWritable(output, context);
  return output;
}

export function createInputStream(context: AsyncContext) {
  let eof = false;
  const closed = new AbortController();
  const readRequested = Promise.withResolvers<undefined>();
  const pending = new Set<PromiseWithResolvers<undefined>>();
  const ended = Promise.withResolvers<undefined>();
  const stream = new Readable({ highWaterMark: ASSISTANCE_LIMITS.chunk, autoDestroy: false,
    read() { readRequested.resolve(undefined); for (const item of pending) item.resolve(undefined); pending.clear(); },
    destroy(error, complete) { closed.abort(); complete(error); },
  });
  bindAsyncEvents(stream, context);
  stream.on("end", () => ended.resolve(undefined));
  stream.on("close", () => {
    for (const item of pending) item.resolve(undefined);
    pending.clear(); ended.resolve(undefined);
  });
  const run = context.capture();
  return {
    stream,
    closed: closed.signal,
    readRequested: readRequested.promise,
    get hasReferences() { return !eof && !stream.destroyed && (stream.listenerCount("data") !== 0 || stream.listenerCount("readable") !== 0); },
    async idle(): Promise<void> {
      if (!eof && !stream.destroyed && (stream.listenerCount("data") !== 0 || stream.listenerCount("readable") !== 0)) await ended.promise;
    },
    async receive(bytes: Uint8Array | null): Promise<void> {
      if (stream.destroyed) return;
      if (eof) throw new VMError("ABORTED", "Input stream is closed");
      if (bytes === null) { eof = true; run(() => stream.push(null)); return; }
      if (bytes.length > ASSISTANCE_LIMITS.chunk || stream.readableLength + bytes.length > ASSISTANCE_LIMITS.stream) {
        throw new VMError("QUOTA_EXCEEDED", "Input stream queue exhausted");
      }
      if (run(() => stream.push(bytes)) || stream.readableLength < ASSISTANCE_LIMITS.chunk) return;
      const item = Promise.withResolvers<undefined>(); pending.add(item); await item.promise;
    },
  };
}

export function isEventListener(value: unknown): value is (...args: unknown[]) => void { return typeof value === "function"; }
