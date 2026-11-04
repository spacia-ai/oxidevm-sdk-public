import type { ClockHost, LinuxAtFiles, LinuxFiles, LinuxProcesses, LinuxSockets, LinuxSyncFiles, ProcessSync, RandomHost } from "../js-process-types.js";
import type { LinuxSignal, RealtimeSignalName, RealtimeSignalNumber, SignalName } from "../runtime/process-signals.js";

/** Client-side socket operations. Listening belongs to the runner and is declared by `expose`. */
export type ClientSockets = Pick<LinuxSockets, "socket" | "connect" | "address" | "read" | "write" | "close" | "shutdown">;

/** The standard signals a module can trap (engine ADR 0027). SIGKILL and SIGSTOP can never be caught. */
export type TrappableSignal = "SIGHUP" | "SIGINT" | "SIGQUIT" | "SIGTERM" | "SIGUSR1" | "SIGUSR2";
/** A signal `trap` takes: a standard trappable signal, or a real-time signal by name or by number (35 to 64). */
export type TrapSignal = TrappableSignal | RealtimeSignalName | RealtimeSignalNumber;

/** A real-time signal as it arrived, with the details its sender queued (si_value, si_code, si_pid and si_uid). */
export interface RealtimeArrival {
  readonly signal: RealtimeSignalNumber;
  /** sigqueue's value; 0n for kill or when the signal arrived past the process's queue limit. */
  readonly value: bigint;
  /** si_code: SI_USER (0) for kill, SI_QUEUE (-1) for sigqueue. */
  readonly code: number;
  /** The sender's pid and uid; 0 when unknown. */
  readonly pid: number;
  readonly uid: number;
}
/** What a trap of `S` yields: a standard signal's name, or a real-time arrival. */
export type TrapArrival<S extends TrapSignal> = S extends TrappableSignal ? S : RealtimeArrival;
/** How a trap lists `S`: standard signals by name, real-time ones by number. */
export type TrappedSignal<S extends TrapSignal> = S extends TrappableSignal ? S : RealtimeSignalNumber;

/**
 * The signals a module trapped: each reaches the module through this iterator instead of its default action. A
 * standard signal that arrives again before the module has seen it is delivered once; real-time arrivals queue in
 * order, each with its details.
 */
export interface SignalTrap<S extends TrapSignal = TrappableSignal> extends AsyncIterable<TrapArrival<S>> {
  readonly signals: readonly TrappedSignal<S>[];
  /**
   * Pyodide interrupt-buffer format: the runtime writes the signal number into [0] at delivery, only while [0] reads 0,
   * and the reader resets it. Take it with one `Atomics.exchange(buffer, 0, 0)`: a plain read followed by a store of 0
   * loses a signal written between the two, and nothing retries it. (Pyodide's own poll does exactly that, so a Pyodide
   * adapter replaces it with an atomic take.)
   */
  readonly interruptBuffer: Int32Array;
  untrap(): Promise<void>;
}

/** This process's signals: a signal that is not trapped keeps its default action. */
export interface ProcessSignals {
  trap<const S extends readonly TrapSignal[]>(signals: S): Promise<SignalTrap<S[number]>>;
  /**
   * kill(getpid(), signal), as raise(3): a trapped signal reaches its trap, a blocked one stays pending, an ignored one
   * does nothing, and any other ends this process killed by it, in which case the promise never settles.
   */
  raise(signal: TrapSignal): Promise<void>;
  /** Blocks the signals (rt_sigprocmask SIG_BLOCK) and resolves with the previous mask; a blocked signal stays pending. */
  block(signals: readonly BlockableSignal[]): Promise<ReadonlySet<SignalName>>;
  /** Unblocks the signals and resolves with the previous mask; a pending one is delivered once. */
  unblock(signals: readonly BlockableSignal[]): Promise<ReadonlySet<SignalName>>;
  /** The signals that arrived while blocked and wait (rt_sigpending). */
  pending(): Promise<ReadonlySet<SignalName>>;
}

/** A signal a module may block: any named signal but SIGKILL and SIGSTOP, which can never be blocked. */
export type BlockableSignal = Exclude<LinuxSignal, "SIGKILL" | "SIGSTOP"> | RealtimeSignalName | RealtimeSignalNumber;

