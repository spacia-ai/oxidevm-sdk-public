import { Buffer } from "buffer";
import { Duplex } from "readable-stream";
import { VMError } from "../../errors.ts";
import type { AsyncContext } from "./async-context.ts";
import type { createNativeChildren, PipedChildHandle } from "./node-children.ts";
import type { ProcessScheduler } from "./process-scheduler.ts";
import { streamError } from "./node-streams.ts";
import { unavailableNodeApi } from "./node-capability.ts";
import { compressionBytes, compressionNumber } from "./zlib-codec.ts";
import { brotliGuestArguments } from "./node-brotli-guest.ts";
import { brotliControl, brotliData, readBrotliFrame, type BrotliFrame, type BrotliOperation } from "./node-brotli-wire.ts";

type Completion = (error?: Error | null) => void;
type NodeBrotliStream = Duplex & {
  readonly bytesWritten: number;
  flush(kind?: unknown, callback?: Completion): void;
  reset(): never;
  params(): never;
  close(callback?: () => void): void;
};
type Pending = {
  readonly kind: "written" | "flushed" | "finished";
  readonly count: number;
  readonly completion: PromiseWithResolvers<undefined>;
  outputBytes: number | undefined;
};

/** Linux owns the codec. The existing Duplex owns queues, while cumulative output
 * acknowledgements order callbacks across independently backpressured pipes. */
