import { Duplex } from "readable-stream";
import { Buffer } from "buffer";
import { exactKeys, record } from "../../decode.js";
import { VMError } from "../../errors.js";
import { ASSISTANCE_LIMITS } from "../../protocol/assistance.js";
import type { AsyncContext } from "./async-context.js";
import type { createNativeChildren, PipedChildHandle } from "./node-children.js";
import type { NodeSocket } from "./node-socket.js";
import { bindAsyncEvents, bindAsyncWritable, isEventListener, streamError } from "./node-streams.js";
import type { ProcessScheduler } from "./process-scheduler.js";
import { tlsGuestArguments } from "./node-tls-guest.js";
import { readTlsFrame, tlsControl, tlsData, type TlsAddressInfo, type TlsControl, type TlsFrame, type TlsSecureInfo } from "./node-tls-wire.js";

type Completion = (error?: Error | null) => void;
export type TlsSocket = NodeSocket & {
  readonly encrypted: true; readonly authorized: boolean; readonly authorizationError: string | null;
  readonly alpnProtocol: string | false; readonly servername: string | false | null;
  getProtocol(): string | null; getCipher(): TlsSecureInfo["cipher"] | undefined;
};

/** Linux Node owns TLS and certificate validation. Its stdout carries bounded
 * plaintext frames, stderr carries control frames, and the pinned Duplex owns
 * application buffering. Paused reads never obstruct write acknowledgements. */
export function createNodeTls(children: Pick<ReturnType<typeof createNativeChildren>, "spawnService">, context: AsyncContext, retain: () => () => void, scheduler?: ProcessScheduler): {
  connect: (...args: unknown[]) => TlsSocket; TLSSocket: new (...args: unknown[]) => TlsSocket;
} {
  class TLSSocket extends Duplex {
    readonly encrypted = true;
    #applicationFailed = false;
    #deliver<T>(callback: () => T): Promise<T> {
      const run = () => { try { return callback(); } catch (error) { this.#applicationFailed = true; throw error; } };
      return scheduler === undefined ? Promise.resolve(undefined).then(run) : scheduler.execute(run);
    }
    readonly #ready = Promise.withResolvers<undefined>();
    readonly #retired = Promise.withResolvers<undefined>();
    readonly #remoteEnd = Promise.withResolvers<undefined>();
    #child: PipedChildHandle | undefined;
    #address: TlsAddressInfo | undefined;
    #secure: TlsSecureInfo | undefined;
    #release: (() => void) | undefined;
    #referenced = true;
    #verifyCertificate = true;
    #closing = false;
    #end = false;
    #finished = false;
    #closeFrame = false;
    #remoteError = false;
    #demand: PromiseWithResolvers<undefined> | undefined;
    #writeReply: { count: number; completion: PromiseWithResolvers<undefined> } | undefined;
    #finishReply: PromiseWithResolvers<undefined> | undefined;
    #writtenBytes = 0;
    #readBytes = 0;
    timeout: number | undefined;
    constructor(...args: unknown[]) {
      if (args.length !== 0) throw new VMError("FEATURE_NOT_AVAILABLE", "tls.TLSSocket wrapping an existing socket is unavailable", { api: "tls.TLSSocket" });
      super({ highWaterMark: ASSISTANCE_LIMITS.chunk, autoDestroy: true, allowHalfOpen: false,
        read: () => { this.#demand?.resolve(undefined); },
        write: (bytes, _encoding, done) => { void this.#write(bytes, done); },
        final: done => { void this.#finish(done); },
        destroy: (error, done) => { void this.#destroy(error, done); },
      });
      bindAsyncEvents(this, context); bindAsyncWritable(this, context);
      void this.#ready.promise.catch(() => {}); void this.#remoteEnd.promise.catch(() => {});
    }
    get connecting(): boolean { return this.#child !== undefined && this.#address === undefined && !this.destroyed; }
    get pending(): boolean { return this.#address === undefined; }
    get authorized(): boolean { return this.#secure?.authorized ?? false; }
    get authorizationError(): string | null { return this.#secure?.authorizationError ?? null; }
    get alpnProtocol(): string | false { return this.#secure?.alpnProtocol ?? false; }
    get servername(): string | false | null { return this.#secure?.servername ?? null; }
    get bytesRead(): number { return this.#readBytes; }
    get bytesWritten(): number { return this.#writtenBytes + this.writableLength; }
    get localAddress(): string | undefined { return this.#address?.localAddress; }
    get localPort(): number | undefined { return this.#address?.localPort; }
    get localFamily(): string | undefined { return this.#address?.localFamily; }
    get remoteAddress(): string | undefined { return this.#address?.remoteAddress; }
    get remotePort(): number | undefined { return this.#address?.remotePort; }
    get remoteFamily(): string | undefined { return this.#address?.remoteFamily; }
    getProtocol(): string | null { return this.#secure?.protocol ?? null; }
    getCipher(): TlsSecureInfo["cipher"] | undefined { return this.#secure === undefined ? undefined : { ...this.#secure.cipher }; }
    address(): object { return this.#address === undefined ? {} : { address: this.localAddress, port: this.localPort, family: this.localFamily }; }
    ref(): this { this.#referenced = true; if (this.#child !== undefined && !this.destroyed) this.#release ??= retain(); return this; }
    unref(): this { this.#referenced = false; this.#release?.(); this.#release = undefined; return this; }
    connect(...args: unknown[]): this {
      if (this.#child !== undefined || this.destroyed) throw failure("ERR_SOCKET_CLOSED", "TLS socket is already connected or closed");
      const { options, callback } = connectArguments(args);
      if (callback !== undefined) this.once("secureConnect", callback);
      this.#verifyCertificate = options["rejectUnauthorized"] !== false;
      const child = children.spawnService("/usr/bin/node", tlsGuestArguments(options)); this.#child = child;
      if (this.#referenced) this.#release = retain();
      child.on("error", error => this.destroy(streamError(error)));
      child.stdin.on("error", error => this.destroy(streamError(error)));
      child.on("close", (code, signal) => {
        this.#retired.resolve(undefined);
        if (!this.#closing && (code !== 0 || signal !== null || !this.#closeFrame)) this.destroy(failure("ERR_TLS_BRIDGE_EXIT", "Native TLS service exited before completion"));
      });
      void this.#control(child); void this.#data(child);
      return this;
    }
    setNoDelay(enabled: unknown = true): this { this.#command({ kind: "no-delay", enabled: Boolean(enabled) }); return this; }
    setKeepAlive(enabled: unknown = false, delay = 0): this {
      if (typeof delay !== "number") throw new TypeError("TLS keepalive delay must be a number");
      this.#command({ kind: "keep-alive", enabled: Boolean(enabled), delay: Number.isFinite(delay) ? delay : 0 }); return this;
    }
    setTimeout(duration: unknown, callback?: unknown): this {
      if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) throw failure("ERR_OUT_OF_RANGE", "TLS timeout must be a nonnegative finite number");
      if (callback !== undefined && !isEventListener(callback)) throw new TypeError("TLS timeout requires a callback");
      if (callback !== undefined) { if (duration === 0) this.removeListener("timeout", callback); else this.once("timeout", callback); }
      this.timeout = duration; this.#command({ kind: "timeout", duration }); return this;
    }
    #command(command: TlsControl): void {
      if (this.destroyed) return;
      if (this.#child === undefined) throw failure("ERR_SOCKET_CLOSED", "TLS socket is not connected");
      this.#child.stdin.write(tlsControl(command), error => { if (error) this.destroy(error); });
    }
    async #send(bytes: Uint8Array): Promise<void> {
      const child = this.#child;
      if (child === undefined || this.destroyed) throw failure("ERR_SOCKET_CLOSED", "TLS socket is closed");
      await new Promise<void>((resolve, reject) => child.stdin.write(bytes, error => error ? reject(error) : resolve()));
    }
    async #write(value: unknown, done: Completion): Promise<void> {
      try {
        if (!(value instanceof Uint8Array)) throw new TypeError("TLS requires binary or string writes");
        if (this.#child === undefined) throw failure("ERR_SOCKET_CLOSED", "TLS socket is not connected");
        await this.#ready.promise;
        for (let offset = 0; offset < value.length; offset += 65536) {
          const part = value.subarray(offset, offset + 65536); const completion = Promise.withResolvers<undefined>();
          this.#writeReply = { count: part.length, completion }; void completion.promise.catch(() => {});
          await this.#send(tlsData(part)); await completion.promise; this.#writtenBytes += part.length;
        }
        await this.#deliver(() => done());
      } catch (error) { if (this.#applicationFailed) throw error; await this.#deliver(() => done(streamError(error))); }
    }
    async #finish(done: Completion): Promise<void> {
      try {
        if (this.#child === undefined) throw failure("ERR_SOCKET_CLOSED", "TLS socket is not connected");
        await this.#ready.promise;
        if (this.#finished) { await this.#deliver(() => done()); return; }
        const completion = Promise.withResolvers<undefined>(); this.#finishReply = completion; void completion.promise.catch(() => {});
        if (!this.#end) { await this.#send(tlsControl({ kind: "end" })); this.#child.stdin.end(); }
        await completion.promise;
        await this.#deliver(() => done());
      } catch (error) { if (this.#applicationFailed) throw error; await this.#deliver(() => done(streamError(error))); }
    }
    async #control(child: PipedChildHandle): Promise<void> {
      try {
        for (;;) {
          const frame = await readTlsFrame(child.stderr); if (frame === null) break;
          if (this.#closeFrame) throw protocol();
          await this.#event(frame);
        }
        if (!this.#closeFrame && !this.#closing) throw protocol();
      } catch (error) { if (this.#applicationFailed) throw error; if (!this.#closing) await this.#deliver(() => { this.destroy(streamError(error)); }); }
    }
    async #event(frame: TlsFrame): Promise<void> {
      if (this.#closing) return;
      switch (frame.kind) {
        case "connect":
          if (this.#address !== undefined) throw protocol();
          this.#address = frame; await this.#deliver(() => { this.emit("connect"); this.emit("ready"); }); return;
        case "secure":
          if (this.#address === undefined || this.#secure !== undefined || (this.#verifyCertificate && !frame.authorized)) throw protocol();
          for (const key of ["localAddress", "localPort", "remoteAddress", "remotePort"] as const) if (frame[key] !== this.#address[key]) throw protocol();
          this.#secure = frame; this.#ready.resolve(undefined); await this.#deliver(() => { this.emit("secureConnect"); }); return;
        case "written": {
          const pending = this.#writeReply; if (pending === undefined || pending.count !== frame.count) throw protocol();
          this.#writeReply = undefined; pending.completion.resolve(undefined); return;
        }
        case "finished":
          if (this.#finished) throw protocol();
          this.#finished = true; this.#finishReply?.resolve(undefined); this.#finishReply = undefined; return;
        case "end":
          if (this.#end || this.#secure === undefined) throw protocol();
          this.#end = true; this.#remoteEnd.resolve(undefined); this.#child?.stdin.end(); return;
        case "timeout": await this.#deliver(() => { this.emit("timeout"); }); return;
        case "error": this.#remoteError = true; await this.#deliver(() => { this.destroy(failure(frame.code, frame.message)); }); return;
        case "close": if (frame.hadError !== this.#remoteError) throw protocol(); this.#closeFrame = true; return;
        case "data": throw protocol();
      }
    }
    async #data(child: PipedChildHandle): Promise<void> {
      try {
        await this.#ready.promise;
        for (;;) {
          const frame = await readTlsFrame(child.stdout); if (frame === null) break;
          if (frame.kind !== "data") throw protocol();
          if (this.destroyed) continue;
          this.#readBytes += frame.bytes.length;
          const demand = Promise.withResolvers<undefined>(); this.#demand = demand;
          const accepted = await this.#deliver(() => this.push(frame.bytes));
          if (!accepted) await demand.promise;
          this.#demand = undefined;
        }
        await this.#remoteEnd.promise;
        if (!this.destroyed) await this.#deliver(() => { this.push(null); });
      } catch (error) { if (this.#applicationFailed) throw error; if (!this.#closing) await this.#deliver(() => { this.destroy(streamError(error)); }); }
    }
    async #destroy(error: Error | null, done: Completion): Promise<void> {
      this.#closing = true;
      const reason = error ?? failure("ERR_SOCKET_CLOSED", "TLS socket closed");
      this.#ready.reject(reason); this.#remoteEnd.reject(reason); this.#writeReply?.completion.reject(reason); this.#finishReply?.reject(reason); this.#demand?.resolve(undefined);
      if (this.#child !== undefined) {
        if (error !== null || !this.#end || !this.#finished) this.#child.kill("SIGKILL");
        await this.#retired.promise;
      }
      this.#release?.(); this.#release = undefined;
      await this.#deliver(() => done(error));
    }
  }
  return { connect: (...args: unknown[]) => new TLSSocket().connect(...args), TLSSocket };
}
function connectArguments(args: unknown[]): { options: Record<string, unknown>; callback?: (...args: unknown[]) => void } {
  const values = [...args]; const last = values.at(-1); const callback = isEventListener(last) ? last : undefined;
  if (callback !== undefined) values.pop();
  let options: Record<string, unknown>;
  if (typeof values[0] === "number" || typeof values[0] === "string") {
    const port = values.shift(); const host = typeof values[0] === "string" ? values.shift() : "localhost";
    if (values.length > 1) throw new TypeError("Invalid tls.connect arguments");
    options = { ...(values.length === 0 ? {} : record(values.at(0), "TLS options")), port, host };
  } else {
    if (values.length !== 1) throw new TypeError("Invalid tls.connect arguments");
    options = { ...record(values[0], "TLS options") };
  }
  exactKeys(options, ["port"], ["host", ...TLS_OPTION_NAMES]);
  options["host"] ??= "localhost";
  const host = options["host"];
  if (typeof host !== "string" || host.includes("\0") || Buffer.byteLength(host) > 4096) throw new TypeError("Invalid TLS host");
  if (typeof options["port"] === "string" && /^\d+$/u.test(options["port"])) options["port"] = Number(options["port"]);
  const port = options["port"];
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw failure("ERR_SOCKET_BAD_PORT", "Invalid TLS port");
  options = { host: options["host"], port, ...tlsOptions(options) };
  return { options, ...(callback === undefined ? {} : { callback }) };
}
function failure(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
function protocol(): VMError { return new VMError("PROTOCOL_ERROR", "Invalid native TLS lifecycle"); }

export const TLS_OPTION_NAMES = ["ca", "servername", "rejectUnauthorized", "ALPNProtocols", "minVersion", "maxVersion"] as const;
type Version = "TLSv1" | "TLSv1.1" | "TLSv1.2" | "TLSv1.3";
export type TlsOptions = {
  readonly ca?: string; readonly servername?: string; readonly rejectUnauthorized?: boolean;
  readonly ALPNProtocols?: readonly string[]; readonly minVersion?: Version; readonly maxVersion?: Version;
};
/** Capture every supported handshake input before agent admission. The same
 * immutable values feed connection identity and the guest TLS invocation. */
export function tlsOptions(input: Readonly<Record<string, unknown>>): TlsOptions {
  const result: { ca?: string; servername?: string; rejectUnauthorized?: boolean; ALPNProtocols?: string[]; minVersion?: Version; maxVersion?: Version } = {};
  for (const name of TLS_OPTION_NAMES) {
    const value = input[name]; if (value === undefined) continue;
    if (name === "ca" || name === "servername") {
      const text = value instanceof Uint8Array && name === "ca" ? new TextDecoder("utf-8", { fatal: true }).decode(value) : value;
      if (typeof text !== "string" || text.includes("\0") || Buffer.byteLength(text) > (name === "ca" ? 65536 : 4096)) throw new TypeError(`Invalid TLS ${name}`);
      result[name] = text;
    } else if (name === "rejectUnauthorized") {
      if (typeof value !== "boolean") throw new TypeError("Invalid TLS rejectUnauthorized");
      result.rejectUnauthorized = value;
    } else if (name === "ALPNProtocols") {
      if (!Array.isArray(value) || value.length > 32) throw new TypeError("Invalid TLS ALPNProtocols");
      result.ALPNProtocols = value.map((entry: unknown) => {
        if (typeof entry !== "string" || Buffer.byteLength(entry) === 0 || Buffer.byteLength(entry) > 255) throw new TypeError("Invalid TLS ALPN protocol");
        return entry;
      });
    } else {
      if (value !== "TLSv1" && value !== "TLSv1.1" && value !== "TLSv1.2" && value !== "TLSv1.3") throw new TypeError(`Invalid TLS ${name}`);
      result[name] = value;
    }
  }
  return result;
}
