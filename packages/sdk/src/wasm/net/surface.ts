import type { NetConnection, NetConnectOptions, NetHost, NetReadOptions, NetSyncConnection, NetTlsOptions } from "../capabilities.js";
import type { ModuleReach } from "../reach.js";
import type { LinuxSocketAddress } from "../../js-process-types.js";
import { LinuxError } from "../../runtime/js-process/codec.js";
import { VMError } from "../../runtime/errors.js";
import { notDeclared } from "./errors.js";
import { createFetch } from "./fetch.js";
import { ConnectionPool } from "./pool.js";
import type { NetPorts } from "./ports.js";
import { resolve, resolveSync } from "./resolver.js";
import { dial, dialSync, dialUnixSync, engineTls, type ByteStream, type TlsLayer } from "./streams.js";
import { decodeTrust } from "./tls-trust.js";
import { createWebSocket } from "./websocket.js";

/**
 * One module process's network (engine ADR 0029, N-1 and N-3): `host.net` and the `fetch` and `WebSocket` globals,
 * all on the process's own VM sockets. A module with reach `none` gets no `host.net`, and its `fetch` and `WebSocket`
 * fail with "network not declared"; the browser's other network APIs are removed from the worker either way.
 */
export interface ModuleNetwork {
  /** `host.net`; undefined for reach `none`. */
  readonly host: NetHost | undefined;
  readonly fetch: typeof fetch;
  readonly WebSocket: unknown;
  /** Closes idle keep-alive connections; open ones end with the module's lifecycle signal. */
  close(): void;
}

export interface ModuleNetworkInputs {
  readonly ports: NetPorts;
  readonly reach: ModuleReach;
  /** The module's lifecycle (`host.signal`). */
  readonly signal: AbortSignal;
  /** TLS; the engine's client on the process's compiled TLS module unless a test host supplies another. */
  readonly tls?: TlsLayer;
  /** The worker's own `fetch`, kept for `blob:` URLs. */
  readonly local?: typeof fetch;
  /** Told about each connection or datagram Rust refused as beyond the module's reach (`wasm test` network-declared). */
  readonly refused?: (destination: ReachRefusal) => void;
}

/** A destination Rust refused with EACCES as beyond the module's declared reach. */
export interface ReachRefusal { readonly address: string; readonly port: number; readonly protocol: "tcp" | "udp" }

const EACCES = 13;

/** The ports with every refusal beyond the reach reported; the refusal itself still reaches the caller. */
function reporting(ports: NetPorts, refused: ((destination: ReachRefusal) => void) | undefined): NetPorts {
  if (refused === undefined) return ports;
  const report = (error: unknown, address: LinuxSocketAddress, protocol: "tcp" | "udp"): void => {
    if (error instanceof LinuxError && error.errno === EACCES && address.family !== "unix") refused({ address: address.address, port: address.port, protocol });
  };
  const { sockets, sync } = ports;
  return {
    tls: ports.tls,
    sockets: {
      ...sockets,
      connect: async (fd, address, signal) => { try { await sockets.connect(fd, address, signal); } catch (error: unknown) { report(error, address, "tcp"); throw error; } },
      sendTo: async (fd, bytes, address) => { try { return await sockets.sendTo(fd, bytes, address); } catch (error: unknown) { report(error, address, "udp"); throw error; } },
    },
    sync: {
      ...sync,
      connect: (fd, address) => { try { sync.connect(fd, address); } catch (error: unknown) { report(error, address, "tcp"); throw error; } },
      sendTo: (fd, bytes, address) => { try { return sync.sendTo(fd, bytes, address); } catch (error: unknown) { report(error, address, "udp"); throw error; } },
    },
  };
}

const READ_BYTES = 64 * 1024;
/** sun_path holds 108 bytes, the terminating NUL included. */
const MAX_UNIX_PATH_BYTES = 107;

/** A filesystem Unix socket path: non-empty, without NUL, at most 107 bytes. Abstract names are not admitted. */
function unixPath(path: unknown): string {
  if (typeof path !== "string" || path === "" || path.includes("\0") || new TextEncoder().encode(path).byteLength > MAX_UNIX_PATH_BYTES) {
    throw new VMError("INVALID_ARGUMENT", `a Unix socket path must be 1 to ${String(MAX_UNIX_PATH_BYTES)} bytes without NUL`, { reason: "net-unix-path" });
  }
  return path;
}

function connection(stream: ByteStream): NetConnection {
  return {
    alpn: stream.alpn,
    readable: new ReadableStream<Uint8Array>({
      pull: async controller => { const bytes = await stream.read(READ_BYTES); if (bytes.length === 0) controller.close(); else controller.enqueue(bytes); },
      cancel: async () => { await stream.close(); },
    }, { highWaterMark: 0 }),
    writable: new WritableStream<Uint8Array>({
      write: async chunk => { await stream.write(chunk); },
      close: async () => { await stream.closeWrite(); },
      abort: async () => { await stream.close(); },
    }),
    close: () => stream.close(),
  };
}

/** The longest a blocking read may be told to wait: one day. */
const MAX_READ_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function readTimeout(options: NetReadOptions | undefined): number | undefined {
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs === undefined) return undefined;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_READ_TIMEOUT_MS) throw new VMError("INVALID_ARGUMENT", `a read timeout must be a whole number of milliseconds from 0 to ${String(MAX_READ_TIMEOUT_MS)}`, { reason: "net-read-timeout" });
  return timeoutMs;
}

