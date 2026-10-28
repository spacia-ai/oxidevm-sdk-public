import { Buffer } from "buffer";
import { Duplex } from "readable-stream";
import type { Z_FlushMode } from "pako";
import type { AsyncContext } from "./async-context.ts";
import type { ProcessScheduler } from "./process-scheduler.ts";
import { nodeZlib } from "./node-zlib.ts";
import { unavailableNodeApi } from "./node-capability.ts";
import { ZlibCodec, compressionBytes, compressionFlush, compressionNumber, compressionLimit, type CompressionMode } from "./zlib-codec.ts";

type Completion = (error?: Error | null) => void;
type Scheduler = Pick<ProcessScheduler, "enqueue">;

/** The pinned Duplex owns queues. Only one codec output chunk is produced per
 * scheduled callback; a full readable queue suspends the codec until demand. */
class CompressionStream extends Duplex {
  readonly #codec: ZlibCodec;
  readonly #scheduler: Scheduler;
  readonly #run: ReturnType<AsyncContext["capture"]>;
  readonly #flushes = new WeakMap<object, Z_FlushMode>();
  #pending: { iterator: Generator<Uint8Array, void>; done: Completion } | undefined;
  #queued = false;
  #blocked = false;

  constructor(mode: CompressionMode, options: unknown, context: AsyncContext, scheduler: Scheduler) {
    const opts = typeof options === "object" && options !== null ? options : {};
    const highWaterMark = compressionNumber(Reflect.get(opts, "highWaterMark"), "highWaterMark", 16384, 0, 0x7fff_ffff);
    const codec = new ZlibCodec(mode, options, `zlib.create${mode.charAt(0).toUpperCase()}${mode.slice(1)}`);
    super({ highWaterMark, autoDestroy: true,
      read: () => { this.#blocked = false; this.#wake(); },
      write: (value, _encoding, done) => {
        const flush = typeof value === "object" && value !== null ? this.#flushes.get(value) : undefined;
        this.#begin(compressionBytes(value), flush ?? codec.flush, done);
      },
      final: done => { this.#begin(new Uint8Array(), codec.finishFlush, error => { if (error === undefined || error === null) this.push(null); done(error); }); },
      destroy: (error, done) => {
        const pending = this.#pending; this.#pending = undefined;
        pending?.iterator.return(); codec.close();
        this.#run(() => {
          pending?.done(error ?? Object.assign(new Error("Compression stream destroyed"), { code: "ERR_STREAM_DESTROYED" }));
          done(error);
        });
      },
    });
    this.#codec = codec; this.#scheduler = scheduler; this.#run = context.capture();
  }

  get bytesWritten(): number { return this.#codec.bytesWritten; }
  get maxOutputLength(): number { return this.#codec.maxOutputLength; }

  #begin(bytes: Uint8Array, flush: Z_FlushMode, done: Completion): void {
    this.#pending = { iterator: this.#codec.write(bytes, flush), done }; this.#wake();
  }

  #wake(): void {
    if (this.#queued || this.#blocked || this.#pending === undefined || this.destroyed) return;
    this.#queued = true;
    this.#scheduler.enqueue(() => this.#run(() => { this.#queued = false; this.#step(); }));
  }

  #step(): void {
    const pending = this.#pending;
    if (pending === undefined || this.destroyed) return;
    let result: IteratorResult<Uint8Array, void>;
    try { result = pending.iterator.next(); }
    catch (error) { this.#pending = undefined; pending.done(error instanceof Error ? error : new Error(String(error))); return; }
    if (result.done === true) { this.#pending = undefined; pending.done(); return; }
    this.#blocked = !this.push(result.value);
    this.#wake();
  }

  flush(kind?: unknown, callback?: Completion): void {
    if (typeof kind === "function") {
      const fn = kind; callback = error => { Reflect.apply(fn, undefined, error === undefined ? [] : [error]); }; kind = undefined;
    }
    const selected = compressionFlush(kind, 3);
    if (this.writableFinished) { this.#scheduler.enqueue(() => this.#run(() => callback?.())); return; }
    const marker = Buffer.alloc(0); this.#flushes.set(marker, selected);
    this.write(marker, callback);
  }

  reset(): void { this.#codec.reset(); }
  params(): never { return unavailableNodeApi("zlib.params"); }
  close(callback?: () => void): void {
    if (callback !== undefined) {
      if (this.destroyed) this.#scheduler.enqueue(() => this.#run(callback));
      else this.once("close", callback);
    }
    this.destroy();
  }
}

export function createNodeZlib(context: AsyncContext, scheduler: Scheduler) {
  function constructor(mode: CompressionMode): new (options?: unknown) => CompressionStream {
    return class extends CompressionStream { constructor(options?: unknown) { super(mode, options, context, scheduler); } };
  }
  function complete(mode: CompressionMode, input: unknown, options?: unknown, callback?: unknown): void {
    if (typeof options === "function") { callback = options; options = undefined; }
    if (typeof callback !== "function") throw Object.assign(new TypeError("Compression callback must be a function"), { code: "ERR_INVALID_ARG_TYPE" });
    const bytes = compressionBytes(input); const stream = new CompressionStream(mode, options, context, scheduler);
    const done = callback; const run = context.capture(); const output: Uint8Array[] = []; let length = 0; let delivered = false;
    function finish(error: Error | null): void {
      if (delivered) return;
      delivered = true;
      run(() => { Reflect.apply(done, undefined, error === null ? [null, Buffer.concat(output, length)] : [error]); });
    }
    stream.on("data", (value: unknown) => {
      if (!(value instanceof Uint8Array)) throw new TypeError("Invalid compression output");
      length += value.length;
      if (length > stream.maxOutputLength) stream.destroy(compressionLimit(stream.maxOutputLength));
      else output.push(value);
    });
    stream.on("error", (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    stream.on("end", () => finish(null)); stream.end(bytes);
  }
  const Deflate = constructor("deflate"), Inflate = constructor("inflate"), Gzip = constructor("gzip"), Gunzip = constructor("gunzip"),
    DeflateRaw = constructor("deflateRaw"), InflateRaw = constructor("inflateRaw"), Unzip = constructor("unzip");
  return {
    ...nodeZlib, Deflate, Inflate, Gzip, Gunzip, DeflateRaw, InflateRaw, Unzip,
    createDeflate: (options?: unknown) => new Deflate(options), createInflate: (options?: unknown) => new Inflate(options),
    createGzip: (options?: unknown) => new Gzip(options), createGunzip: (options?: unknown) => new Gunzip(options),
    createDeflateRaw: (options?: unknown) => new DeflateRaw(options), createInflateRaw: (options?: unknown) => new InflateRaw(options), createUnzip: (options?: unknown) => new Unzip(options),
    deflate: (input: unknown, options?: unknown, callback?: unknown) => complete("deflate", input, options, callback),
    inflate: (input: unknown, options?: unknown, callback?: unknown) => complete("inflate", input, options, callback),
    gzip: (input: unknown, options?: unknown, callback?: unknown) => complete("gzip", input, options, callback),
    gunzip: (input: unknown, options?: unknown, callback?: unknown) => complete("gunzip", input, options, callback),
    deflateRaw: (input: unknown, options?: unknown, callback?: unknown) => complete("deflateRaw", input, options, callback),
    inflateRaw: (input: unknown, options?: unknown, callback?: unknown) => complete("inflateRaw", input, options, callback),
    unzip: (input: unknown, options?: unknown, callback?: unknown) => complete("unzip", input, options, callback),
  };
}
