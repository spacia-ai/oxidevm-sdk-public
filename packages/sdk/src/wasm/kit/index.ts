import { emscriptenErrno, linuxErrno } from "./errno.js";
import { createDirectoryAtomically, syncPath } from "./directory.js";
import { readExactly, readFrame, writeFrame } from "./framing.js";
import { createGate } from "./gate.js";
import { runNative } from "./native-run.js";
import { emscriptenNetwork, emscriptenNetworkImports, linuxErrnoOf } from "./emscripten-network.js";
import { describeNetError } from "./net.js";
import { handshakeSync, tlsSession } from "./tls.js";

export type { AtomicDirectory } from "./directory.js";
export type { Gate } from "./gate.js";
export type { NativeRunHost, NativeRunRequest, NativeRunResult } from "./native-run.js";
export type { BlockingIo } from "./tls.js";
export type { EmscriptenNetwork } from "./emscripten-network.js";

/**
 * Helpers the runner hands every adapter as `host.kit`. They hold no state of their own, so an
 * adapter bundle stays small and every module on one SDK version shares one tested implementation.
 */
export interface Kit {
  readonly errno: {
    /** The Linux errno of a failed host operation, or `undefined` for any other error. */
    readonly of: typeof linuxErrno;
    /** The number Emscripten's `FS.ErrnoError` takes for a Linux errno (unmapped values become `EIO`). */
    readonly toEmscripten: typeof emscriptenErrno;
  };
  readonly framing: {
    readonly readExactly: typeof readExactly;
    readonly readFrame: typeof readFrame;
    readonly writeFrame: typeof writeFrame;
  };
  /** An exclusive section with cancellable first-in-first-out waiting. */
  readonly gate: typeof createGate;
  /** A native Linux child with piped streams, a deadline and bounded output. */
  readonly runNative: typeof runNative;
  readonly directory: {
    readonly sync: typeof syncPath;
    readonly createAtomically: typeof createDirectoryAtomically;
  };
  /** Adapting an Emscripten program's own runtime (engine ADR 0029, N-4). */
  readonly emscripten: {
    /** Connects the program's SOCKFS stream sockets and `getaddrinfo` to `host.net`; returns per-socket receive timeouts. */
    readonly network: typeof emscriptenNetwork;
    /** Wraps the program's `getaddrinfo` import, before instantiation, so a lookup failure is EAI_NONAME or EAI_AGAIN. */
    readonly networkImports: typeof emscriptenNetworkImports;
  };
  /** The engine's sans-IO TLS client (ADR 0029, N-4), verified against the VM's trust store. */
  readonly tls: {
    readonly session: typeof tlsSession;
    readonly handshakeSync: typeof handshakeSync;
  };
  /** Network failures (ADR 0029, N-5). */
  readonly net: {
    /** One line for a failure; a command prints it and exits `MODULE_EXIT.unavailable` (69). */
    readonly describe: typeof describeNetError;
    /** The Linux errno a network failure carries, or the closest one. */
    readonly errno: typeof linuxErrnoOf;
  };
}

/** The kit implementation; the runner injects it and adapter unit tests can pass it in a fake host. */
export const kit: Kit = Object.freeze({
  errno: Object.freeze({ of: linuxErrno, toEmscripten: emscriptenErrno }),
  framing: Object.freeze({ readExactly, readFrame, writeFrame }),
  gate: createGate,
  runNative,
  directory: Object.freeze({ sync: syncPath, createAtomically: createDirectoryAtomically }),
  emscripten: Object.freeze({ network: emscriptenNetwork, networkImports: emscriptenNetworkImports }),
  tls: Object.freeze({ session: tlsSession, handshakeSync }),
  net: Object.freeze({ describe: describeNetError, errno: linuxErrnoOf }),
});
