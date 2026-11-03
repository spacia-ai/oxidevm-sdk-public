import { VMError } from "../../runtime/errors.js";
import type { NetHost, NetSyncConnection } from "../capabilities.js";
import { NetError } from "../net/errors.js";
import { emscriptenErrno } from "./errno.js";

/**
 * Connects an Emscripten program's own network layer to the module's VM network (engine ADR 0029, N-4), so its standard
 * library (`socket`, `connect`, `send`, `recv`, `getaddrinfo`) works unchanged:
 * - SOCKFS stream sockets become blocking connections through `host.net.connectSync`, on the module process's own VM
 *   sockets, so they follow the module's reach and the VM's policy;
 * - `getaddrinfo` (Emscripten's `DNS.lookup_name`) answers with the VM resolver's real IPv4 addresses instead of
 *   made-up ones; with `networkImports` applied to the program's imports before it was instantiated, a name that does
 *   not resolve fails with EAI_NONAME or EAI_AGAIN, as a C library reports it;
 * - a socket's receive timeout (`receiveTimeout`, the SO_RCVTIMEO an interpreter's socket timeout sets) bounds each
 *   recv, which then fails with EAGAIN;
 * - failures reach the program as the errno its C library expects (EPERM local-only, EACCES beyond the reach,
 *   ECONNRESET after a revoke).
 * The program's `Module` must export `SOCKFS`, `DNS` and `FS` (Emscripten's `EXPORTED_RUNTIME_METHODS`). Listening
 * sockets are refused with EOPNOTSUPP: nothing on the internet connects in (N-8); services use `expose`.
 * `poll` reports a connected socket readable and writable; a read then blocks until bytes or the end of stream arrive.
 */
const UNRESOLVED = "0.0.0.0", SOCK_STREAM = 1, POLLIN = 0x1, POLLOUT = 0x4, POLLHUP = 0x10;
const LINUX = { EIO: 5, EBADF: 9, EINVAL: 22, ENOTCONN: 107, EOPNOTSUPP: 95, EISCONN: 106 } as const;
const CODE_ERRNO: Readonly<Record<string, number>> = {
  EPERM: 1, EACCES: 13, EPIPE: 32, ENETUNREACH: 101, ECONNABORTED: 103, ECONNRESET: 104, ETIMEDOUT: 110, ECONNREFUSED: 111, EHOSTUNREACH: 113,
  ENOTFOUND: 113, EAI_AGAIN: 113,
};

interface SocketState { connection: NetSyncConnection | null; address: string; port: number; ended: boolean }

/** What `kit.emscripten.network` returns: per-socket settings the program's own C library cannot pass through. */
export interface EmscriptenNetwork {
  /**
   * Sets the receive timeout of the socket on descriptor `fd` (SO_RCVTIMEO), in whole milliseconds from 1 to
   * 86,400,000, or null to block again: a recv that waits longer fails with EAGAIN. Closing the socket clears it.
   */
  receiveTimeout(fd: number, ms: number | null): void;
}

/** getaddrinfo's answers (musl's numbering, which Emscripten's libc uses). */
const EAI_NONAME = -2, EAI_AGAIN = -3, MAX_RECEIVE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** The resolver's verdicts that mean the name has no address; any other failure means it could not be looked up. */
const NO_SUCH_NAME: ReadonlySet<string> = new Set(["ENOTFOUND", "ENODATA"]);

/** Thrown by a lookup inside a wrapped getaddrinfo, and caught by that wrapper before any address is allocated. */
class LookupFailure extends Error {
  constructor(readonly answer: number) { super(`getaddrinfo failed with ${String(answer)}`); this.name = "LookupFailure"; }
}

/**
 * How many wrapped getaddrinfo calls are running. A lookup can only fail through its getaddrinfo when that call is
 * wrapped; Emscripten calls `DNS.lookup_name` synchronously inside it, so this count is the whole channel between the
 * two and never outlives one call.
 */
let wrappedCalls = 0;
const wrappers = new WeakSet<object>();

