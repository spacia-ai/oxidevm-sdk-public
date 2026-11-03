import { TLS_API_VERSION } from "../../runtime/tls-abi.js";
import { NetError, type NetErrorCode } from "./errors.js";
import { trustChunks } from "./tls-trust.js";

/**
 * The engine's sans-IO TLS client (engine ADR 0029, N-4 and N-7; `oxidevm_tls.wasm`, TLS API 2), one instance per module
 * process. It verifies every server against the trust store it is given, which is always the VM's own
 * `/etc/ssl/cert.pem`, plus any anchors one session adds (a program's CA file); nothing here can switch verification
 * off and the SDK bundles no CA data. Time and entropy come
 * from this worker (`Date.now`, `crypto.getRandomValues`). Every ABI answer is a count or id below 2^31, or 2^31 with a
 * failure code in its low byte.
 */
const FAILED = 0x8000_0000;
const SEED_BYTES = 64, OPEN_ENTROPY_BYTES = 32;
/** The most certificates read back from a server's chain. */
const MAX_PEER_CERTIFICATES = 16;
const PROTOCOL_VERSIONS: ReadonlyMap<number, TlsProtocolVersion> = new Map([[0x0303, "TLSv1.2"], [0x0304, "TLSv1.3"]]);

/** The engine's TLS failure codes (crates/oxidevm-tls/src/error.rs), never renumbered. */
export const TLS_FAILURES = {
  1: "invalid-argument", 2: "unknown-session", 3: "invalid-server-name", 4: "invalid-roots", 5: "entropy-unavailable", 6: "too-many-sessions",
  7: "unknown-issuer", 8: "name-mismatch", 9: "certificate-expired", 10: "certificate-not-yet-valid", 11: "bad-certificate", 12: "alert-received",
  13: "peer-incompatible", 14: "peer-misbehaved", 15: "malformed-record", 16: "decrypt-failure", 17: "closed", 18: "protocol",
} as const;
export type TlsFailure = (typeof TLS_FAILURES)[keyof typeof TLS_FAILURES];

const FAILURE_CODES: Readonly<Partial<Record<TlsFailure, NetErrorCode>>> = {
  "unknown-issuer": "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "name-mismatch": "ERR_TLS_CERT_ALTNAME_INVALID", "certificate-expired": "CERT_HAS_EXPIRED",
  "certificate-not-yet-valid": "CERT_NOT_YET_VALID", "bad-certificate": "ERR_TLS_CERT_INVALID", "alert-received": "ERR_TLS_HANDSHAKE", "peer-incompatible": "ERR_TLS_HANDSHAKE",
  "invalid-roots": "ERR_TLS_NO_TRUST_STORE",
};

const FAILURE_NAMES: ReadonlyMap<number, TlsFailure> = new Map(Object.entries(TLS_FAILURES).map(([code, name]) => [Number(code), name]));

function failureName(code: number): TlsFailure { return FAILURE_NAMES.get(code) ?? "protocol"; }

/** The `NetError` for a TLS failure; `tlsFailure` names the engine's reason exactly. */
export class TlsError extends NetError {
  readonly tlsFailure: TlsFailure;
  constructor(failure: TlsFailure, hostname?: string) {
    super(FAILURE_CODES[failure] ?? "ERR_TLS_PROTOCOL", `TLS ${hostname ?? ""}: ${failure.replaceAll("-", " ")}`.replace("  ", " "), { syscall: "tls", ...(hostname === undefined ? {} : { hostname }) });
    this.name = "TlsError"; this.tlsFailure = failure;
  }
}

export type TlsState = "handshaking" | "established" | "peer-closed" | "closed" | "failed";
const STATES: readonly TlsState[] = ["handshaking", "established", "peer-closed", "closed", "failed"];
/** A negotiated protocol version, named as Python's `SSLSocket.version()` and Node's `getProtocol()` name it. */
export type TlsProtocolVersion = "TLSv1.2" | "TLSv1.3";
export interface TlsStatus { readonly state: TlsState; readonly failure: TlsFailure | null; readonly version: "1.2" | "1.3" | null; readonly waiting: boolean }

type Exports = Readonly<Record<string, (...args: number[]) => number>>;

function functions(instance: WebAssembly.Instance): Exports {
  const table: Record<string, (...args: number[]) => number> = {};
  for (const [name, value] of Object.entries(instance.exports)) {
    if (typeof value !== "function" || !name.startsWith("oxidevm_tls_")) continue;
    table[name] = (...args: number[]): number => { const answer: unknown = Reflect.apply(value, undefined, args); return typeof answer === "number" ? answer >>> 0 : FAILED; };
  }
  return table;
}

