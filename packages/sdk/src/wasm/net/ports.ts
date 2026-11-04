import type { LinuxSocketAddress } from "../../js-process-types.js";

/**
 * What the module network client needs of its process (engine ADR 0029, N-3): the module process's own VM sockets,
 * asynchronous for `fetch`/`WebSocket`/`host.net` and synchronous for interpreters, and its guest files. The runner binds
 * them to the process's Linux client; `testHost` binds them to an in-memory network. Descriptors are plain numbers here
 * because they never reach module code.
 */
export interface Datagram { readonly bytes: Uint8Array; readonly source: LinuxSocketAddress | null }

export interface NetSockets {
  stream(family: "ipv4" | "ipv6"): Promise<number>;
  connect(fd: number, address: LinuxSocketAddress, signal?: AbortSignal): Promise<void>;
  /** Up to `max` bytes; an empty answer is the peer's end of stream. */
  read(fd: number, max: number, signal?: AbortSignal): Promise<Uint8Array>;
  write(fd: number, bytes: Uint8Array, signal?: AbortSignal): Promise<number>;
  shutdown(fd: number): Promise<void>;
  close(fd: number): Promise<void>;
  datagram(family: "ipv4" | "ipv6"): Promise<number>;
  sendTo(fd: number, bytes: Uint8Array, destination: LinuxSocketAddress): Promise<number>;
  receiveFrom(fd: number, max: number, signal?: AbortSignal): Promise<Datagram>;
  /** A guest file's bytes up to `max`, or null when it does not exist. */
  readFile(path: string, max: number): Promise<Uint8Array | null>;
}

export interface NetSyncSockets {
  /** A stream socket: TCP over IPv4 or IPv6, or a Unix-domain stream socket (`connectUnixSync`). */
  stream(family: LinuxSocketAddress["family"]): number;
  connect(fd: number, address: LinuxSocketAddress): void;
  read(fd: number, max: number): Uint8Array;
  /** Never blocks: what has arrived (up to `max` bytes, empty at the peer's end of stream), or null when nothing has. */
  readNow(fd: number, max: number): Uint8Array | null;
  write(fd: number, bytes: Uint8Array): number;
  shutdown(fd: number): void;
  close(fd: number): void;
  datagram(family: "ipv4" | "ipv6"): number;
  sendTo(fd: number, bytes: Uint8Array, destination: LinuxSocketAddress): number;
  /** Never blocks: null when no datagram waits. */
  receiveNow(fd: number, max: number): Datagram | null;
  /** Blocks this worker for `ms` milliseconds (the poll interval of the synchronous resolver and of timed reads). */
  sleep(ms: number): void;
  readFile(path: string, max: number): Uint8Array | null;
}

/** Both halves, for one module process. */
export interface NetPorts {
  readonly sockets: NetSockets;
  readonly sync: NetSyncSockets;
  /** The engine's TLS module, compiled once per module frame; null when the process was started without it. */
  readonly tls: WebAssembly.Module | null;
}
