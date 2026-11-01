import { emscriptenErrno, linuxErrno } from "./errno.js";
import { createDirectoryAtomically, syncPath } from "./directory.js";
import { readExactly, readFrame, writeFrame } from "./framing.js";
import { createGate } from "./gate.js";
import { runNative } from "./native-run.js";

export type { AtomicDirectory } from "./directory.js";
export type { Gate } from "./gate.js";
export type { NativeRunHost, NativeRunRequest, NativeRunResult } from "./native-run.js";

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
}

/** The kit implementation; the runner injects it and adapter unit tests can pass it in a fake host. */
export const kit: Kit = Object.freeze({
  errno: Object.freeze({ of: linuxErrno, toEmscripten: emscriptenErrno }),
  framing: Object.freeze({ readExactly, readFrame, writeFrame }),
  gate: createGate,
  runNative,
  directory: Object.freeze({ sync: syncPath, createAtomically: createDirectoryAtomically }),
});
