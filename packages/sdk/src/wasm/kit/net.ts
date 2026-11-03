import { NetError, type NetErrorCode } from "../net/errors.js";
import { TlsError, type TlsFailure } from "../net/tls.js";

/**
 * One line for a network failure (engine ADR 0029, N-5): what a command prints before it exits with
 * `MODULE_EXIT.unavailable` (69). It understands `NetError`, Node-style `fetch` failures (`TypeError` with a `NetError`
 * cause) and aborts; anything else is described by its message. With `name` (the command's argv0) the line starts with
 * it, as `<argv0>: network unavailable: this VM is not connected to the internet`.
 */
export function describeNetError(error: unknown, name?: string): string {
  const text = describe(error);
  return name === undefined || name === "" ? text : `${name}: ${text}`;
}

const TLS_TEXT: Readonly<Partial<Record<TlsFailure, string>>> = {
  "unknown-issuer": "is not signed by an authority this VM trusts",
  "name-mismatch": "is not valid for this name",
  "certificate-expired": "has expired",
  "certificate-not-yet-valid": "is not valid yet",
  "bad-certificate": "is not usable",
};

function describe(error: unknown): string {
  const cause: unknown = error instanceof TypeError && error.cause !== undefined ? error.cause : error;
  if (cause instanceof DOMException && (cause.name === "AbortError" || cause.name === "TimeoutError")) return cause.name === "TimeoutError" ? "network request timed out" : "network request cancelled";
  if (!(cause instanceof NetError)) return cause instanceof Error ? cause.message : "network request failed";
  const host = cause.hostname === undefined ? "" : ` ${cause.hostname}`;
  if (cause instanceof TlsError) {
    const certificate = TLS_TEXT[cause.tlsFailure];
    return certificate === undefined ? `TLS with${host} failed: ${cause.tlsFailure.replaceAll("-", " ")}` : `TLS: the certificate of${host} ${certificate}`;
  }
  switch (cause.reason) {
    case "vm-local-only": return "network unavailable: this VM is not connected to the internet";
    case "module-network-reach": return `network refused:${host} is beyond this module's declared network reach`;
    case "network-not-declared": return "network not declared: add net.vm or net.internet to requires.host";
    case "vm-hosts-only": return `cannot resolve${host}: a VM-only module resolves names from /etc/hosts`;
    case undefined: break;
  }
  const texts: Readonly<Partial<Record<NetErrorCode, string>>> = {
    ENOTFOUND: `cannot resolve${host}`,
    EAI_AGAIN: `cannot resolve${host}: the VM's nameserver did not answer`,
    ECONNREFUSED: `connection refused by${host}`,
    ECONNRESET: `connection to${host} reset: the VM's internet connection was revoked, or the server reset it`,
    ETIMEDOUT: `connection to${host} timed out`,
    ERR_TLS_NO_TRUST_STORE: "TLS unavailable: this VM has no trust store at /etc/ssl/cert.pem",
  };
  return texts[cause.code] ?? cause.message;
}
