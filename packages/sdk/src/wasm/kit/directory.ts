import type { LinuxSyncFiles } from "../../js-process-types.js";
import { linuxErrno } from "./errno.js";
import { uniqueSuffix } from "./unique.js";

const ENOENT = 2;
/** `O_DIRECTORY` on Linux x86-64: lets a directory be opened read-only for `fsync`. */
const O_DIRECTORY = 0o200000;

type SyncOps = Pick<LinuxSyncFiles, "open" | "fsync" | "close">;

/** Flushes one file or directory to storage. */
export function syncPath(fs: SyncOps, path: string, kind: "file" | "directory" = "file"): void {
  const fd = fs.open(path, kind === "directory" ? O_DIRECTORY : 0);
  try { fs.fsync(fd); } finally { fs.close(fd); }
}

export interface AtomicDirectory {
  /** Where the finished directory must appear. */
  readonly destination: string;
  /** A sibling that holds the work in progress; an earlier abandoned attempt is kept under a new name. */
  readonly staging: string;
  /** Fills the staging directory; throwing leaves it in place for inspection and publishes nothing. */
  populate(directory: string): void | Promise<void>;
  /** A fresh suffix for a quarantined staging directory; defaults to 32 random hex digits (`getRandomValues`). */
  readonly unique?: () => string;
}

function parent(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

function exists(fs: Pick<LinuxSyncFiles, "lstat">, path: string): boolean {
  try {
    fs.lstat(path);
    return true;
  } catch (error: unknown) {
    if (linuxErrno(error) === ENOENT) return false;
    throw error;
  }
}

/**
 * Creates a directory so that observers see all of it or none of it: build it beside its destination,
 * flush it, rename it into place, then flush the parents so the rename itself survives a crash.
 * Resolves `"existing"` without touching anything when the destination is already there.
 */
export async function createDirectoryAtomically(
  fs: Pick<LinuxSyncFiles, "lstat" | "mkdir" | "rename" | "open" | "fsync" | "close">,
  spec: AtomicDirectory,
): Promise<"created" | "existing"> {
  if (exists(fs, spec.destination)) return "existing";
  if (exists(fs, spec.staging)) fs.rename(spec.staging, `${spec.staging}-failed-${(spec.unique ?? uniqueSuffix)()}`);
  fs.mkdir(spec.staging, 0o700);
  await spec.populate(spec.staging);
  syncPath(fs, spec.staging, "directory");
  fs.rename(spec.staging, spec.destination);
  for (const directory of new Set([parent(spec.destination), parent(spec.staging)])) syncPath(fs, directory, "directory");
  return "created";
}
