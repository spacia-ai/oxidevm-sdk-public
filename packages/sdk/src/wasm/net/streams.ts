import type { NetTlsSession } from "../capabilities.js";
import type { ModuleReach } from "../reach.js";
import { socketAddress } from "./addresses.js";
import { aborted, abortReason, NetError, netError } from "./errors.js";
import type { NetSockets, NetSyncSockets } from "./ports.js";
import { resolve, resolveSync } from "./resolver.js";
import { TlsEngine, type TlsSession } from "./tls.js";

/**
 * Connections on the module process's own VM sockets (engine ADR 0029, N-3): a name is resolved by the VM resolver, each
 * address is tried in order on a TCP socket of the process, and TLS, when asked, runs end to end inside this worker,
 * verified against the VM's `/etc/ssl/cert.pem`. A policy refusal (EPERM local-only, EACCES beyond the reach) stops at
 * once; only ordinary failures move on to the next address.
 */
export interface ByteStream {
  /** Up to `max` bytes; empty at the peer's end of stream. */
  read(max: number, signal?: AbortSignal): Promise<Uint8Array>;
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  /** Ends this side's writing (TLS close_notify, then TCP shutdown); reading continues. */
  closeWrite(): Promise<void>;
  close(): Promise<void>;
  readonly alpn: string | null;
}

export interface SyncByteStream {
  /** Up to `max` bytes, empty at the peer's end of stream; with `timeoutMs`, waits at most that long for them. */
  read(max: number, timeoutMs?: number): Uint8Array;
  write(bytes: Uint8Array): void;
  closeWrite(): void;
  close(): void;
  readonly alpn: string | null;
}

export interface DialOptions {
  readonly host: string;
  readonly port: number;
  readonly tls?: boolean;
  readonly alpn?: readonly string[];
  readonly signal?: AbortSignal;
}

/** How TLS is put on a connection: the engine's client, or (in `testHost`) a stand-in that leaves the bytes as they are. */
export interface TlsLayer {
  wrap(raw: ByteStream, host: string, alpn: readonly string[], signal?: AbortSignal): Promise<ByteStream>;
  wrapSync(raw: SyncByteStream, host: string, alpn: readonly string[]): SyncByteStream;
  /** A sans-IO session for a caller that moves the ciphertext itself; `trust` comes from `decodeTrust`. */
  session(host: string, alpn: readonly string[], trust: readonly Uint8Array[]): NetTlsSession;
}

const READ_BYTES = 64 * 1024, ROOTS = "/etc/ssl/cert.pem", MAX_ROOTS_BYTES = 4 * 1024 * 1024;
const POLICY = new Set(["EPERM", "EACCES"]);
const EAGAIN = 11, MAX_READ_PAUSE_MS = 32;

function isPolicy(error: unknown): boolean { return error instanceof NetError && POLICY.has(error.code); }

function port(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new NetError("ERR_INVALID_URL", `Invalid port ${String(value)}`);
  return value;
}

function tcpStream(sockets: NetSockets, fd: number, host: string): ByteStream {
  let closed = false;
  return {
    alpn: null,
    read: async (max, signal) => { try { return await sockets.read(fd, max, signal); } catch (error: unknown) { if (signal !== undefined && aborted(signal)) throw abortReason(signal); throw netError(error, "read", host); } },
    write: async (bytes, signal) => {
      for (let at = 0; at < bytes.length;) {
        try { at += await sockets.write(fd, bytes.subarray(at), signal); }
        catch (error: unknown) { if (signal !== undefined && aborted(signal)) throw abortReason(signal); throw netError(error, "write", host); }
      }
    },
    closeWrite: async () => { await sockets.shutdown(fd).catch(() => undefined); },
    close: async () => { if (closed) return; closed = true; await sockets.close(fd).catch(() => undefined); },
  };
}

/** A read that waited `timeoutMs` for bytes: ETIMEDOUT, with the errno Linux gives a receive timeout (EAGAIN). */
function readTimedOut(host: string, timeoutMs: number): NetError {
  return new NetError("ETIMEDOUT", `read ${host}: no bytes arrived within ${String(timeoutMs)} ms`, { errno: EAGAIN, syscall: "read", hostname: host });
}

/**
 * A read that waits at most `timeoutMs`: non-blocking reads, with pauses from 1 ms doubling to 32 ms between them, so a
 * long wait costs few operations and a short one ends close to its deadline. The time is the sum of the pauses, as the
 * synchronous resolver counts it.
 */
function timedRead(sockets: NetSyncSockets, fd: number, max: number, host: string, timeoutMs: number): Uint8Array {
  for (let waited = 0, pause = 1; ; pause = Math.min(pause * 2, MAX_READ_PAUSE_MS)) {
    const bytes = sockets.readNow(fd, max);
    if (bytes !== null) return bytes;
    if (waited >= timeoutMs) throw readTimedOut(host, timeoutMs);
    const step = Math.min(pause, timeoutMs - waited);
    sockets.sleep(step); waited += step;
  }
}

