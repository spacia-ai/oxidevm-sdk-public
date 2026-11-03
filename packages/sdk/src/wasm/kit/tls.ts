import type { NetHost, NetTlsOptions, NetTlsSession } from "../capabilities.js";
import { NetError } from "../net/errors.js";

/**
 * The engine's sans-IO TLS client for a program that moves the bytes itself (engine ADR 0029, N-4; Pyodide's `ssl`).
 * The session verifies against the VM's `/etc/ssl/cert.pem` plus the `trust` anchors it is given (`load_verify_locations`);
 * there is no way to switch verification off. After the handshake it reports the server's chain, protocol version and
 * cipher suite (`getpeercert()`, `version()`, `cipher()`).
 */
export function tlsSession(host: { readonly net: NetHost }, options: NetTlsOptions): NetTlsSession {
  return host.net.tls(options);
}

/** A blocking byte connection, as `host.net.connectSync` returns or a program's own socket layer offers. */
export interface BlockingIo { read(max: number): Uint8Array; write(bytes: Uint8Array): void }

const READ_BYTES = 64 * 1024;

/**
 * Runs a session's handshake over a blocking connection: sends what the session has for the peer, feeds it what the
 * peer answers, until the session is established. A verification failure throws the typed TLS error; a peer that ends
 * the connection first is ECONNRESET.
 */
export function handshakeSync(session: NetTlsSession, io: BlockingIo): void {
  for (;;) {
    const out = session.takeTls();
    if (out.length > 0) io.write(out);
    const state = session.state();
    if (state === "established") return;
    if (state !== "handshaking") throw new NetError("ECONNRESET", "TLS: the session ended during the handshake");
    const bytes = io.read(READ_BYTES);
    if (bytes.length === 0) throw new NetError("ECONNRESET", "TLS: the server closed the connection during the handshake");
    session.receive(bytes);
  }
}
