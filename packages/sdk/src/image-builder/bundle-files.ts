import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { VMError } from "../runtime/errors.js";
import { hashFile } from "./files.js";
import { abortIfRequested } from "./tools.js";

export async function localBundlePath(bundle: string, relative: string): Promise<string> {
  if (relative.includes("\0") || relative.includes("\\")) throw new VMError("PROTOCOL_ERROR", "invalid bundle path");
  const root = await realpath(bundle); const path = resolve(root, relative);
  if (!path.startsWith(`${root}${sep}`)) throw new VMError("PROTOCOL_ERROR", "bundle artifact escapes directory");
  const actual = await realpath(path);
  if (actual !== path || !actual.startsWith(`${root}${sep}`) || !(await lstat(path)).isFile()) throw new VMError("PROTOCOL_ERROR", "bundle artifacts must be regular files without symlink ancestors");
  return path;
}

export async function readBundleFile(bundle: string, relative: string, maximum = 16 * 1024 ** 2, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  abortIfRequested(signal);
  const path = await localBundlePath(bundle, relative); const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > maximum) throw new VMError("PROTOCOL_ERROR", "bundle metadata exceeds its bound");
    const bytes = new Uint8Array(metadata.size); let offset = 0;
    while (offset < bytes.length) { abortIfRequested(signal); const next = await file.read(bytes, offset, bytes.length - offset, offset); if (next.bytesRead === 0) throw new VMError("PROTOCOL_ERROR", "bundle changed while reading"); offset += next.bytesRead; }
    if ((await file.stat()).size !== bytes.length) throw new VMError("PROTOCOL_ERROR", "bundle changed while reading");
    return bytes;
  } finally { await file.close(); }
}

export function artifactRelativePath(base: URL, artifact: URL): string {
  const prefix = new URL(".", base).pathname;
  if (artifact.origin !== base.origin || !artifact.pathname.startsWith(prefix) || artifact.search !== "" || artifact.hash !== "") throw new VMError("PROTOCOL_ERROR", "bundle artifact is outside its signed serving path");
  let relative: string;
  try { relative = decodeURIComponent(artifact.pathname.slice(prefix.length)); } catch { throw new VMError("PROTOCOL_ERROR", "invalid encoded artifact path"); }
  if (relative === "" || relative.split("/").some(part => part === ".." || part === "." || part === "")) throw new VMError("PROTOCOL_ERROR", "invalid artifact path");
  return relative;
}

export async function verifyBundleArtifact(bundle: string, base: URL, artifact: { readonly url: URL; readonly bytes: number; readonly sha256: string }, signal?: AbortSignal): Promise<string> {
  abortIfRequested(signal); const relative = artifactRelativePath(base, artifact.url); const path = await localBundlePath(bundle, relative);
  if ((await lstat(path)).size !== artifact.bytes || await hashFile(path, signal) !== artifact.sha256) throw new VMError("PROTOCOL_ERROR", "image artifact integrity mismatch", { artifact: relative });
  return path;
}

export function decodeBundleJSON(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new VMError("PROTOCOL_ERROR", "bundle metadata is not valid UTF-8 JSON"); }
}