/** What `host.net.connect` opens: a TCP connection, end-to-end TLS when asked (verified against the VM's trust store). */
export interface NetConnectOptions {
  /** A DNS name or a numeric address. */
  readonly host: string;
  readonly port: number;
  /** TLS to `host`, verified against the VM's `/etc/ssl/cert.pem`; verification cannot be switched off. */
  readonly tls?: boolean;
  /** ALPN protocols to offer, in order of preference. */
  readonly alpn?: readonly string[];
  readonly signal?: AbortSignal;
}
/** An open connection on the module process's own VM socket. */
export interface NetConnection {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  /** The protocol TLS negotiated, or null. */
  readonly alpn: string | null;
  close(): Promise<void>;
}
/** How long a blocking read may wait. */
export interface NetReadOptions {
  /**
   * The longest the read waits for bytes from the peer, in whole milliseconds (0 to 86,400,000; 0 only takes what has
   * arrived). A read that waits longer fails with a `NetError` whose `code` is `ETIMEDOUT` and whose `errno` is 11,
   * EAGAIN, as Linux reports a receive timeout (SO_RCVTIMEO). Without it the read waits until bytes or the end arrive.
   */
  readonly timeoutMs?: number;
}
/** A connection opened synchronously, for interpreters whose sockets block (Emscripten's SOCKFS, `kit.emscripten.network`). */
export interface NetSyncConnection {
  /** Blocks until bytes arrive, or until `timeoutMs` passes; an empty answer is the peer's end of stream. */
  read(max: number, options?: NetReadOptions): Uint8Array;
  /** Writes every byte. */
  write(bytes: Uint8Array): void;
  /** Ends this side's writing; reading continues. */
  closeWrite(): void;
  close(): void;
  readonly alpn: string | null;
}
/**
 * A sans-IO TLS client session (engine ADR 0029, N-4): the engine's TLS client, verified against the VM's
 * `/etc/ssl/cert.pem`, for a program that moves the bytes itself (Pyodide's `ssl`). Ciphertext goes to and comes from
 * the peer through the caller's own connection; nothing here touches the network.
 */
export interface NetTlsSession {
  /** Feeds ciphertext from the peer; a verification or protocol failure throws the typed TLS error. */
  receive(ciphertext: Uint8Array): void;
  /** The ciphertext waiting for the peer, all of it (empty when none). */
  takeTls(): Uint8Array;
  /** Queues plaintext for the peer. */
  send(plaintext: Uint8Array): void;
  /** Up to `max` bytes of plaintext from the peer (empty when none waits). */
  takePlaintext(max: number): Uint8Array;
  state(): "handshaking" | "established" | "peer-closed" | "closed" | "failed";
  /** The negotiated ALPN protocol, or null. */
  alpn(): string | null;
  /** The server's certificate chain in DER, leaf first (at most 16); empty before the handshake verified it. */
  peerCertificates(): Uint8Array[];
  /** The negotiated protocol version, or null before the handshake. */
  protocolVersion(): "TLSv1.2" | "TLSv1.3" | null;
  /** The negotiated cipher suite's IANA id (0x1301 is TLS_AES_128_GCM_SHA256), or null before the handshake. */
  cipherSuite(): number | null;
  /** Queues close_notify; send `takeTls()` afterwards. */
  close(): void;
  /** Releases the session. */
  free(): void;
}
/** A sans-IO TLS session's options. */
export interface NetTlsOptions {
  readonly serverName: string;
  readonly alpn?: readonly string[];
  /**
   * Extra trust anchors for this session only, each a PEM bundle or one DER certificate (a program's CA file, such as
   * certifi's full root bundle; at most 512 certificates in all and 2 MiB). They add to the VM's `/etc/ssl/cert.pem` and
   * never turn verification off. An entry that is not a usable CA certificate fails with ERR_TLS_INVALID_TRUST.
   */
  readonly trust?: readonly Uint8Array[];
}
/**
 * `host.net` of a module with a network reach (engine ADR 0029): names through the VM's resolver and connections on the
 * module process's own VM sockets, which Rust holds to the declared reach. A failure is a `NetError` (`code`, and `reason`
 * where the VM decided: `vm-local-only`, `module-network-reach`; a revoke resets connections with ECONNRESET). The synchronous variants block
 * the module's worker, for interpreters that cannot await.
 */