function syncConnection(stream: ReturnType<typeof dialSync>): NetSyncConnection {
  return Object.freeze({
    alpn: stream.alpn,
    read: (max: number, options?: NetReadOptions) => stream.read(max, readTimeout(options)),
    write: (bytes: Uint8Array) => { stream.write(bytes); },
    closeWrite: () => { stream.closeWrite(); },
    close: () => { stream.close(); },
  });
}

/** The browser network APIs that must not exist in a module worker (ADR 0029, N-3). */
export const BROWSER_NETWORK_GLOBALS = ["XMLHttpRequest", "EventSource", "WebTransport", "RTCPeerConnection", "RTCDataChannel"] as const;

export function createModuleNetwork(inputs: ModuleNetworkInputs): ModuleNetwork {
  const { reach, signal } = inputs, ports = reporting(inputs.ports, inputs.refused);
  if (reach === "none") {
    const refuse = (): Promise<never> => Promise.reject(notDeclared());
    const Undeclared = function WebSocket(): never { throw notDeclared(); };
    return { host: undefined, fetch: refuse, WebSocket: Undeclared, close: () => undefined };
  }
  const tls = inputs.tls ?? engineTls(ports.tls, ports.sockets, ports.sync), pool = new ConnectionPool();
  signal.addEventListener("abort", () => { pool.close(); }, { once: true });
  const connectOptions = (options: NetConnectOptions | Omit<NetConnectOptions, "signal">) => ({
    host: options.host, port: options.port, ...(options.tls === undefined ? {} : { tls: options.tls }), ...(options.alpn === undefined ? {} : { alpn: options.alpn }),
  });
  const host: NetHost = Object.freeze({
    resolve: (name: string, options?: { readonly signal?: AbortSignal }) => resolve(ports.sockets, reach, name, options?.signal === undefined ? signal : AbortSignal.any([options.signal, signal])),
    connect: async (options: NetConnectOptions) => connection(await dial(ports.sockets, reach, tls, { ...connectOptions(options), signal: options.signal === undefined ? signal : AbortSignal.any([options.signal, signal]) })),
    resolveSync: (name: string) => resolveSync(ports.sync, reach, name),
    connectSync: (options: Omit<NetConnectOptions, "signal">) => syncConnection(dialSync(ports.sync, reach, tls, connectOptions(options))),
    connectUnixSync: (path: string) => syncConnection(dialUnixSync(ports.sync, unixPath(path))),
    tls: (options: NetTlsOptions) => tls.session(options.serverName, options.alpn ?? [], decodeTrust(options.trust)),
  });
  return {
    host,
    fetch: createFetch({ sockets: ports.sockets, reach, tls, pool, signal, ...(inputs.local === undefined ? {} : { local: inputs.local }) }),
    WebSocket: createWebSocket({ sockets: ports.sockets, reach, tls, signal }),
    close: () => { pool.close(); },
  };
}

/**
 * Whether `target` names something that would come over the network: a `blob:` or `data:` URL carries its bytes itself,
 * and a policy violation reports a `data:` URL as just "data".
 */
export function isNetworkTarget(target: string): boolean {
  return !/^(?:blob|data)(?::|$)/iu.test(target);
}

/**
 * Puts the module network into a worker's global scope: `fetch` and `WebSocket` become the module network's, and the
 * browser's other network APIs are removed. `Request`, `Response` and `Headers` stay the browser's own classes.
 */
export function installNetworkGlobals(scope: object, network: ModuleNetwork, direct?: (attempt: DirectAttempt) => void): void {
  for (const name of BROWSER_NETWORK_GLOBALS) Reflect.deleteProperty(scope, name);
  Reflect.set(scope, "fetch", network.fetch);
  Reflect.set(scope, "WebSocket", network.WebSocket);
  if (direct === undefined) return;
  // What remains of the browser's network is refused by the module frame's policy (connect-src blob:); each refusal,
  // and each importScripts of anything but a blob or data: URL, is reported (`wasm test` network-direct, N-3). A data:
  // URL loads nothing over the network, so its refusal is the frame's script policy, not a network use.
  const listen: unknown = Reflect.get(scope, "addEventListener");
  if (typeof listen === "function") Reflect.apply(listen, scope, ["securitypolicyviolation", (event: unknown) => {
    const blocked: unknown = typeof event === "object" && event !== null ? Reflect.get(event, "blockedURI") : undefined, directive: unknown = typeof event === "object" && event !== null ? Reflect.get(event, "effectiveDirective") : undefined;
    const target = typeof blocked === "string" ? blocked.slice(0, 256) : "";
    if (isNetworkTarget(target)) direct({ api: typeof directive === "string" ? directive : "unknown", target });
  }]);
  const load: unknown = Reflect.get(scope, "importScripts");
  if (typeof load === "function") Reflect.set(scope, "importScripts", (...urls: unknown[]) => {
    for (const url of urls) if (isNetworkTarget(String(url))) direct({ api: "importScripts", target: String(url).slice(0, 256) });
    Reflect.apply(load, scope, urls);
  });
}

/** A module's attempt to use the browser's own network. */
export interface DirectAttempt { readonly api: string; readonly target: string }
