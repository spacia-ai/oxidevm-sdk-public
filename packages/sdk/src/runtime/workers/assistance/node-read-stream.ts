import { Buffer } from "buffer";
import { integer } from "../../decode.js";
import { VMError } from "../../errors.js";
import type { AsyncContext } from "./async-context.js";
import { bindAsyncEvents, Readable, streamError } from "./node-streams.js";

interface Handle {
  readonly fd: number;
  read(bytes: Uint8Array, offset: number, length: number, position: number | null): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}
type Open = (path: unknown, flags: unknown) => Promise<Handle>;
interface State { handle: Handle | undefined; bytesRead: number; }
interface NodeReadStream extends Readable {
  readonly path: unknown;
  readonly fd: number | null;
  readonly pending: boolean;
  readonly bytesRead: number;
  close(callback?: () => void): void;
}

/** The stream owns demand and buffer lifetime. Linux owns the descriptor and offset. */
export function createNodeReadStreams(open: Open, context: AsyncContext): {
  readonly ReadStream: new (path: unknown, options?: unknown) => NodeReadStream;
  createReadStream(path: unknown, options?: unknown): NodeReadStream;
} {
  class ReadStream extends Readable {
    readonly #state: State;
    readonly path: unknown;
    constructor(path: unknown, input?: unknown) {
      const options = typeof input === "string" ? { encoding: input } : input === undefined ? {} : input;
      if (typeof options !== "object" || options === null) throw new TypeError("Invalid read stream options");
      const at = (key: string): unknown => Reflect.get(options, key);
      if (at("fd") !== undefined || at("fs") !== undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Custom read stream descriptors and filesystem adapters are not qualified");
      const start = at("start") === undefined ? undefined : integer(at("start"), "read stream start", 0, Number.MAX_SAFE_INTEGER);
      const end = at("end") === undefined ? undefined : integer(at("end"), "read stream end", start ?? 0, Number.MAX_SAFE_INTEGER);
      const highWaterMark = at("highWaterMark") === undefined ? 65536 : integer(at("highWaterMark"), "read stream highWaterMark", 0, 16 * 1024 * 1024);
      const encoding = at("encoding");
      if (encoding !== undefined && encoding !== null && (typeof encoding !== "string" || !Buffer.isEncoding(encoding))) throw Object.assign(new TypeError("Invalid read stream encoding"), { code: "ERR_UNKNOWN_ENCODING" });
      const state: State = { handle: undefined, bytesRead: 0 };
      let opening: Promise<Handle> | undefined, reading: Promise<void> | undefined, closing: Promise<void> | undefined;
      let position = start ?? null;
      function close(): Promise<void> {
        closing ??= (async () => {
          if (opening !== undefined) { try { state.handle = await opening; } catch { return; } }
          try { await reading; } catch { /* The stream already owns the read error. */ }
          if (state.handle !== undefined) { const file = state.handle; state.handle = undefined; await file.close(); }
        })(); return closing;
      }
      super({ highWaterMark, autoDestroy: at("autoClose") !== false, emitClose: at("emitClose") !== false,
        construct: done => {
          opening = open(path, at("flags") ?? "r");
          void opening.then(file => { state.handle = file; this.emit("open", file.fd); this.emit("ready"); done(); }, (error: unknown) => done(streamError(error)));
        },
        read: size => {
          if (reading !== undefined) return;
          const remaining = end === undefined ? 65536 : end - (start ?? 0) - state.bytesRead + 1;
          if (remaining <= 0) { this.push(null); return; }
          reading = (async () => {
            if (state.handle === undefined) throw new TypeError("Read stream has no file");
            const length = Math.min(size || 65536, 65536, remaining), bytes = Buffer.allocUnsafe(length);
            const count = integer((await state.handle.read(bytes, 0, length, position)).bytesRead, "file stream read count", 0, length);
            state.bytesRead += count; if (position !== null) position += count;
            reading = undefined;
            if (!this.destroyed) this.push(count === 0 ? null : bytes.subarray(0, count));
          })();
          void reading.catch((error: unknown) => { reading = undefined; this.destroy(streamError(error)); });
        },
        destroy(error, done) { void close().then(() => done(error), (failure: unknown) => done(streamError(failure))); },
      });
      this.path = path; this.#state = state;
      bindAsyncEvents(this, context);
      if (typeof encoding === "string") this.setEncoding(encoding);
    }
    get fd(): number | null { return this.#state.handle?.fd ?? null; }
    get pending(): boolean { return this.#state.handle === undefined && !this.destroyed; }
    get bytesRead(): number { return this.#state.bytesRead; }
    close(callback?: () => void): void { if (callback !== undefined) this.once("close", callback); this.destroy(); }
  }
  return { ReadStream, createReadStream: (path: unknown, options?: unknown) => new ReadStream(path, options) };
}
