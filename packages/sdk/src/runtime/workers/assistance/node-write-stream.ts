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

/** Writable owns ordering and backpressure. Rust owns the descriptor and its offset. */
export function createNodeWriteStream(open: Open, context: AsyncContext) {
  return function createWriteStream(path: unknown, input?: unknown) {
    const options = typeof input === "string" ? { encoding: input } : input === undefined ? {} : input;
    if (typeof options !== "object" || options === null) throw new TypeError("Invalid write stream options");
    const at = (key: string): unknown => Reflect.get(options, key);
    if (at("fd") !== undefined || at("fs") !== undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Custom write stream descriptors and filesystem adapters are not qualified");
    const flags = at("flags") ?? "w", mode = at("mode") ?? 0o666, encoding = at("encoding") ?? "utf8";
    if (typeof encoding !== "string") throw new TypeError("Invalid write stream encoding");
    let position: number | null = at("start") === undefined ? null : integer(at("start"), "write stream start", 0, Number.MAX_SAFE_INTEGER);
    const highWaterMark = at("highWaterMark") === undefined ? 65536 : integer(at("highWaterMark"), "write stream highWaterMark", 1, 16 * 1024 * 1024);
    const autoClose = at("autoClose") !== false, flush = at("flush") === true;
    let handle: Handle | undefined, opening: Promise<Handle> | undefined, closing: Promise<void> | undefined, bytesWritten = 0;
    function close(): Promise<void> {
      closing ??= (async () => {
        if (opening !== undefined) { try { handle = await opening; } catch { return; } }
        if (handle !== undefined) { const file = handle; handle = undefined; await file.close(); }
      })(); return closing;
    }
    class FileWriteStream extends Writable {
      get path(): unknown { return path; }
      get fd(): number | null { return handle?.fd ?? null; }
      get pending(): boolean { return handle === undefined && !this.destroyed; }
      get bytesWritten(): number { return bytesWritten; }
      close(callback?: () => void): void {
        if (callback !== undefined) this.once("close", callback);
        if (this.writableFinished) this.destroy(); else this.end(() => { this.destroy(); });
      }
    }
    const stream = new FileWriteStream({ highWaterMark, defaultEncoding: encoding, autoDestroy: autoClose, emitClose: at("emitClose") !== false,
      construct(done) {
        opening = open(path, flags, mode);
        void opening.then(file => { handle = file; stream.emit("open", file.fd); stream.emit("ready"); done(); }, (error: unknown) => done(streamError(error)));
      },
      write(bytes, _encoding, done) {
        void (async () => {
          if (!(bytes instanceof Uint8Array) || handle === undefined) throw new TypeError("Write stream has no file or byte buffer");
          for (let offset = 0; offset < bytes.byteLength;) {
            const length = Math.min(bytes.byteLength - offset, 65536);
            const result = await handle.write(bytes, offset, length, position);
            const count = integer(result.bytesWritten, "file stream write count", 1, length);
            offset += count; bytesWritten += count; if (position !== null) position += count;
          }
        })().then(() => done(), (error: unknown) => done(streamError(error)));
      },
      final(done) { void (async () => { if (flush && handle !== undefined) await handle.sync(); })().then(() => done(), (error: unknown) => done(streamError(error))); },
      destroy(error, done) { void close().then(() => done(error), (failure: unknown) => done(streamError(failure))); },
    });
    bindAsyncEvents(stream, context); bindAsyncWritable(stream, context);
    return stream;
  };
}
