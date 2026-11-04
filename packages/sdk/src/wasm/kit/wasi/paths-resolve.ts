import type { FileDescriptor } from "../../../js-process-types.js";
import { WASI, type WasiErrno } from "./errno.js";
import { LINUX } from "./host.js";
import { LIMITS } from "./limits.js";
import type { GuestMemory } from "./memory.js";
import { WasiError, type WasiContext } from "./context.js";
import type { Entry } from "./descriptors.js";

const SLASH = 0x2f, DOT = 0x2e;
/** RESOLVE_* for every lookup beneath a restricted preopen: the engine refuses `..` escapes, absolute symlinks and magic links. */
export const CONFINED = LINUX.RESOLVE_BENEATH | LINUX.RESOLVE_NO_MAGICLINKS;

/**
 * A guest path, copied out of memory as raw bytes (Linux names are bytes; nothing is decoded or replaced). Empty paths
 * are ENOENT as on Linux, a NUL inside is INVAL and more than LIMITS.pathBytes is NAMETOOLONG, all before a host call.
 */
export function guestPath(memory: GuestMemory, pointer: number, length: number): Uint8Array {
  if (length > LIMITS.pathBytes) throw new WasiError(WASI.nametoolong);
  const bytes = memory.read(pointer, length);
  if (bytes.includes(0)) throw new WasiError(WASI.inval);
  if (bytes.byteLength === 0) throw new WasiError(WASI.noent);
  return bytes;
}

/** The directory a leaf operation acts in and the leaf's name (a single component when confined). */
export interface Parent { readonly dir: FileDescriptor; readonly leaf: Uint8Array; release(): void }

function isDots(name: Uint8Array): boolean {
  return (name.byteLength === 1 && name[0] === DOT) || (name.byteLength === 2 && name[0] === DOT && name[1] === DOT);
}

/**
 * Where a create/remove/rename/link/symlink/readlink/stat-without-follow acts. Beneath an unconfined directory (the
 * root preopen and what it opened) the whole path goes to the engine with that directory. Beneath a confined one the
 * parent is opened by the engine with RESOLVE_BENEATH and held for the operation, so a concurrent rename or symlink swap
 * cannot redirect it outside: the leaf is then a single name, resolved by the operation itself. A leaf of `.` or `..`
 * has no single-name form and is refused with `dots` (the errno Linux gives that operation).
 */
export function parentOf(context: WasiContext, entry: Entry, path: Uint8Array, dots: WasiErrno): Parent {
  if (!entry.confined) return { dir: entry.host, leaf: path, release: () => undefined };
  let end = path.byteLength;
  while (end > 1 && path[end - 1] === SLASH) end -= 1;
  const cut = path.subarray(0, end).lastIndexOf(SLASH);
  const parent = cut < 0 ? Uint8Array.of(DOT) : cut === 0 ? Uint8Array.of(SLASH) : path.subarray(0, cut);
  // The leaf keeps a trailing slash, so the operation applies Linux's "must be a directory" rule itself.
  const name = path.subarray(cut + 1, end), leaf = path.subarray(cut + 1);
  if (name.byteLength === 0 || isDots(name)) throw new WasiError(dots);
  const at = context.at;
  const dir = at.openat(entry.host, parent, LINUX.O_PATH | LINUX.O_DIRECTORY | LINUX.O_CLOEXEC, 0, CONFINED);
  return { dir, leaf, release: () => { try { context.host.fs.close(dir); } catch { /* closed with the process */ } } };
}

/** Runs `body` with the parent of `path` and always releases it. */
export function withParent<T>(context: WasiContext, entry: Entry, path: Uint8Array, dots: WasiErrno, body: (parent: Parent) => T): T {
  const parent = parentOf(context, entry, path, dots);
  try { return body(parent); } finally { parent.release(); }
}

/**
 * Opens `path` itself as O_PATH (following a final symlink only with `follow`), confined like `parentOf`, for the
 * operations that must follow a link but cannot be asked to stay beneath a directory (stat, set-times with follow).
 */
export function openTarget(context: WasiContext, entry: Entry, path: Uint8Array, follow: boolean): FileDescriptor {
  const flags = LINUX.O_PATH | LINUX.O_CLOEXEC | (follow ? 0 : LINUX.O_NOFOLLOW);
  return context.at.openat(entry.host, path, flags, 0, entry.confined ? CONFINED : 0);
}