function tcpSyncStream(sockets: NetSyncSockets, fd: number, host: string): SyncByteStream {
  let closed = false;
  return {
    alpn: null,
    read: (max, timeoutMs) => {
      try { return timeoutMs === undefined ? sockets.read(fd, max) : timedRead(sockets, fd, max, host, timeoutMs); }
      catch (error: unknown) { throw netError(error, "read", host); }
    },
    write: bytes => { for (let at = 0; at < bytes.length;) { try { at += sockets.write(fd, bytes.subarray(at)); } catch (error: unknown) { throw netError(error, "write", host); } } },
    closeWrite: () => { try { sockets.shutdown(fd); } catch { /* already gone */ } },
    close: () => { if (closed) return; closed = true; try { sockets.close(fd); } catch { /* already closed */ } },
  };
}

/** Opens a TCP connection to the first address of `host` that accepts it. */
export async function dialTcp(sockets: NetSockets, reach: ModuleReach, host: string, portNumber: number, signal?: AbortSignal): Promise<ByteStream> {
  const target = port(portNumber);
  let last: unknown = new NetError("ENOTFOUND", `getaddrinfo ENOTFOUND ${host}`, { hostname: host });
  for (const address of await resolve(sockets, reach, host, signal)) {
    if (signal !== undefined && aborted(signal)) throw abortReason(signal);
    const destination = socketAddress(address, target);
    let fd: number;
    try { fd = await sockets.stream(destination.family === "ipv6" ? "ipv6" : "ipv4"); } catch (error: unknown) { throw netError(error, "socket", host); }
    try { await sockets.connect(fd, destination, signal); return tcpStream(sockets, fd, host); }
    catch (error: unknown) {
      await sockets.close(fd).catch(() => undefined);
      if (signal !== undefined && aborted(signal)) throw abortReason(signal);
      last = netError(error, "connect", host);
      if (isPolicy(last)) throw last;
    }
  }
  throw last;
}

export function dialTcpSync(sockets: NetSyncSockets, reach: ModuleReach, host: string, portNumber: number): SyncByteStream {
  const target = port(portNumber);
  let last: unknown = new NetError("ENOTFOUND", `getaddrinfo ENOTFOUND ${host}`, { hostname: host });
  for (const address of resolveSync(sockets, reach, host)) {
    const destination = socketAddress(address, target);
    let fd: number;
    try { fd = sockets.stream(destination.family === "ipv6" ? "ipv6" : "ipv4"); } catch (error: unknown) { throw netError(error, "socket", host); }
    try { sockets.connect(fd, destination); return tcpSyncStream(sockets, fd, host); }
    catch (error: unknown) {
      try { sockets.close(fd); } catch { /* already closed */ }
      last = netError(error, "connect", host);
      if (isPolicy(last)) throw last;
    }
  }
  throw last;
}

function tlsStream(session: TlsSession, raw: ByteStream, alpn: string | null): ByteStream {
  const flush = async (signal?: AbortSignal): Promise<void> => { const out = session.takeTls(); if (out.length > 0) await raw.write(out, signal); };
  let closed = false;
  return {
    alpn,
    read: async (max, signal) => {
      for (;;) {
        const plain = session.takePlaintext(max);
        if (plain.length > 0) return plain;
        const { state } = session.status();
        if (state === "failed") session.assertHealthy();
        if (state === "peer-closed" || state === "closed") return new Uint8Array();
        await flush(signal);
        const bytes = await raw.read(READ_BYTES, signal);
        // A server that closes without close_notify ends the stream, as browsers and Node treat it.
        if (bytes.length === 0) return bytes;
        session.receive(bytes);
      }
    },
    write: async (bytes, signal) => { session.send(bytes); await flush(signal); },
    closeWrite: async () => { session.close(); await flush().catch(() => undefined); },
    close: async () => {
      if (closed) return; closed = true;
      session.close(); await flush().catch(() => undefined);
      session.free(); await raw.close();
    },
  };
}

function tlsSyncStream(session: TlsSession, raw: SyncByteStream, alpn: string | null): SyncByteStream {
  const flush = (): void => { const out = session.takeTls(); if (out.length > 0) raw.write(out); };
  let closed = false;
  return {
    alpn,
    // A timeout bounds each wait for ciphertext from the peer, as a receive timeout bounds each recv.
    read: (max, timeoutMs) => {
      for (;;) {
        const plain = session.takePlaintext(max);
        if (plain.length > 0) return plain;
        const { state } = session.status();
        if (state === "failed") session.assertHealthy();
        if (state === "peer-closed" || state === "closed") return new Uint8Array();
        flush();
        const bytes = raw.read(READ_BYTES, timeoutMs);
        if (bytes.length === 0) return bytes;
        session.receive(bytes);
      }
    },
    write: bytes => { session.send(bytes); flush(); },
    closeWrite: () => { session.close(); try { flush(); } catch { /* the peer is gone */ } },
    close: () => {
      if (closed) return; closed = true;
      session.close(); try { flush(); } catch { /* the peer is gone */ }
      session.free(); raw.close();
    },
  };
}

