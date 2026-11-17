import { integer } from "../../decode.js";
import { VMError } from "../../errors.js";
import type { AsyncContext } from "./async-context.js";
import { bindAsyncEvents, bindAsyncWritable, streamError, Writable } from "./node-streams.js";

interface Handle {
  readonly fd: number;
  write(bytes: Uint8Array, offset: number, length: number, position: number | null): Promise<{ readonly bytesWritten: number }>;
  close(): Promise<void>;
  sync(): Promise<void>;
}
type Open = (path: unknown, flags: unknown, mode: unknown) => Promise<Handle>;

interface NodeWriteStream extends Writable {
  readonly path: unknown;
  readonly fd: number | null;
  readonly pending: boolean;
  readonly bytesWritten: number;
  close(callback?: () => void): void;
}
interface State { handle: Handle | undefined; bytesWritten: number }
type WriteStreamConstructor = new (path: unknown, options?: unknown) => NodeWriteStream;
// Node's stream constructors are plain functions; the type names what `new` yields.
function constructs(value: unknown): value is WriteStreamConstructor { return typeof value === "function"; }

/** Writable owns ordering and backpressure. Rust owns the descriptor and its offset. `WriteStream` is a plain
 * function, as in Node, because graceful-fs (inside webpack, tar and fs-extra) subclasses it by calling it on its own
 * instance; a class cannot be called that way. */
export function createNodeWriteStreams(open: Open, context: AsyncContext): { readonly WriteStream: WriteStreamConstructor; readonly createWriteStream: (path: unknown, options?: unknown) => NodeWriteStream } {
  const states = new WeakMap<object, State>();
  function initialise(stream: Writable, path: unknown, input: unknown): void {
    const options = typeof input === "string" ? { encoding: input } : input === undefined ? {} : input;
    if (typeof options !== "object" || options === null) throw new TypeError("Invalid write stream options");
    const at = (key: string): unknown => Reflect.get(options, key);
    if (at("fd") !== undefined || at("fs") !== undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Custom write stream descriptors and filesystem adapters are not qualified");
    const flags = at("flags") ?? "w", mode = at("mode") ?? 0o666, encoding = at("encoding") ?? "utf8";
    if (typeof encoding !== "string") throw new TypeError("Invalid write stream encoding");
    let position: number | null = at("start") === undefined ? null : integer(at("start"), "write stream start", 0, Number.MAX_SAFE_INTEGER);
    const highWaterMark = at("highWaterMark") === undefined ? 65536 : integer(at("highWaterMark"), "write stream highWaterMark", 1, 16 * 1024 * 1024);
    const autoClose = at("autoClose") !== false, flush = at("flush") === true;
    const state: State = { handle: undefined, bytesWritten: 0 };
    let opening: Promise<Handle> | undefined, closing: Promise<void> | undefined;
    function close(): Promise<void> {
      closing ??= (async () => {
        if (opening !== undefined) { try { state.handle = await opening; } catch { return; } }
        if (state.handle !== undefined) { const file = state.handle; state.handle = undefined; await file.close(); }
      })(); return closing;
    }
    const settings: ConstructorParameters<typeof Writable>[0] = { highWaterMark, defaultEncoding: encoding, autoDestroy: autoClose, emitClose: at("emitClose") !== false,
      construct(done) {
        opening = open(path, flags, mode);
        void opening.then(file => { state.handle = file; stream.emit("open", file.fd); stream.emit("ready"); done(); }, (error: unknown) => done(streamError(error)));
      },
      write(bytes, _encoding, done) {
        void (async () => {
          const handle = state.handle;
          if (!(bytes instanceof Uint8Array) || handle === undefined) throw new TypeError("Write stream has no file or byte buffer");
          for (let offset = 0; offset < bytes.byteLength;) {
            const length = Math.min(bytes.byteLength - offset, 65536);
            const result = await handle.write(bytes, offset, length, position);
            const count = integer(result.bytesWritten, "file stream write count", 1, length);
            offset += count; state.bytesWritten += count; if (position !== null) position += count;
          }
        })().then(() => done(), (error: unknown) => done(streamError(error)));
      },
      final(done) { void (async () => { if (flush && state.handle !== undefined) await state.handle.sync(); })().then(() => done(), (error: unknown) => done(streamError(error))); },
      destroy(error, done) { void close().then(() => done(error), (failure: unknown) => done(streamError(failure))); },
    };
    Reflect.apply(Writable, stream, [settings]);
    Object.defineProperty(stream, "path", { configurable: true, enumerable: true, writable: true, value: path });
    states.set(stream, state);
    bindAsyncEvents(stream, context); bindAsyncWritable(stream, context);
  }
  function WriteStream(this: unknown, path: unknown, input?: unknown): unknown {
    if (!(this instanceof Writable)) return Reflect.construct(WriteStream, [path, input]);
    initialise(this, path, input);
    return undefined;
  }
  const prototype: unknown = Reflect.get(WriteStream, "prototype"), Constructor: unknown = WriteStream;
  if (typeof prototype !== "object" || prototype === null || !constructs(Constructor)) throw new TypeError("WriteStream has no prototype");
  Object.setPrototypeOf(prototype, Writable.prototype); Object.setPrototypeOf(WriteStream, Writable);
  Object.defineProperties(prototype, {
    fd: { configurable: true, get(this: object): number | null { return states.get(this)?.handle?.fd ?? null; } },
    pending: { configurable: true, get(this: object): boolean { return states.get(this)?.handle === undefined && !(this instanceof Writable && this.destroyed); } },
    bytesWritten: { configurable: true, get(this: object): number { return states.get(this)?.bytesWritten ?? 0; } },
    close: { configurable: true, writable: true, value(this: Writable, callback?: () => void): void {
      if (callback !== undefined) this.once("close", callback);
      if (this.writableFinished) this.destroy(); else this.end(() => { this.destroy(); });
    } },
  });
  return { WriteStream: Constructor, createWriteStream: (path: unknown, options?: unknown) => new Constructor(path, options) };
}
