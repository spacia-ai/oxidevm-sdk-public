import { LinuxError } from "../../runtime/js-process/codec.js";

/** Emscripten's `EIO`, the value an unmapped Linux errno becomes. */
const EMSCRIPTEN_EIO = 29;

/**
 * Linux x86-64 errno values and the numbers Emscripten's `FS.ErrnoError` takes for them. Emscripten
 * uses the WASI numbering (plus `ENOTSUP` = 138), which differs from Linux for every name below.
 * The socket errors are here because a program reacts to them by name: it retries on ECONNREFUSED and ETIMEDOUT and stops on EPIPE.
 */
const LINUX_TO_EMSCRIPTEN: ReadonlyMap<number, number> = new Map([
  [1, 63], // EPERM
  [2, 44], // ENOENT
  [4, 27], // EINTR
  [5, 29], // EIO
  [9, 8], // EBADF
  [11, 6], // EAGAIN
  [12, 48], // ENOMEM
  [13, 2], // EACCES
  [17, 20], // EEXIST
  [18, 75], // EXDEV
  [20, 54], // ENOTDIR
  [21, 31], // EISDIR
  [22, 28], // EINVAL
  [24, 33], // EMFILE
  [27, 22], // EFBIG
  [28, 51], // ENOSPC
  [29, 70], // ESPIPE
  [30, 69], // EROFS
  [32, 64], // EPIPE
  [36, 37], // ENAMETOOLONG
  [38, 52], // ENOSYS
  [39, 55], // ENOTEMPTY
  [40, 32], // ELOOP
  [75, 61], // EOVERFLOW
  [88, 57], // ENOTSOCK
  [90, 35], // EMSGSIZE
  [93, 66], // EPROTONOSUPPORT
  [95, 138], // ENOTSUP
  [97, 5], // EAFNOSUPPORT
  [98, 3], // EADDRINUSE
  [99, 4], // EADDRNOTAVAIL
  [101, 40], // ENETUNREACH
  [103, 13], // ECONNABORTED
  [104, 15], // ECONNRESET
  [105, 42], // ENOBUFS
  [106, 30], // EISCONN
  [107, 53], // ENOTCONN
  [110, 73], // ETIMEDOUT
  [111, 14], // ECONNREFUSED
  [113, 23], // EHOSTUNREACH
  [114, 7], // EALREADY
  [115, 26], // EINPROGRESS
]);

/** The Linux errno carried by a failed host operation, or `undefined` for any other error. */
export function linuxErrno(error: unknown): number | undefined {
  return error instanceof LinuxError ? error.errno : undefined;
}

/** The Emscripten errno for a Linux errno; values without a counterpart become `EIO`. */
export function emscriptenErrno(linuxValue: number): number {
  return LINUX_TO_EMSCRIPTEN.get(Math.abs(linuxValue)) ?? EMSCRIPTEN_EIO;
}