export class TlsEngine {
  readonly #exports: Exports;
  readonly #memory: WebAssembly.Memory;
  readonly #capacity: number;

  /** Instantiates the module and loads the trust store (PEM). An empty or unparsable store is ERR_TLS_NO_TRUST_STORE. */
  constructor(module: WebAssembly.Module, roots: Uint8Array) {
    const instance = new WebAssembly.Instance(module, {}), memory = instance.exports["memory"];
    if (!(memory instanceof WebAssembly.Memory)) throw new NetError("ERR_TLS_PROTOCOL", "The TLS module exports no memory");
    this.#exports = functions(instance); this.#memory = memory;
    if (this.#call("oxidevm_tls_api_version") !== TLS_API_VERSION) throw new NetError("ERR_TLS_PROTOCOL", "The TLS module's API version is not this SDK's");
    this.#capacity = this.#call("oxidevm_tls_buffer_capacity");
    this.#entropy(SEED_BYTES);
    if (roots.length === 0) throw new TlsError("invalid-roots");
    for (let at = 0; at < roots.length; at += this.#capacity) {
      const chunk = roots.subarray(at, at + this.#capacity);
      this.#check(this.#call("oxidevm_tls_roots_append", this.#put(chunk)));
    }
    this.#check(this.#call("oxidevm_tls_roots_commit"));
  }

  #call(name: string, ...args: number[]): number {
    const call = this.#exports[name];
    if (call === undefined) throw new NetError("ERR_TLS_PROTOCOL", `The TLS module lacks ${name}`);
    return call(...args);
  }
  /** The exchange buffer; its address is read first, because the call can grow the memory and detach an older view. */
  #buffer(): Uint8Array { const address = this.#call("oxidevm_tls_buffer_ptr"); return new Uint8Array(this.#memory.buffer, address, this.#capacity); }
  #put(bytes: Uint8Array): number { this.#buffer().set(bytes); return bytes.length; }
  #take(count: number): Uint8Array { return this.#buffer().slice(0, count); }
  #check(answer: number, hostname?: string): number {
    if (answer >= FAILED) throw new TlsError(failureName(answer & 0xff), hostname);
    return answer;
  }
  #entropy(bytes: number): void { this.#check(this.#call("oxidevm_tls_entropy", this.#put(crypto.getRandomValues(new Uint8Array(bytes))))); }

