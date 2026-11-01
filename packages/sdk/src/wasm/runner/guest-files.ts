import type { LinuxFiles, LinuxFileStat } from "../../js-process-types.js";
import { linuxErrno } from "../kit/errno.js";
import type { ResolvedManifest } from "../manifest-types.js";
import type { VerifiedArtifacts } from "./artifacts.js";
import { ModuleFailure } from "./failure.js";

const ENOENT = 2, EEXIST = 17;
const S_IFMT = 0o170000, S_IFREG = 0o100000;
const DEFAULT_MODE = 0o644;
/** Directories a module's files may live below; they exist, and only what lies between them and the file is created. */
const ROOTS = ["/workspace", "/tmp"] as const;

async function lstatOrAbsent(files: LinuxFiles, path: string): Promise<LinuxFileStat | undefined> {
  try { return await files.lstat(path); } catch (error: unknown) {
    if (linuxErrno(error) === ENOENT) return undefined;
    throw error;
  }
}

/** Creates the directories between a root and the file's own directory, tolerating those that already exist. */
async function makeParents(files: LinuxFiles, path: string): Promise<void> {
  const root = ROOTS.find(candidate => path.startsWith(`${candidate}/`));
  if (root === undefined) return;
  const segments = path.slice(root.length + 1).split("/").slice(0, -1);
  let current: string = root;
  for (const segment of segments) {
    current = `${current}/${segment}`;
    try { await files.mkdir(current, 0o755); } catch (error: unknown) { if (linuxErrno(error) !== EEXIST) throw error; }
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Puts `bytes` at `path` with `mode`: untouched when it already is exactly that, otherwise a temporary sibling renamed over it. */
async function place(files: LinuxFiles, path: string, bytes: Uint8Array, mode: number): Promise<void> {
  await makeParents(files, path);
  const existing = await lstatOrAbsent(files, path);
  if (existing !== undefined) {
    if ((existing.mode & S_IFMT) !== S_IFREG) throw new ModuleFailure("launch", `${path} exists and is not a regular file, so the module will not replace it`);
    if ((existing.mode & 0o7777) === mode && existing.size === BigInt(bytes.length) && sameBytes(await files.readFile(path, bytes.length + 1), bytes)) return;
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await files.writeFile(temporary, bytes);
    await files.chmod(temporary, mode);
    await files.rename(temporary, path);
  } catch (error: unknown) {
    await files.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Materialises the manifest's `guestFiles`: each declared artifact, already verified, is written to its path in the guest
 * before the adapter's code runs, so the adapter and the Linux programs next to it can rely on it. A file that cannot be
 * written stops the start with a launch failure that names it.
 */
export async function writeGuestFiles(files: LinuxFiles, manifest: ResolvedManifest, artifacts: VerifiedArtifacts): Promise<void> {
  for (const file of manifest.guestFiles ?? []) {
    const bytes = await artifacts.bytes(file.artifact);
    try { await place(files, file.to, bytes, file.mode ?? DEFAULT_MODE); } catch (error: unknown) {
      if (error instanceof ModuleFailure) throw error;
      const errno = linuxErrno(error);
      throw new ModuleFailure("launch", `${file.to} could not be written${errno === undefined ? "" : ` (errno ${String(errno)})`}`);
    }
  }
}
