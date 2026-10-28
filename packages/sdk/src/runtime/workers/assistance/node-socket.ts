import type { ProcessScheduler } from "./process-scheduler.js";
import { Buffer } from "buffer";
import { Duplex } from "readable-stream";
import { integer, record, exactKeys } from "../../decode.js";
import { VMError } from "../../errors.js";
import { ASSISTANCE_LIMITS } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import type { ProcessIO } from "./process-io.js";
import type { AsyncContext } from "./async-context.js";
import { bindAsyncEvents, bindAsyncWritable, isEventListener, streamError } from "./node-streams.js";
import { nodeResult } from "./node-file-operations.js";
import { createSocketDefaults } from "./node-socket-defaults.js";
import { connectSocket, socketConnectArguments, type SocketNetworking } from "./node-socket-connect.js";

type SocketInfo = Extract<AssistanceResult, { kind: "socket" }>;
const scheduleTimeout = globalThis.setTimeout.bind(globalThis);
const cancelTimeout = globalThis.clearTimeout.bind(globalThis);

type Completion = (error?: Error | null) => void;

export type NodeSocket = Duplex & {
  readonly connecting: boolean; readonly pending: boolean;
  readonly bytesRead: number; readonly bytesWritten: number;
  readonly localAddress: string | undefined; readonly localPort: number | undefined; readonly localFamily: string | undefined;
  readonly remoteAddress: string | undefined; readonly remotePort: number | undefined; readonly remoteFamily: string | undefined;
  readonly autoSelectFamilyAttemptedAddresses?: string[];
  address(): object;
  connect(...args: unknown[]): NodeSocket;
  ref(): NodeSocket;
  unref(): NodeSocket;
  setNoDelay(enabled?: unknown): NodeSocket;
  setKeepAlive(enabled?: unknown, initialDelay?: number): NodeSocket;
  readonly timeout: number | undefined;
  setTimeout(duration: unknown, callback?: unknown): NodeSocket;
};
export type NodeSockets = Omit<ReturnType<typeof createSocketDefaults>, "timeout"> & {
  readonly Socket: new (options?: unknown) => NodeSocket;
  readonly connect: (...args: unknown[]) => NodeSocket;
  readonly createConnection: (...args: unknown[]) => NodeSocket;
};

/** Linux owns connections and descriptors; the pinned Duplex owns application
 * buffering, half-close sequencing and backpressure. No browser socket API. */