export function createNodeBrotli(children: Pick<ReturnType<typeof createNativeChildren>, "spawnService">,
  context: AsyncContext, retain: () => () => void, scheduler: ProcessScheduler): {
    BrotliCompress: new (options?: unknown) => NodeBrotliStream;
    BrotliDecompress: new (options?: unknown) => NodeBrotliStream;
    createBrotliCompress(options?: unknown): NodeBrotliStream;
    createBrotliDecompress(options?: unknown): NodeBrotliStream;
  } {
  class BrotliStream extends Duplex {
    readonly #run = context.capture();
    readonly #ready = Promise.withResolvers<undefined>();
    readonly #retired = Promise.withResolvers<undefined>();
    readonly #remoteEnd = Promise.withResolvers<undefined>();
    readonly #controlsEnded = Promise.withResolvers<undefined>();
    readonly #dataEnded = Promise.withResolvers<undefined>();
    readonly #flushes = new WeakMap<object, BrotliOperation>();
    readonly #options: Readonly<Record<string, unknown>>;
    readonly #mode: "compress" | "decompress";
    #child: PipedChildHandle | undefined;
    #pending: Pending | undefined;
    #demand: PromiseWithResolvers<undefined> | undefined;
    #started = false;
    #end = false;
    #finished = false;
    #closed = false;
    #cancelled = false;
    #dataEof = false;
    #deliveredBytes = 0;
    #acknowledgedBytes = 0;
    #writtenBytes = 0;
    #applicationFailed = false;
    constructor(mode: "compress" | "decompress", options?: unknown) {
      const captured = brotliOptions(mode, options);
      super({ highWaterMark: compressionNumber(captured["highWaterMark"], "highWaterMark", 16384, 0, 0x7fff_ffff), autoDestroy: true,
        read: () => { this.#demand?.resolve(undefined); },
        write: (value, _encoding, done) => { void this.#operation(() => this.#write(value), done); },
        final: done => { void this.#operation(() => this.#finish(), done); },
        destroy: (error, done) => { void this.#destroy(error, done); },
      });
      this.#mode = mode; this.#options = captured;
      for (const pending of [this.#ready, this.#retired, this.#remoteEnd, this.#controlsEnded, this.#dataEnded]) void pending.promise.catch(() => {});
    }
    get bytesWritten(): number { return this.#writtenBytes; }
    #deliver<T>(callback: () => T): Promise<T> {
      return scheduler.execute(() => this.#run(() => {
        try { return callback(); } catch (error) { this.#applicationFailed = true; throw error; }
      }));
    }
    #start(): void {
      if (this.destroyed) throw closed();
      if (this.#child !== undefined) return;
      const child = children.spawnService("/usr/bin/node", brotliGuestArguments(this.#mode, this.#options)); this.#child = child;
      child.on("error", error => this.destroy(streamError(error)));
      child.stdin.on("error", error => this.destroy(streamError(error)));
      child.on("close", (code, signal) => {
        if (this.#cancelled || (code === 0 && signal === null)) this.#retired.resolve(undefined);
        else { const error = protocol(); this.#retired.reject(error); this.destroy(error); }
      });
      void this.#control(child); void this.#data(child);
    }
    async #operation(work: () => Promise<void>, done: Completion): Promise<void> {
      const release = retain(); let failure: Error | undefined;
      try { this.#start(); await this.#ready.promise; await work(); }
      catch (error) { if (this.#applicationFailed) { release(); throw error; } failure = streamError(error); }
      try { await this.#deliver(() => done(failure)); } finally { release(); }
    }
    async #send(bytes: Uint8Array): Promise<void> {
      const child = this.#child; if (child === undefined || this.destroyed) throw closed();
      await new Promise<void>((resolve, reject) => child.stdin.write(bytes, error => error ? reject(error) : resolve()));
    }
    async #request(kind: Pending["kind"], bytes: Uint8Array, count = 0): Promise<void> {
      if (this.#pending !== undefined || this.destroyed) throw closed();
      const completion = Promise.withResolvers<undefined>(); void completion.promise.catch(() => {});
      this.#pending = { kind, count, completion, outputBytes: undefined };
      await this.#send(bytes); await completion.promise;
    }
    async #write(value: unknown): Promise<void> {
      const bytes = compressionBytes(value);
      const operation = typeof value === "object" && value !== null ? this.#flushes.get(value) : undefined;
      if (operation !== undefined) { await this.#request("flushed", brotliControl({ kind: "flush", operation })); return; }
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        const part = bytes.subarray(offset, offset + 65536);
        await this.#request("written", brotliData(part), part.length); this.#writtenBytes += part.length;
      }
    }
    async #finish(): Promise<void> {
      const completion = this.#request("finished", brotliControl({ kind: "end" }));
      this.#child?.stdin.end(); await completion;
      // A successful writable finish includes service retirement, so a cached
      // file cannot be published while a codec descendant is still running.
      await this.#controlsEnded.promise; await this.#dataEnded.promise; await this.#retired.promise;
      if (this.#deliveredBytes !== this.#acknowledgedBytes) throw protocol();
    }
    #settle(): void {
      const pending = this.#pending; if (pending?.outputBytes === undefined) return;
      if (pending.outputBytes > this.#deliveredBytes) { if (this.#dataEof) throw protocol(); return; }
      this.#pending = undefined; pending.completion.resolve(undefined);
    }
    #event(frame: BrotliFrame): void {
      if (this.#closed) throw protocol();
      if (frame.kind === "error") {
        this.destroy(Object.assign(new Error(frame.message), { code: frame.code, ...(frame.errno === undefined ? {} : { errno: frame.errno }) })); return;
      }
      if (frame.kind === "ready") {
        if (this.#started) throw protocol(); this.#started = true; this.#ready.resolve(undefined); return;
      }
      if (!this.#started) throw protocol();
      switch (frame.kind) {
        case "written": case "flushed": case "finished": {
          const pending = this.#pending;
          if (pending === undefined || pending.kind !== frame.kind || pending.outputBytes !== undefined
            || (frame.kind === "written" && pending.count !== frame.count) || frame.outputBytes < this.#acknowledgedBytes
            || (frame.kind === "finished" && (!this.#end || this.#finished))) throw protocol();
          if (frame.kind === "finished") this.#finished = true;
          pending.outputBytes = frame.outputBytes; this.#acknowledgedBytes = frame.outputBytes; this.#settle(); return;
        }
        case "end":
          if (this.#end) throw protocol();
          this.#end = true; this.#remoteEnd.resolve(undefined); return;
        case "close":
          if (!this.#end || !this.#finished || frame.hadError) throw protocol(); this.#closed = true; return;
        case "data": throw protocol();
      }
    }
    async #control(child: PipedChildHandle): Promise<void> {
      try {
        for (;;) {
          const frame = await readBrotliFrame(child.stderr); if (frame === null) break;
          if (!this.#cancelled) this.#event(frame);
        }
        if (!this.#closed && !this.#cancelled) throw protocol();
        this.#controlsEnded.resolve(undefined);
      } catch (error) { this.#controlsEnded.reject(error); if (!this.#cancelled) this.destroy(streamError(error)); }
    }
    async #data(child: PipedChildHandle): Promise<void> {
      try {
        await this.#ready.promise;
        for (;;) {
          const frame = await readBrotliFrame(child.stdout); if (frame === null) break;
          if (frame.kind !== "data") throw protocol();
          if (this.destroyed) continue;
          const demand = Promise.withResolvers<undefined>(); this.#demand = demand;
          const accepted = await this.#deliver(() => this.push(frame.bytes));
          this.#deliveredBytes += frame.bytes.length;
          if (!Number.isSafeInteger(this.#deliveredBytes)) throw protocol();
          this.#settle();
          if (!accepted) await demand.promise;
          this.#demand = undefined;
        }
        this.#dataEof = true; this.#settle(); await this.#remoteEnd.promise;
        if (!this.destroyed) await this.#deliver(() => { this.push(null); });
        this.#dataEnded.resolve(undefined);
      } catch (error) { this.#dataEnded.reject(error); if (this.#applicationFailed) throw error; if (!this.#cancelled) this.destroy(streamError(error)); }
    }
    async #destroy(error: Error | null, done: Completion): Promise<void> {
      const release = retain();
      this.#cancelled = true;
      const reason = error ?? closed();
      this.#ready.reject(reason); this.#remoteEnd.reject(reason); this.#controlsEnded.reject(reason);
      this.#dataEnded.reject(reason);
      this.#pending?.completion.reject(reason); this.#pending = undefined; this.#demand?.resolve(undefined);
      try {
        if (this.#child !== undefined) {
          if (error !== null || !this.#finished || !this.#end) this.#child.kill("SIGKILL");
          await this.#retired.promise.catch(() => {});
        }
        await this.#deliver(() => done(error));
      } finally { release(); }
    }
    flush(kind?: unknown, callback?: Completion): void {
      if (typeof kind === "function") {
        const fn = kind; callback = error => { Reflect.apply(fn, undefined, error === undefined ? [] : [error]); }; kind = undefined;
      }
      const selected = operation(kind, 1);
      if (this.writableFinished) { scheduler.enqueue(() => this.#run(() => callback?.())); return; }
      const marker = Buffer.alloc(0); this.#flushes.set(marker, selected); this.write(marker, callback);
    }
    reset(): never { return unavailableNodeApi("zlib.Brotli.reset"); }
    params(): never { return unavailableNodeApi("zlib.Brotli.params"); }
    close(callback?: () => void): void {
      if (callback !== undefined) {
        if (this.closed) scheduler.enqueue(() => this.#run(callback));
        else this.once("close", callback);
      }
      this.destroy();
    }
  }
  class BrotliCompress extends BrotliStream { constructor(options?: unknown) { super("compress", options); } }
  class BrotliDecompress extends BrotliStream { constructor(options?: unknown) { super("decompress", options); } }
  return { BrotliCompress, BrotliDecompress,
    createBrotliCompress: (options?: unknown) => new BrotliCompress(options), createBrotliDecompress: (options?: unknown) => new BrotliDecompress(options) };
}

function brotliOptions(mode: "compress" | "decompress", value: unknown): Readonly<Record<string, unknown>> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid Brotli options");
  const options: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const input: unknown = Reflect.get(value, key);
    if (input === undefined) continue;
    if (key === "chunkSize") options[key] = compressionNumber(input, key, 16384, 64, 0x7fff_ffff);
    else if (key === "highWaterMark") options[key] = compressionNumber(input, key, 16384, 0, 0x7fff_ffff);
    else if (key === "flush" || key === "finishFlush") options[key] = operation(input, key === "flush" ? 0 : 2);
    else if (key === "params") {
      if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid Brotli params");
      const params: Record<string, number | boolean> = {};
      for (const name of Object.keys(input)) {
        const parameter: unknown = Reflect.get(input, name);
        if (!/^[0-8]$/u.test(name)) throw Object.assign(new RangeError(`${name} is not a valid Brotli parameter`), { code: "ERR_BROTLI_INVALID_PARAM" });
        if (typeof parameter !== "boolean" && (typeof parameter !== "number" || !Number.isFinite(parameter))) throw new TypeError("Invalid Brotli parameter");
        if (mode === "decompress" && Number(name) > 1) throw Object.assign(new Error("Initialization failed"), { code: "ERR_ZLIB_INITIALIZATION_FAILED" });
        params[name] = parameter;
      }
      options[key] = params;
    } else unavailableNodeApi(`zlib.Brotli option ${key}`);
  }
  return options;
}
function operation(value: unknown, fallback: BrotliOperation): BrotliOperation {
  if (value === undefined) return fallback;
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  throw Object.assign(new RangeError("Invalid Brotli operation"), { code: "ERR_OUT_OF_RANGE" });
}
function closed(): Error { return Object.assign(new Error("Brotli stream closed"), { code: "ERR_STREAM_DESTROYED" }); }
function protocol(): VMError { return new VMError("PROTOCOL_ERROR", "Invalid native Brotli lifecycle"); }