export interface NetHost {
  resolve(name: string, options?: { readonly signal?: AbortSignal }): Promise<readonly string[]>;
  connect(options: NetConnectOptions): Promise<NetConnection>;
  resolveSync(name: string): readonly string[];
  connectSync(options: Omit<NetConnectOptions, "signal">): NetSyncConnection;
  /**
   * Connects to the Unix-domain stream socket at `path` in the VM (a filesystem path of 1 to 107 bytes, no abstract
   * names), synchronously; Rust holds it to the module's reach as it does TCP (Userspace API 147).
   */
  connectUnixSync(path: string): NetSyncConnection;
  /** A sans-IO TLS session for `serverName` (`kit.tls.session`). */
  tls(options: NetTlsOptions): NetTlsSession;
}

/**
 * Host operations an adapter may be granted. A manifest names them in `requires.host`;
 * the adapter's `host` type contains exactly the members of the named capabilities, and the
 * runner hands over nothing else.
 */
export interface CapabilityMap {
  readonly "files.sync": { readonly fs: LinuxSyncFiles };
  readonly "files.async": { readonly files: LinuxFiles };
  /** Descriptor-relative, positional and readiness operations, synchronous (Userspace API 147). */
  readonly "files.at": { readonly at: LinuxAtFiles };
  /** The VM's realtime and monotonic clocks (Userspace API 147). */
  readonly clock: { readonly clock: ClockHost };
  /** The VM's entropy, as getrandom gives it to native programs (Userspace API 147). */
  readonly random: { readonly random: RandomHost };
  /** Raw client sockets; a new module pairs it with a reach token (`net.vm` or `net.internet`). */
  readonly "sockets.connect": { readonly sockets: ClientSockets };
  /** Network reach: programs in this VM only (engine ADR 0029). */
  readonly "net.vm": { readonly net: NetHost };
  /** Network reach: also the internet, through the VM's connection (engine ADR 0029); implies `net.vm`. */
  readonly "net.internet": { readonly net: NetHost };
  readonly "process.info": { readonly process: Pick<LinuxProcesses, "info" | "cwd"> };
  readonly "process.spawn": { readonly process: Pick<LinuxProcesses, "spawn" | "wait" | "signal"> };
  readonly "process.signals": { readonly process: { readonly signals: ProcessSignals } };
  /** Synchronous process calls, merged into `host.process`; `runSync` and owned children (Userspace API 147). */
  readonly "process.sync": { readonly process: ProcessSync };
}
export type Capability = keyof CapabilityMap;

/** The first Userspace API version that serves every operation behind a capability. */
export const CAPABILITY_MIN_API: Readonly<Record<Capability, number>> = {
  // 144 added utimes (utimensat, 280) and write with noSignal (sendto, 44) to both file facades.
  "files.sync": 144,
  "files.async": 144,
  // 147 added the descriptor-relative file operations (openat2 and the *at family, utimensat_at), poll_timed, the clocks
  // (clock_gettime, clock_getres), getrandom, and the owned spawn flag (bit 64) that process.sync's runSync relies on.
  "files.at": 147,
  clock: 147,
  random: 147,
  "sockets.connect": 143,
  // 146 carries each module process's declared reach to Rust, which enforces it (OXMC 2, the module spawn).
  "net.vm": 146,
  "net.internet": 146,
  "process.info": 143,
  "process.spawn": 143,
  // 145 delivers the trappable signals of a JS process to the process instead of their default action (engine ADR 0027).
  "process.signals": 145,
  "process.sync": 147,
};

/** The first Userspace API version that runs a module's `commands` from the VM's PATH (engine ADR 0027). */
export const COMMANDS_MIN_API = 145;

/**
 * The first Userspace API version that serves everything a manifest declares: each capability and, when it declares
 * them, its commands. The parameter is structural so this leaf needs none of the manifest types.
 */
export function manifestMinApi(manifest: { readonly requires: { readonly host: readonly Capability[] }; readonly commands?: readonly string[] }): number {
  return Math.max(0, ...manifest.requires.host.map(capability => CAPABILITY_MIN_API[capability]), ...(manifest.commands === undefined ? [] : [COMMANDS_MIN_API]));
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && Object.hasOwn(CAPABILITY_MIN_API, value);
}

/** Browser features a module may require; the runner probes each before running the adapter. */
export const BROWSER_FEATURES = ["cross-origin-isolated", "indexeddb", "jspi", "web-locks"] as const;
export type BrowserFeature = (typeof BROWSER_FEATURES)[number];

export function isBrowserFeature(value: unknown): value is BrowserFeature {
  return typeof value === "string" && BROWSER_FEATURES.some(feature => feature === value);
}
