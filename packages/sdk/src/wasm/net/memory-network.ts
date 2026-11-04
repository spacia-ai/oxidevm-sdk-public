import type { LinuxSocketAddress } from "../../js-process-types.js";
import { VMError } from "../../runtime/errors.js";
import { LinuxError } from "../../runtime/js-process/codec.js";
import type { ModuleReach } from "../reach.js";
import type { Datagram, NetSockets, NetSyncSockets } from "./ports.js";
import type { TlsLayer } from "./streams.js";

/**
 * A deterministic in-memory network with the VM's policy (engine ADR 0029, N-5 and N-9), for unit tests and `testHost`:
 * loopback and the VM's own address are inside the VM, everything else is the internet, which is reachable only while
 * the network is `connected`. The module's reach is enforced as Rust enforces it, with the same errnos: EACCES beyond the
 * reach, EPERM while local-only, ECONNRESET for connections a revoke cut. Servers react synchronously to what a client
 * writes, or later on the network's own clock (`MemoryConnection.after`). A synchronous read blocks as the browser's
 * does: when nothing has arrived, the clock moves to the next scheduled action until bytes or the end arrive. A read
 * that nothing can ever answer (no bytes, no scheduled action, no timeout) would block the real host forever; here it
 * fails with FEATURE_NOT_AVAILABLE (`testhost-blocked-read`) instead of hanging the test.
 */
export const VM_ADDRESS = "10.0.2.15";
const EPERM = 1, ENOENT = 2, EBADF = 9, EACCES = 13, EINVAL = 22, ECONNRESET = 104, ECONNREFUSED = 111, ENOTCONN = 107;
const MAX_READ = 256 * 1024;

export type NetworkState = "local-only" | "connected" | "revoked";

/** The server's end of one connection. */
export interface MemoryConnection {
  readonly remote: string;
  write(bytes: Uint8Array): void;
  /** Ends the server's half: the client reads end of stream once the bytes before it are read. */
  end(): void;
  /** Resets the connection: the client's next operation fails with ECONNRESET. */
  reset(): void;
  /**
   * Runs `action` once `ms` milliseconds of the network's clock have passed. The clock moves only while a client waits:
   * a blocking read that finds nothing, a timed read's pauses, or an asynchronous read that finds nothing.
   */
  after(ms: number, action: () => void): void;
}

export interface MemoryServer {
  connected?(connection: MemoryConnection): void;
  data(connection: MemoryConnection, bytes: Uint8Array): void;
  /** The client ended its half (shutdown or close). */
  ended?(connection: MemoryConnection): void;
}

/** A UDP service: the answer datagram to one datagram, or null for none. */
export type MemoryDatagramServer = (bytes: Uint8Array) => Uint8Array | null;

interface Stream {
  readonly kind: "stream";
  readonly family: LinuxSocketAddress["family"];
  peer: { readonly server: MemoryServer; readonly connection: MemoryConnection; readonly external: boolean; readonly port: number } | null;
  readonly inbox: Uint8Array[];
  serverEnded: boolean;
  failed: number;
  waiter: (() => void) | null;
}
interface Socket { readonly kind: "datagram"; readonly inbox: Datagram[]; waiter: (() => void) | null }

function isLoopback(address: string): boolean { return address.startsWith("127.") || address === "::1"; }

export class MemoryNetwork {
  state: NetworkState = "local-only";
  readonly files = new Map<string, Uint8Array>();
  readonly #servers = new Map<string, MemoryServer>();
  readonly #datagramServers = new Map<string, MemoryDatagramServer>();
  readonly #sockets = new Map<number, Stream | Socket>();
  #next = 100;
  /** The network's clock, in milliseconds, and the actions scheduled on it in the order they are due. */
  #now = 0;
  #scheduled: { readonly at: number; readonly order: number; readonly action: () => void }[] = [];
  #order = 0;
  /** Every connection or datagram a module process attempted, in order, with what the network decided. */
  readonly attempts: { readonly address: string; readonly port: number; readonly protocol: "tcp" | "udp"; readonly errno: number }[] = [];

  constructor(readonly reach: ModuleReach) {}

