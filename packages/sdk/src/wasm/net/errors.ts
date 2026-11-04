import { LinuxError } from "../../runtime/js-process/codec.js";

/**
 * The module network's typed failures (engine ADR 0029, N-5). Every failure of `host.net`, `fetch` and `WebSocket` is a
 * `NetError` with a stable Node-style `code` and, where the VM decided it, a `reason`; `fetch` rejects with a
 * `TypeError("fetch failed")` whose `cause` is the `NetError`, as Node's `fetch` does.
 */
export type NetErrorCode =
  | "EPERM" | "EACCES" | "ECONNRESET" | "ECONNREFUSED" | "ECONNABORTED" | "ETIMEDOUT" | "ENETUNREACH" | "EHOSTUNREACH" | "EPIPE" | "EIO"
  | "ENOTFOUND" | "EAI_AGAIN" | "ENODATA" | "ENOENT"
  | "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" | "ERR_TLS_CERT_ALTNAME_INVALID" | "CERT_HAS_EXPIRED" | "CERT_NOT_YET_VALID" | "ERR_TLS_CERT_INVALID"
  | "ERR_TLS_HANDSHAKE" | "ERR_TLS_PROTOCOL" | "ERR_TLS_NO_TRUST_STORE" | "ERR_TLS_INVALID_TRUST"
  | "ERR_HTTP_PARSE" | "ERR_HTTP_BOUNDS" | "ERR_WS_HANDSHAKE" | "ERR_INVALID_URL" | "ERR_UNSUPPORTED_SCHEME" | "ERR_NETWORK_NOT_DECLARED";

/** Why the VM refused or ended a connection; absent for ordinary network failures. */
export type NetErrorReason =
  /** The VM is not connected to the internet (before `vm.network.connect`). */
  | "vm-local-only"
  /** The destination is beyond the reach the module's manifest declares. */
  | "module-network-reach"
  /** The module declares no reach at all. */
  | "network-not-declared"
  /** A VM-only module resolves names from the VM's `/etc/hosts` alone. */
  | "vm-hosts-only";

export interface NetErrorDetails {
  readonly reason?: NetErrorReason;
  readonly errno?: number;
  readonly syscall?: string;
  readonly hostname?: string;
  readonly cause?: unknown;
}

export class NetError extends Error {
  readonly code: NetErrorCode;
  readonly reason: NetErrorReason | undefined;
  readonly errno: number | undefined;
  readonly syscall: string | undefined;
  readonly hostname: string | undefined;
  constructor(code: NetErrorCode, message: string, details: NetErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "NetError"; this.code = code;
    this.reason = details.reason; this.errno = details.errno; this.syscall = details.syscall; this.hostname = details.hostname;
  }
}

const LINUX: Readonly<Record<number, { readonly code: NetErrorCode; readonly reason?: NetErrorReason; readonly text: string }>> = {
  1: { code: "EPERM", reason: "vm-local-only", text: "this VM is not connected to the internet" },
  // A Unix socket path that names nothing (`connectUnixSync`).
  2: { code: "ENOENT", text: "no socket exists at this path" },
  13: { code: "EACCES", reason: "module-network-reach", text: "the destination is beyond the module's declared network reach" },
  32: { code: "EPIPE", text: "the connection is closed" },
  101: { code: "ENETUNREACH", text: "the network is unreachable" },
  103: { code: "ECONNABORTED", text: "the connection was aborted" },
  // A revoke resets every external socket (N-5), but so can a server: the errno alone does not say which.
  104: { code: "ECONNRESET", text: "the connection was reset" },
  110: { code: "ETIMEDOUT", text: "the connection timed out" },
  111: { code: "ECONNREFUSED", text: "the connection was refused" },
  113: { code: "EHOSTUNREACH", text: "the host is unreachable" },
};

/**
 * The `NetError` for a failed socket operation. A Linux errno from the VM's socket owner keeps its meaning: EPERM is the
 * VM's local-only policy and EACCES the module's reach (ADR 0029, N-5); ECONNRESET is what a revoke gives every external
 * socket. Anything already a
 * `NetError`, or an abort, passes through unchanged.
 */
export function netError(error: unknown, syscall: string, hostname?: string): unknown {
  if (error instanceof NetError || !(error instanceof LinuxError)) return error;
  const known = LINUX[error.errno];
  const details = { errno: error.errno, syscall, ...(hostname === undefined ? {} : { hostname }), cause: error };
  if (known === undefined) return new NetError("EIO", `${syscall} failed: Linux errno ${String(error.errno)}`, details);
  return new NetError(known.code, `${syscall} ${hostname ?? ""}: ${known.text}`.replace("  ", " "), { ...details, ...(known.reason === undefined ? {} : { reason: known.reason }) });
}

/** Rethrows `error` as `netError` does. */
export function rethrowNet(error: unknown, syscall: string, hostname?: string): never {
  const mapped = netError(error, syscall, hostname);
  throw mapped;
}

/** A reach-none module touched the network (ADR 0029, Enforcement). */
export function notDeclared(): NetError {
  return new NetError("ERR_NETWORK_NOT_DECLARED", "network not declared: add net.vm or net.internet to requires.host", { reason: "network-not-declared" });
}

/** True for an abort of the caller's own signal, which keeps its own reason rather than becoming a network error. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
    || typeof error === "object" && error !== null && Reflect.get(error, "code") === "ABORTED";
}

/** The reason of an aborted signal as something throwable. */
export function abortReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  return reason ?? new DOMException("The operation was aborted", "AbortError");
}

/** Whether `signal` has aborted, read through a call because it changes while an operation awaits. */
export function aborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }
