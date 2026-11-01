import { lstat } from "node:fs/promises";
import { VMError } from "../../runtime/errors.js";
import { checkedOutput } from "../assets.js";
import { readSourceFile } from "../files.js";

/**
 * Reads a file of the project the tool is run on. The project is not trusted: a repository can commit a link named like
 * one of these files, so the file must be a regular file (never a link, a device or a directory) and no larger than its
 * bound, which is checked before a byte is read. `undefined` means the file is absent.
 */
export async function readProjectFile(path: string, maximum: number, label: string = path): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const metadata = await lstat(path).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (metadata === undefined) return undefined;
  const refusal = new VMError("INVALID_ARGUMENT", `${label} must be a regular file, not a link, of at most ${String(maximum)} bytes`);
  if (!metadata.isFile() || metadata.size > maximum) throw refusal;
  try { return (await readSourceFile(path, maximum)).bytes; } catch (error) {
    if (error instanceof VMError && error.code === "INVALID_ARGUMENT") throw refusal;
    throw error;
  }
}

/**
 * Refuses to go on when any existing directory on the way to `relativePath` below `project` is a symbolic link. The project is
 * not trusted: a committed link can lead anywhere, so neither a write nor a read of a module's files follows one.
 */
export async function refuseLinks(project: string, relativePath: string, rule: string): Promise<void> {
  try { await checkedOutput(project, relativePath); } catch (error) {
    if (error instanceof VMError && error.code === "PERMISSION_DENIED") throw new VMError("PERMISSION_DENIED", `${relativePath} is, or lies below, a symbolic link; ${rule}`);
    throw error;
  }
}