function handshakeEnded(session: TlsSession): NetError {
  session.assertHealthy();
  return new NetError("ECONNRESET", `TLS ${session.hostname}: the server closed the connection during the handshake`, { hostname: session.hostname });
}

/**
 * The engine's TLS client as a layer: one engine per module process, created on first use from the compiled module the
 * process was started with and the VM's trust store, read then. Without `/etc/ssl/cert.pem` TLS fails with
 * ERR_TLS_NO_TRUST_STORE: the SDK carries no CA data of its own.
 */
export function engineTls(module: WebAssembly.Module | null, sockets: NetSockets, sync: NetSyncSockets): TlsLayer {
  let engine: TlsEngine | undefined;
  const create = (roots: Uint8Array | null): TlsEngine => {
    if (module === null) throw new NetError("ERR_TLS_PROTOCOL", "TLS is not available to this module process");
    if (roots === null) throw new NetError("ERR_TLS_NO_TRUST_STORE", `TLS needs the VM's trust store at ${ROOTS}`);
    return engine ??= new TlsEngine(module, roots);
  };
  return {
    session: (host, alpn, trust) => sansIo(engine ?? create(sync.readFile(ROOTS, MAX_ROOTS_BYTES)), host, alpn, trust),
    wrap: async (raw, host, alpn, signal) => {
      try {
        const tls = engine ?? create(await sockets.readFile(ROOTS, MAX_ROOTS_BYTES)), session = tls.open(host, alpn);
        try {
          for (;;) {
            const out = session.takeTls();
            if (out.length > 0) await raw.write(out, signal);
            const { state } = session.status();
            if (state === "established") return tlsStream(session, raw, session.alpn());
            if (state !== "handshaking") throw handshakeEnded(session);
            const bytes = await raw.read(READ_BYTES, signal);
            if (bytes.length === 0) throw handshakeEnded(session);
            session.receive(bytes);
          }
        } catch (error: unknown) { session.free(); throw error; }
      } catch (error: unknown) { await raw.close(); throw error; }
    },
    wrapSync: (raw, host, alpn) => {
      try {
        const tls = engine ?? create(sync.readFile(ROOTS, MAX_ROOTS_BYTES)), session = tls.open(host, alpn);
        try {
          for (;;) {
            const out = session.takeTls();
            if (out.length > 0) raw.write(out);
            const { state } = session.status();
            if (state === "established") return tlsSyncStream(session, raw, session.alpn());
            if (state !== "handshaking") throw handshakeEnded(session);
            const bytes = raw.read(READ_BYTES);
            if (bytes.length === 0) throw handshakeEnded(session);
            session.receive(bytes);
          }
        } catch (error: unknown) { session.free(); throw error; }
      } catch (error: unknown) { raw.close(); throw error; }
    },
  };
}

function sansIo(engine: TlsEngine, host: string, alpn: readonly string[], trust: readonly Uint8Array[]): NetTlsSession {
  const session = engine.open(host, alpn, trust);
  return Object.freeze({
    receive: (bytes: Uint8Array) => { session.receive(bytes); },
    takeTls: () => session.takeTls(),
    send: (bytes: Uint8Array) => { session.send(bytes); },
    takePlaintext: (max: number) => session.takePlaintext(max),
    state: () => session.status().state,
    alpn: () => session.alpn(),
    peerCertificates: () => session.peerCertificates(),
    protocolVersion: () => session.protocolVersion(),
    cipherSuite: () => session.cipherSuite(),
    close: () => { session.close(); },
    free: () => { session.free(); },
  });
}

/** Opens a connection as `host.net.connect` describes it. */
export async function dial(sockets: NetSockets, reach: ModuleReach, tls: TlsLayer, options: DialOptions): Promise<ByteStream> {
  const raw = await dialTcp(sockets, reach, options.host, options.port, options.signal);
  return options.tls === true ? tls.wrap(raw, options.host, options.alpn ?? [], options.signal) : raw;
}

export function dialSync(sockets: NetSyncSockets, reach: ModuleReach, tls: TlsLayer, options: DialOptions): SyncByteStream {
  const raw = dialTcpSync(sockets, reach, options.host, options.port);
  return options.tls === true ? tls.wrapSync(raw, options.host, options.alpn ?? []) : raw;
}