/**
 * Prepares an Emscripten program's WebAssembly imports, before it is instantiated (in `Module.instantiateWasm`, or where
 * the adapter instantiates it), so that its `getaddrinfo` reports a name the VM cannot resolve: EAI_NONAME for a name
 * with no IPv4 address, EAI_AGAIN when the lookup could not be made (offline, a silent nameserver, beyond the reach).
 * Emscripten's own `getaddrinfo` cannot fail through `DNS.lookup_name`, and an exception there would abort the program,
 * so without this the name gets the unspecified address and connecting to it fails instead. Imports without
 * `env.getaddrinfo` are left as they are; applying it twice changes nothing.
 */
export function emscriptenNetworkImports(imports: object): void {
  const env: unknown = Reflect.get(imports, "env");
  if (typeof env !== "object" || env === null) return;
  const original: unknown = Reflect.get(env, "getaddrinfo");
  if (typeof original !== "function" || wrappers.has(original)) return;
  const wrapper = (...args: unknown[]): unknown => {
    wrappedCalls++;
    try { const answer: unknown = Reflect.apply(original, undefined, args); return answer; }
    catch (error: unknown) { if (error instanceof LookupFailure) return error.answer; throw error; }
    finally { wrappedCalls--; }
  };
  // Emscripten's dynamic linker reads a JS library function's signature from `sig`.
  const signature: unknown = Reflect.get(original, "sig");
  if (signature !== undefined) Reflect.set(wrapper, "sig", signature);
  wrappers.add(wrapper);
  Reflect.set(env, "getaddrinfo", wrapper);
}

function addrinfoError(error: unknown): number {
  return error instanceof NetError && NO_SUCH_NAME.has(error.code) ? EAI_NONAME : EAI_AGAIN;
}

function objectAt(value: unknown, key: string): object {
  const member: unknown = typeof value === "object" && value !== null || typeof value === "function" ? Reflect.get(value, key) : undefined;
  if (typeof member !== "object" || member === null) throw new TypeError(`kit.emscripten.network needs Module.${key}: export SOCKFS, DNS and FS with EXPORTED_RUNTIME_METHODS`);
  return member;
}

/** The Linux errno a network failure carries, or the closest one. */
export function linuxErrnoOf(error: unknown): number {
  if (error instanceof NetError) return error.errno ?? CODE_ERRNO[error.code] ?? LINUX.EIO;
  return LINUX.EIO;
}