  listen(address: string, port: number, server: MemoryServer): void { this.#servers.set(`${address}:${String(port)}`, server); }
  /** A Unix-domain stream service at `path`, inside the VM: any reach but `none` may connect to it. */
  listenUnix(path: string, server: MemoryServer): void { this.#servers.set(`unix:${path}`, server); }
  listenDatagram(address: string, port: number, server: MemoryDatagramServer): void { this.#datagramServers.set(`${address}:${String(port)}`, server); }
  file(path: string, text: string): void { this.files.set(path, new TextEncoder().encode(text)); }

  /** Cuts every connection that left the VM, as a revoke does, and keeps the VM local-only. */
  revoke(): void {
    this.state = "revoked";
    for (const socket of this.#sockets.values()) if (socket.kind === "stream" && socket.peer?.external === true) { socket.failed = ECONNRESET; socket.waiter?.(); }
  }

  /** The errno Rust's socket owner answers for a destination, or 0 to allow it. */
  decide(address: string, port: number, protocol: "tcp" | "udp"): number {
    const external = !isLoopback(address) && address !== VM_ADDRESS;
    const errno = this.reach === "none" ? EACCES
      : external && this.reach === "vm" ? EACCES
      : external && this.state !== "connected" ? EPERM
      : external && protocol === "tcp" && port !== 80 && port !== 443 ? EPERM
      : 0;
    this.attempts.push({ address, port, protocol, errno });
    return errno;
  }

  /** Schedules `action` `ms` milliseconds from now on the network's clock. */
  after(ms: number, action: () => void): void {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new VMError("INVALID_ARGUMENT", "a scheduled action needs a whole number of milliseconds", { reason: "testhost-schedule" });
    this.#scheduled.push({ at: this.#now + ms, order: this.#order++, action });
    this.#scheduled.sort((left, right) => left.at - right.at || left.order - right.order);
  }

  /** Moves the clock forward by `ms`, running every action due by then in order. */
  advance(ms: number): void {
    const until = this.#now + Math.max(0, ms);
    for (let next = this.#scheduled[0]; next !== undefined && next.at <= until; next = this.#scheduled[0]) {
      this.#scheduled.shift(); this.#now = next.at; next.action();
    }
    this.#now = until;
  }

  /** Moves the clock to the next scheduled action and runs it; false when nothing is scheduled. */
  #runNext(): boolean {
    const next = this.#scheduled[0];
    if (next === undefined) return false;
    this.advance(next.at - this.#now);
    return true;
  }

  /** A blocking read: bytes or the end of stream, moving the clock while nothing has arrived. */
  readBlocking(fd: number, max: number): Uint8Array {
    for (;;) {
      const bytes = this.readNow(fd, max);
      if (bytes !== null) return bytes;
      if (!this.#runNext()) {
        const peer = this.#stream(fd).peer, from = peer === null ? "an unconnected socket" : `${peer.connection.remote}:${String(peer.port)}`;
        throw new VMError("FEATURE_NOT_AVAILABLE", `testHost: a blocking read from ${from} would wait forever: its server has sent nothing more, nothing is scheduled on the network's clock and the read has no timeout (a request handler answers asynchronously, so a blocking client needs a TCP service, net.tcp)`, { reason: "testhost-blocked-read" });
      }
    }
  }

  #socket(fd: number): Stream | Socket {
    const socket = this.#sockets.get(fd);
    if (socket === undefined) throw new LinuxError(EBADF);
    return socket;
  }
  #stream(fd: number): Stream {
    const socket = this.#socket(fd);
    if (socket.kind !== "stream") throw new LinuxError(EINVAL);
    return socket;
  }
  #datagram(fd: number): Socket {
    const socket = this.#socket(fd);
    if (socket.kind !== "datagram") throw new LinuxError(EINVAL);
    return socket;
  }

  openStream(family: LinuxSocketAddress["family"]): number {
    const fd = this.#next++;
    this.#sockets.set(fd, { kind: "stream", family, peer: null, inbox: [], serverEnded: false, failed: 0, waiter: null });
    return fd;
  }
  openDatagram(): number { const fd = this.#next++; this.#sockets.set(fd, { kind: "datagram", inbox: [], waiter: null }); return fd; }

  connect(fd: number, address: LinuxSocketAddress): void {
    const stream = this.#stream(fd);
    if ((stream.family === "unix") !== (address.family === "unix")) throw new LinuxError(EINVAL);
    if (address.family === "unix") {
      // Rust holds a Unix connect to the module's reach too: none refuses it, any other reach stays inside the VM.
      if (this.reach === "none") throw new LinuxError(EACCES);
      const server = this.#servers.get(`unix:${address.path}`);
      if (server === undefined) throw new LinuxError(ENOENT);
      this.#attach(stream, server, address.path, false, 0);
      return;
    }
    const errno = this.decide(address.address, address.port, "tcp");
    if (errno !== 0) throw new LinuxError(errno);
    const server = this.#servers.get(`${address.address}:${String(address.port)}`);
    if (server === undefined) throw new LinuxError(ECONNREFUSED);
    this.#attach(stream, server, address.address, !isLoopback(address.address) && address.address !== VM_ADDRESS, address.port);
  }

  #attach(stream: Stream, server: MemoryServer, remote: string, external: boolean, port: number): void {
    const wake = (): void => { const waiter = stream.waiter; stream.waiter = null; waiter?.(); };
    const connection: MemoryConnection = {
      remote,
      write: bytes => { if (stream.failed === 0 && !stream.serverEnded) { stream.inbox.push(bytes.slice()); wake(); } },
      end: () => { stream.serverEnded = true; wake(); },
      reset: () => { stream.failed = ECONNRESET; wake(); },
      after: (ms, action) => { this.after(ms, action); },
    };
    stream.peer = { server, connection, external, port };
    server.connected?.(connection);
  }

  /** What a read finds now: bytes, end of stream (empty), or null when it must wait. */
  readNow(fd: number, max: number): Uint8Array | null {
    const stream = this.#stream(fd);
    if (stream.failed !== 0) throw new LinuxError(stream.failed);
    if (stream.peer === null) throw new LinuxError(ENOTCONN);
    const head = stream.inbox[0];
    if (head === undefined) return stream.serverEnded ? new Uint8Array() : null;
    const count = Math.min(max, MAX_READ, head.length), out = head.slice(0, count);
    if (count === head.length) stream.inbox.shift(); else stream.inbox[0] = head.subarray(count);
    return out;
  }

  async read(fd: number, max: number, signal?: AbortSignal): Promise<Uint8Array> {
    for (;;) {
      const bytes = this.readNow(fd, max);
      if (bytes !== null) return bytes;
      if (signal?.aborted !== true && this.#runNext()) continue;
      const stream = this.#stream(fd);
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => { stream.waiter = null; reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError")); };
        if (signal?.aborted === true) { abort(); return; }
        signal?.addEventListener("abort", abort, { once: true });
        stream.waiter = () => { signal?.removeEventListener("abort", abort); resolve(); };
      });
    }
  }

  write(fd: number, bytes: Uint8Array): number {
    const stream = this.#stream(fd);
    if (stream.failed !== 0) throw new LinuxError(stream.failed);
    const peer = stream.peer;
    if (peer === null) throw new LinuxError(ENOTCONN);
    peer.server.data(peer.connection, bytes.slice());
    return bytes.length;
  }

  shutdown(fd: number): void { const peer = this.#stream(fd).peer; peer?.server.ended?.(peer.connection); }

  close(fd: number): void {
    const socket = this.#sockets.get(fd);
    if (socket === undefined) throw new LinuxError(EBADF);
    this.#sockets.delete(fd);
    if (socket.kind === "stream" && socket.peer !== null) socket.peer.server.ended?.(socket.peer.connection);
  }

  sendTo(fd: number, bytes: Uint8Array, destination: LinuxSocketAddress): number {
    const socket = this.#datagram(fd);
    if (destination.family === "unix") throw new LinuxError(EINVAL);
    const errno = this.decide(destination.address, destination.port, "udp");
    if (errno !== 0) throw new LinuxError(errno);
    const server = this.#datagramServers.get(`${destination.address}:${String(destination.port)}`);
    const answer = server?.(bytes.slice()) ?? null;
    if (answer !== null) { socket.inbox.push({ bytes: answer, source: destination }); const waiter = socket.waiter; socket.waiter = null; waiter?.(); }
    return bytes.length;
  }

  receiveNow(fd: number, max: number): Datagram | null {
    const head = this.#datagram(fd).inbox.shift();
    return head === undefined ? null : { bytes: head.bytes.slice(0, max), source: head.source };
  }

  async receiveFrom(fd: number, max: number, signal?: AbortSignal): Promise<Datagram> {
    for (;;) {
      const datagram = this.receiveNow(fd, max);
      if (datagram !== null) return datagram;
      const socket = this.#datagram(fd);
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => { socket.waiter = null; reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError")); };
        if (signal?.aborted === true) { abort(); return; }
        signal?.addEventListener("abort", abort, { once: true });
        socket.waiter = () => { signal?.removeEventListener("abort", abort); resolve(); };
      });
    }
  }

  readFile(path: string, max: number): Uint8Array | null { return this.files.get(path)?.slice(0, max) ?? null; }

  /** The network as the module process's asynchronous sockets. */
  sockets(): NetSockets {
    return {
      stream: family => Promise.resolve(this.openStream(family)),
      connect: (fd, address) => Promise.resolve().then(() => { this.connect(fd, address); }),
      read: (fd, max, signal) => this.read(fd, max, signal),
      write: (fd, bytes) => Promise.resolve().then(() => this.write(fd, bytes)),
      shutdown: fd => Promise.resolve().then(() => { this.shutdown(fd); }),
      close: fd => Promise.resolve().then(() => { this.close(fd); }),
      datagram: () => Promise.resolve(this.openDatagram()),
      sendTo: (fd, bytes, destination) => Promise.resolve().then(() => this.sendTo(fd, bytes, destination)),
      receiveFrom: (fd, max, signal) => this.receiveFrom(fd, max, signal),
      readFile: (path, max) => Promise.resolve(this.readFile(path, max)),
    };
  }

  /** The network as the module process's synchronous sockets. */
  syncSockets(): NetSyncSockets {
    return {
      stream: family => this.openStream(family),
      connect: (fd, address) => { this.connect(fd, address); },
      read: (fd, max) => this.readBlocking(fd, max),
      readNow: (fd, max) => this.readNow(fd, max),
      write: (fd, bytes) => this.write(fd, bytes),
      shutdown: fd => { this.shutdown(fd); },
      close: fd => { this.close(fd); },
      datagram: () => this.openDatagram(),
      sendTo: (fd, bytes, destination) => this.sendTo(fd, bytes, destination),
      receiveNow: (fd, max) => this.receiveNow(fd, max),
      sleep: ms => { this.advance(ms); },
      readFile: (path, max) => this.readFile(path, max),
    };
  }
}

/**
 * TLS for the in-memory network: servers there speak plaintext, so the layer passes bytes through and reports the first
 * offered ALPN protocol. The real client (`engineTls`) runs only against the engine's TLS module.
 */
export const PASS_THROUGH_TLS: TlsLayer = {
  wrap: (raw, _host, alpn) => Promise.resolve({ ...raw, alpn: alpn[0] ?? null }),
  wrapSync: (raw, _host, alpn) => ({ ...raw, alpn: alpn[0] ?? null }),
  session: (_host, alpn) => {
    const toPeer: Uint8Array[] = [], fromPeer: Uint8Array[] = [];
    let state: "established" | "closed" = "established";
    const take = (queue: Uint8Array[], max = Number.MAX_SAFE_INTEGER): Uint8Array => {
      const head = queue.shift();
      if (head === undefined) return new Uint8Array();
      if (head.length > max) queue.unshift(head.subarray(max));
      return head.slice(0, max);
    };
    return Object.freeze({
      receive: (bytes: Uint8Array) => { fromPeer.push(bytes.slice()); },
      takeTls: () => take(toPeer),
      send: (bytes: Uint8Array) => { toPeer.push(bytes.slice()); },
      takePlaintext: (max: number) => take(fromPeer, max),
      state: () => state,
      alpn: () => alpn[0] ?? null,
      // Plaintext servers present no certificate and negotiate nothing.
      peerCertificates: () => [],
      protocolVersion: () => null,
      cipherSuite: () => null,
      close: () => { state = "closed"; },
      free: () => undefined,
    });
  },
};