  /** The most bytes one exchange moves. */
  get capacity(): number { return this.#capacity; }

  /**
   * Opens a client session for `name` (SNI and verification), offering `alpn` in order. `trust` (already decoded by
   * `decodeTrust`) adds anchors to this session's store only, an entry larger than the exchange buffer in chunks of whole
   * certificates (`trustChunks`); an entry the engine cannot use is ERR_TLS_INVALID_TRUST.
   */
  open(name: string, alpn: readonly string[], trust: readonly Uint8Array[] = []): TlsSession {
    const encoder = new TextEncoder(), host = encoder.encode(name), wire = alpn.flatMap(protocol => {
      const bytes = encoder.encode(protocol);
      if (bytes.length === 0 || bytes.length > 255) throw new NetError("ERR_TLS_PROTOCOL", "An ALPN protocol name must be 1-255 bytes");
      return [bytes.length, ...bytes];
    });
    if (host.length + wire.length > this.#capacity) throw new NetError("ERR_TLS_PROTOCOL", "The server name and ALPN list are too long");
    const chunks = trust.flatMap(entry => trustChunks(entry, this.#capacity));
    this.#entropy(OPEN_ENTROPY_BYTES);
    const seconds = Math.floor(Date.now() / 1000);
    this.#call("oxidevm_tls_clock", seconds >>> 0, Math.floor(seconds / 2 ** 32));
    // Staged last, right before the open that takes them: the engine drops every staged anchor when it refuses one.
    for (const anchors of chunks) {
      if (this.#call("oxidevm_tls_anchors_append", this.#put(anchors)) >= FAILED) throw new NetError("ERR_TLS_INVALID_TRUST", "TLS: a trust entry holds no usable CA certificate", { syscall: "tls", hostname: name });
    }
    const request = new Uint8Array(host.length + wire.length);
    request.set(host); request.set(wire, host.length); this.#put(request);
    const id = this.#check(this.#call("oxidevm_tls_open", host.length, wire.length), name);
    return new TlsSession({
      receive: bytes => this.#check(this.#call("oxidevm_tls_receive", id, this.#put(bytes)), name),
      send: bytes => this.#check(this.#call("oxidevm_tls_send", id, this.#put(bytes)), name),
      takeTls: () => this.#take(this.#check(this.#call("oxidevm_tls_take_tls", id, this.#capacity), name)),
      takePlaintext: max => this.#take(this.#check(this.#call("oxidevm_tls_take_plaintext", id, Math.min(max, this.#capacity)), name)),
      status: () => this.#check(this.#call("oxidevm_tls_status", id), name),
      alpn: () => this.#take(this.#check(this.#call("oxidevm_tls_alpn", id), name)),
      peerCertificate: index => this.#take(this.#check(this.#call("oxidevm_tls_peer_certificate", id, index), name)),
      cipherSuite: () => this.#check(this.#call("oxidevm_tls_cipher_suite", id), name),
      protocolVersion: () => this.#check(this.#call("oxidevm_tls_protocol_version", id), name),
      close: () => { this.#check(this.#call("oxidevm_tls_close", id), name); },
      free: () => { this.#call("oxidevm_tls_free", id); },
    }, this.#capacity, name);
  }
}

interface SessionCalls {
  receive(bytes: Uint8Array): number; send(bytes: Uint8Array): number; takeTls(): Uint8Array; takePlaintext(max: number): Uint8Array;
  status(): number; alpn(): Uint8Array; peerCertificate(index: number): Uint8Array; cipherSuite(): number; protocolVersion(): number;
  close(): void; free(): void;
}

/** One TLS session: ciphertext in and out for the socket, plaintext in and out for the caller. Pure computation. */
export class TlsSession {
  readonly #calls: SessionCalls;
  readonly #capacity: number;
  readonly hostname: string;
  #freed = false;
  constructor(calls: SessionCalls, capacity: number, hostname: string) { this.#calls = calls; this.#capacity = capacity; this.hostname = hostname; }

  status(): TlsStatus {
    const word = this.#calls.status(), state = STATES[word & 0xff] ?? "failed", failure = (word >> 8) & 0xff, version = (word >> 16) & 0x3;
    return { state, failure: state === "failed" ? failureName(failure) : null, version: version === 1 ? "1.2" : version === 2 ? "1.3" : null, waiting: (word & (1 << 18)) !== 0 };
  }
  /** Throws the session's failure, if it failed. */
  assertHealthy(): void { const status = this.status(); if (status.state === "failed") throw new TlsError(status.failure ?? "protocol", this.hostname); }
  /** Feeds ciphertext from the peer, all of it. */
  receive(bytes: Uint8Array): void {
    for (let at = 0; at < bytes.length;) {
      const accepted = this.#calls.receive(bytes.subarray(at, at + this.#capacity));
      if (accepted === 0) { this.assertHealthy(); throw new TlsError("protocol", this.hostname); }
      at += accepted;
    }
    this.assertHealthy();
  }
  /** The ciphertext waiting for the peer, all of it. */
  takeTls(): Uint8Array {
    const parts: Uint8Array[] = [];
    for (let chunk = this.#calls.takeTls(); chunk.length > 0; chunk = this.#calls.takeTls()) parts.push(chunk);
    return concat(parts);
  }
  /** Queues plaintext for the peer, all of it. */
  send(bytes: Uint8Array): void {
    for (let at = 0; at < bytes.length;) {
      const accepted = this.#calls.send(bytes.subarray(at, at + this.#capacity));
      if (accepted === 0) { this.assertHealthy(); throw new TlsError("closed", this.hostname); }
      at += accepted;
    }
  }
  takePlaintext(max: number): Uint8Array { return this.#calls.takePlaintext(max); }
  alpn(): string | null { const bytes = this.#calls.alpn(); return bytes.length === 0 ? null : new TextDecoder().decode(bytes); }
  /** The server's certificate chain in DER, leaf first (at most 16); empty before the server sent it. */
  peerCertificates(): Uint8Array[] {
    const chain: Uint8Array[] = [];
    for (let certificate = this.#calls.peerCertificate(0); certificate.length > 0 && chain.length < MAX_PEER_CERTIFICATES; certificate = this.#calls.peerCertificate(chain.length)) chain.push(certificate);
    return chain;
  }
  /** The negotiated cipher suite's IANA id (0x1301 is TLS_AES_128_GCM_SHA256), or null before one is negotiated. */
  cipherSuite(): number | null { const id = this.#calls.cipherSuite(); return id === 0 || id > 0xffff ? null : id; }
  /** The negotiated protocol version, or null before one is negotiated. */
  protocolVersion(): TlsProtocolVersion | null { return PROTOCOL_VERSIONS.get(this.#calls.protocolVersion()) ?? null; }
  /** Queues close_notify; the caller sends `takeTls()` afterwards. */
  close(): void { try { this.#calls.close(); } catch { /* already closed or failed */ } }
  free(): void { if (this.#freed) return; this.#freed = true; this.#calls.free(); }
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1 && parts[0] !== undefined) return parts[0];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