export function emscriptenNetwork(host: { readonly net: NetHost }, Module: unknown): EmscriptenNetwork {
  const { net } = host, SOCKFS = objectAt(Module, "SOCKFS"), DNS = objectAt(Module, "DNS"), FS = objectAt(Module, "FS");
  const ErrnoError: unknown = Reflect.get(FS, "ErrnoError");
  if (typeof ErrnoError !== "function") throw new TypeError("kit.emscripten.network needs Module.FS.ErrnoError");
  const fail = (linux: number): never => { const error: unknown = Reflect.construct(ErrnoError, [emscriptenErrno(linux)]); throw error; };
  const states = new WeakMap<object, SocketState>(), timeouts = new Map<number, number>();
  const descriptorOf = (sock: unknown): number | undefined => {
    const stream: unknown = Reflect.get(Object(sock), "stream"), fd: unknown = typeof stream === "object" && stream !== null ? Reflect.get(stream, "fd") : undefined;
    return typeof fd === "number" ? fd : undefined;
  };
  let unresolved: number = CODE_ERRNO["EHOSTUNREACH"] ?? LINUX.EIO;
  const state = (sock: unknown): SocketState => {
    if (typeof sock !== "object" || sock === null) return fail(LINUX.EBADF);
    let found = states.get(sock);
    if (found === undefined) { found = { connection: null, address: "", port: 0, ended: false }; states.set(sock, found); }
    return found;
  };
  const connected = (sock: unknown): NetSyncConnection => state(sock).connection ?? fail(LINUX.ENOTCONN);
  const guarded = <T>(work: () => T): T => { try { return work(); } catch (error: unknown) { if (error instanceof NetError) fail(linuxErrnoOf(error)); throw error; } };
  const ops = {
    poll: (sock: unknown): number => { const current = state(sock); return current.connection === null ? 0 : current.ended ? POLLIN | POLLHUP : POLLIN | POLLOUT; },
    ioctl: (): number => 0,
    close: (sock: unknown): number => {
      const current = state(sock), fd = descriptorOf(sock);
      current.connection?.close(); current.connection = null;
      if (fd !== undefined) timeouts.delete(fd);
      return 0;
    },
    bind: (): never => fail(LINUX.EOPNOTSUPP),
    listen: (): never => fail(LINUX.EOPNOTSUPP),
    accept: (): never => fail(LINUX.EOPNOTSUPP),
    connect: (sock: unknown, addr: unknown, port: unknown): void => {
      if (Reflect.get(Object(sock), "type") !== SOCK_STREAM) fail(LINUX.EOPNOTSUPP);
      const current = state(sock);
      if (current.connection !== null) fail(LINUX.EISCONN);
      if (typeof addr !== "string" || typeof port !== "number") fail(LINUX.EINVAL);
      if (addr === UNRESOLVED) fail(unresolved);
      current.connection = guarded(() => net.connectSync({ host: String(addr), port: Number(port) }));
      current.address = String(addr); current.port = Number(port);
      Reflect.set(Object(sock), "daddr", addr); Reflect.set(Object(sock), "dport", port);
    },
    getname: (sock: unknown, peer: unknown): { readonly addr: string; readonly port: number } => {
      const current = state(sock);
      return peer === true ? { addr: current.address, port: current.port } : { addr: "0.0.0.0", port: 0 };
    },
    sendmsg: (sock: unknown, buffer: unknown, offset: unknown, length: unknown): number => {
      if (!(buffer instanceof Uint8Array) && !(buffer instanceof Int8Array) || typeof offset !== "number" || typeof length !== "number") return fail(LINUX.EINVAL);
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length).slice(), connection = connected(sock);
      guarded(() => { connection.write(bytes); });
      return length;
    },
    recvmsg: (sock: unknown, length: unknown): { readonly buffer: Uint8Array; readonly addr: string; readonly port: number } | null => {
      if (typeof length !== "number") return fail(LINUX.EINVAL);
      const current = state(sock), connection = connected(sock), fd = descriptorOf(sock), timeoutMs = fd === undefined ? undefined : timeouts.get(fd);
      const bytes = guarded(() => connection.read(length, timeoutMs === undefined ? undefined : { timeoutMs }));
      if (bytes.length === 0) { current.ended = true; return null; }
      return { buffer: bytes, addr: current.address, port: current.port };
    },
  };
  Reflect.set(SOCKFS, "websocket_sock_ops", ops);
  // Emscripten's getaddrinfo cannot fail through lookup_name: an exception there would abort the program. Inside a
  // getaddrinfo that `emscriptenNetworkImports` wrapped, the failure goes to the wrapper, which returns the EAI code;
  // anywhere else a name that does not resolve gets the unspecified address, and connecting to it says why it failed.
  const lookup = (name: unknown): string => {
    if (typeof name !== "string") return UNRESOLVED;
    try {
      // Emscripten's getaddrinfo takes IPv4 text; a name with only IPv6 addresses cannot be returned to it.
      const ipv4 = net.resolveSync(name).find(address => !address.includes(":"));
      if (ipv4 !== undefined) return ipv4;
      if (wrappedCalls > 0) throw new LookupFailure(EAI_NONAME);
      unresolved = CODE_ERRNO["EHOSTUNREACH"] ?? LINUX.EIO;
    } catch (error: unknown) {
      if (error instanceof LookupFailure) throw error;
      if (wrappedCalls > 0) throw new LookupFailure(addrinfoError(error));
      unresolved = linuxErrnoOf(error);
    }
    return UNRESOLVED;
  };
  Reflect.set(DNS, "lookup_name", lookup);
  Reflect.set(DNS, "lookup_addr", () => null);
  return Object.freeze({
    receiveTimeout: (fd: number, ms: number | null): void => {
      if (!Number.isSafeInteger(fd) || fd < 0) throw new VMError("INVALID_ARGUMENT", "a receive timeout needs the socket's descriptor", { reason: "net-read-timeout" });
      if (ms === null) { timeouts.delete(fd); return; }
      if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_RECEIVE_TIMEOUT_MS) throw new VMError("INVALID_ARGUMENT", `a receive timeout must be a whole number of milliseconds from 1 to ${String(MAX_RECEIVE_TIMEOUT_MS)}`, { reason: "net-read-timeout" });
      timeouts.set(fd, ms);
    },
  });
}