export function createNodeSockets(io: Pick<ProcessIO, "call" | "callSync" | "retain">, context: AsyncContext, scheduler?: ProcessScheduler, networking: SocketNetworking = {}): NodeSockets {
  const defaults = createSocketDefaults(networking.defaults);
  const deliver = <Result>(callback: () => Result): Promise<Result> => scheduler === undefined
    ? Promise.resolve(callback()) : scheduler.execute(callback);
  class Socket extends Duplex {
    #info: SocketInfo | undefined;
    readonly #ready = Promise.withResolvers<SocketInfo>();
    #connecting = false;
    #reading = false;
    #eof = false;
    #referenced = true;
    #release: (() => void) | undefined;
    #noDelay: boolean | undefined;
    #keepAlive: { enabled: boolean; delaySeconds: number } | undefined;
    #readBytes = 0;
    #writtenBytes = 0;
    readonly #connection = new AbortController();
    declare autoSelectFamilyAttemptedAddresses?: string[];
    timeout: number | undefined;
    #timer: ReturnType<typeof scheduleTimeout> | undefined;

    constructor(value: unknown = {}) {
      const options = record(value, "net.Socket options");
      exactKeys(options, [], ["allowHalfOpen", "highWaterMark", "fd"]);
      if (options["allowHalfOpen"] !== undefined && typeof options["allowHalfOpen"] !== "boolean") throw new TypeError("Invalid net.Socket allowHalfOpen");
      const highWaterMark = options["highWaterMark"] === undefined ? ASSISTANCE_LIMITS.chunk
        : integer(options["highWaterMark"], "socket highWaterMark", 1, ASSISTANCE_LIMITS.chunk);
      super({ highWaterMark, allowHalfOpen: options["allowHalfOpen"] === true, autoDestroy: true,
        read: () => this.#read(),
        write: (chunk, _encoding, callback) => { void this.#write(chunk, callback); },
        final: callback => { void this.#finish(callback); },
        destroy: (error, callback) => { void this.#close(error, callback); },
      });
      bindAsyncEvents(this, context);
      bindAsyncWritable(this, context);
      void this.#ready.promise.catch(() => undefined);
      if (options["fd"] !== undefined) {
        const result = nodeResult(io.callSync({ kind: "socket-address", fd: integer(options["fd"], "socket fd", 1, 0xffff_ffff) }));
        if (result.kind !== "socket" || result.peer === null) throw new TypeError("net.Socket fd is not connected");
        this.#info = result; this.#ready.resolve(result); this.#reference();
      }
    }

    get connecting(): boolean { return this.#connecting; }
    get pending(): boolean { return this.#info === undefined; }
    get bytesRead(): number { return this.#readBytes; }
    get bytesWritten(): number { return this.#writtenBytes + this.writableLength; }
    get localAddress(): string | undefined { return this.#info?.local.address; }
    get localPort(): number | undefined { return this.#info?.local.port; }
    get localFamily(): string | undefined { return this.localAddress === undefined ? undefined : family(this.localAddress); }
    get remoteAddress(): string | undefined { return this.#info?.peer?.address; }
    get remotePort(): number | undefined { return this.#info?.peer?.port; }
    get remoteFamily(): string | undefined { return this.remoteAddress === undefined ? undefined : family(this.remoteAddress); }
    address(): object {
      return this.#info === undefined ? {} : { ...this.#info.local, family: family(this.#info.local.address) };
    }

    connect(...args: unknown[]): this {
      if (this.#connecting || this.#info !== undefined || this.destroyed) throw socketError("ERR_SOCKET_CLOSED", "Socket is already connected or closed");
      const { options, callback } = socketConnectArguments(args, defaults, networking.lookup);
      if (callback !== undefined) this.once("connect", () => { Reflect.apply(callback, this, []); });
      this.#connecting = true; this.#reference();
      const run = context.capture();
      void (async () => {
        try {
          const result = await connectSocket(io, options, { signal: this.#connection.signal,
            emit: (name, ...args) => run(() => { this.emit(name, ...args); }),
            attempted: addresses => { this.autoSelectFamilyAttemptedAddresses = addresses; },
          });
          this.#info = result; this.#connecting = false; this.#ready.resolve(result);
          if (!this.#live()) return;
          if (this.#noDelay !== undefined) socketOptionResult(await io.call({ kind: "socket-nodelay", fd: result.fd, enabled: this.#noDelay }, false));
          if (!this.#live()) return;
          this.#applyKeepAlive();
          this.#refreshTimeout();
          await deliver(() => run(() => { this.emit("connect"); this.emit("ready"); }));
          this.#read();
        } catch (error) {
          this.#connecting = false; this.#ready.reject(error);
          await deliver(() => run(() => { this.destroy(streamError(error)); }));
        }
      })();
      return this;
    }

    ref(): this { this.#referenced = true; this.#reference(); return this; }
    unref(): this { this.#referenced = false; this.#release?.(); this.#release = undefined; return this; }
    #reference(): void {
      if (this.#referenced && !this.destroyed && (this.#connecting || this.#info !== undefined)) this.#release ??= io.retain();
    }

    setNoDelay(enabled: unknown = true): this {
      this.#noDelay = Boolean(enabled);
      if (this.#info !== undefined && !this.destroyed) {
        void io.call({ kind: "socket-nodelay", fd: this.#info.fd, enabled: this.#noDelay }, false)
          .then(socketOptionResult).catch((error: unknown) => deliver(() => { this.destroy(streamError(error)); }));
      }
      return this;
    }

    setKeepAlive(enabled: unknown = false, initialDelay = 0): this {
      const next = { enabled: Boolean(enabled), delaySeconds: (~~(initialDelay / 1000)) >>> 0 };
      const previous = this.#keepAlive;
      this.#keepAlive = next;
      if ((previous?.enabled ?? false) !== next.enabled || (next.enabled && previous?.delaySeconds !== next.delaySeconds)) this.#applyKeepAlive();
      return this;
    }
    #applyKeepAlive(): void {
      if (this.#info === undefined || this.destroyed || this.#keepAlive === undefined) return;
      const result = io.callSync({ kind: "socket-keepalive", fd: this.#info.fd, ...this.#keepAlive });
      socketOptionResult(result);
    }

    setTimeout(duration: unknown, callback?: unknown): this {
      if (this.destroyed) return this;
      if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) throw socketError("ERR_OUT_OF_RANGE", "Socket timeout must be a nonnegative finite number");
      if (callback !== undefined && !isEventListener(callback)) throw new TypeError("Socket timeout requires a callback");
      this.timeout = duration;
      if (callback !== undefined) {
        if (duration === 0) this.removeListener("timeout", callback);
        else this.once("timeout", callback);
      }
      this.#refreshTimeout(); return this;
    }
    #refreshTimeout(): void {
      if (this.#timer !== undefined) cancelTimeout(this.#timer);
      this.#timer = undefined;
      if (this.destroyed || this.timeout === undefined || this.timeout === 0) return;
      // Socket ownership already determines process liveness. This native timer
      // must not introduce another referenced process-timer resource.
      this.#timer = scheduleTimeout(() => {
        this.#timer = undefined;
        const emit = () => { if (!this.destroyed) this.emit("timeout"); };
        if (scheduler === undefined) emit(); else scheduler.enqueue(emit);
      }, Math.min(this.timeout, 0x7fff_ffff));
    }

    #live(): boolean { return !this.destroyed && this.#info !== undefined; }

    #read(): void {
      if (this.#reading || this.destroyed || this.#eof) return;
      this.#reading = true;
      const run = context.capture();
      void (async () => {
        let more = false;
        try {
          const socket = await this.#ready.promise;
          if (!this.#live()) return;
          const result = nodeResult(await io.call({ kind: "socket-read", fd: socket.fd, length: ASSISTANCE_LIMITS.chunk }, false));
          if (result.kind !== "data") throw new VMError("PROTOCOL_ERROR", "Invalid Linux socket read");
          if (!this.#live()) return;
          if (result.bytes.length === 0) { this.#eof = true; await deliver(() => run(() => { this.push(null); this.read(0); })); return; }
          this.#readBytes += result.bytes.length; this.#refreshTimeout();
          more = await deliver(() => run(() => this.push(Buffer.from(result.bytes))));
        } catch (error) { if (!this.destroyed) await deliver(() => run(() => { this.destroy(streamError(error)); })); }
        finally { this.#reading = false; if (more) this.#read(); }
      })();
    }

    async #write(chunk: unknown, done: Completion): Promise<void> {
      const run = context.capture();
      try {
        if (!(chunk instanceof Uint8Array)) throw new TypeError("net.Socket requires byte or string writes");
        if (!this.#connecting && this.#info === undefined) throw socketError("ERR_SOCKET_CLOSED", "Socket is not connected");
        const socket = await this.#ready.promise;
        for (let offset = 0; offset < chunk.byteLength;) {
          const bytes = Uint8Array.from(chunk.subarray(offset, offset + ASSISTANCE_LIMITS.chunk));
          const result = nodeResult(await io.call({ kind: "socket-write", fd: socket.fd, bytes }, false));
          if (result.kind !== "written" || result.count < 1 || result.count > bytes.length) throw new VMError("PROTOCOL_ERROR", "Invalid Linux socket write");
          offset += result.count; this.#refreshTimeout();
        }
        this.#writtenBytes += chunk.byteLength;
        await deliver(() => run(() => done()));
      } catch (error) { await deliver(() => run(() => done(streamError(error)))); }
    }

    async #finish(done: Completion): Promise<void> {
      const run = context.capture();
      try {
        if (!this.#connecting && this.#info === undefined) throw socketError("ERR_SOCKET_CLOSED", "Socket is not connected");
        const socket = await this.#ready.promise;
        nodeResult(await io.call({ kind: "socket-shutdown", fd: socket.fd, direction: "write" }));
        await deliver(() => run(() => done()));
      } catch (error) { await deliver(() => run(() => done(streamError(error)))); }
    }

    async #close(error: Error | null, done: Completion): Promise<void> {
      this.#refreshTimeout();
      this.#connection.abort(socketError("ERR_SOCKET_CLOSED", "Socket is closed"));
      const run = context.capture();
      try {
        if (this.#connecting) { try { await this.#ready.promise; } catch { /* Connection failure has no descriptor. */ } }
        if (this.#info !== undefined) nodeResult(await io.call({ kind: "socket-close", fd: this.#info.fd }));
      } catch (failure) { error ??= streamError(failure); }
      finally {
        this.#info = undefined;
        this.#ready.reject(socketError("ERR_SOCKET_CLOSED", "Socket is closed"));
        this.#release?.(); this.#release = undefined;
        await deliver(() => run(() => done(error)));
      }
    }
  }
  const createConnection = (...args: unknown[]) => new Socket().connect(...args);
  return { Socket, createConnection, connect: createConnection,
    getDefaultAutoSelectFamily: defaults.getDefaultAutoSelectFamily, setDefaultAutoSelectFamily: defaults.setDefaultAutoSelectFamily,
    getDefaultAutoSelectFamilyAttemptTimeout: defaults.getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout: defaults.setDefaultAutoSelectFamilyAttemptTimeout };
}

function socketOptionResult(result: AssistanceResult): void {
  // Node 24 ignores setsockopt errno. Transport and protocol failures still fail.
  if (result.kind !== "unit" && result.kind !== "error") throw new VMError("PROTOCOL_ERROR", "Invalid socket option reply");
}

function family(address: string): string { return address.includes(":") ? "IPv6" : "IPv4"; }
function socketError(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
