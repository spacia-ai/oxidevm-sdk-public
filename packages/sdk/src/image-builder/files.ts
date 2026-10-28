import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { VMError } from "../runtime/errors.js";
import type { UserspaceRootfsBlob, UserspaceRootfsEntry } from "../runtime/userspace-rootfs.js";
import type { FileArtifactInput } from "./contracts.js";
import { abortIfRequested } from "./tools.js";

/** Reject known private bytes/common encodings before admitting filesystem and evidence bytes. */
export function assertNoBuildSecrets(bytes: Uint8Array, forbidden: readonly Uint8Array[]): void {
  const value = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const secret of forbidden) {
    const privateBytes = Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength);
    if (privateBytes.length < 8 ? value.equals(privateBytes) : value.includes(privateBytes)) throw new VMError("INVALID_ARGUMENT", "build secret content was copied into image or evidence bytes");
  }
}
/** A quoted header in npm's option documentation is not a private key. Look for
 * encoded material after the header, including JSON-escaped and truncated PEM. */
function containsPrivateKeyMaterial(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  for (const marker of text.matchAll(/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/gu)) {
    const start = marker.index + marker[0].length;
    const following = text.slice(start, start + 4096).replace(/\\r\\n|\\[rn]/gu, "\n")
      .replace(/^[ \t\r\n]*Proc-Type: 4,ENCRYPTED[ \t\r\n]+DEK-Info: [A-Z0-9-]+,[a-fA-F0-9]+[ \t\r\n]+/u, "");
    const body = following.match(/^[ \t\r\n]*([A-Za-z0-9+/=][A-Za-z0-9+/= \t\r\n]*)/u)?.[1];
    if (body !== undefined && body.replace(/[ \t\r\n]/gu, "").length >= 32) return true;
  }
  return false;
}
import type { FileOwnership } from "../runtime/workspace-record.js";
export interface SourceFileMetadata { readonly mode: number; readonly ownership: FileOwnership }

export function hash(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
/** Read and identify a bounded regular file through one descriptor; never follow a replaced link. */
export async function readSourceFile(path: string, maximum: number, signal?: AbortSignal): Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; readonly mode: number; readonly dev: number; readonly ino: number }> {
  abortIfRequested(signal);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new VMError("INVALID_ARGUMENT", "source must be a readable regular file"); });
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maximum) throw new VMError("INVALID_ARGUMENT", "source exceeds its regular-file byte bound");
    const bytes = new Uint8Array(before.size); let offset = 0;
    while (offset < bytes.length) {
      abortIfRequested(signal); const next = await file.read(bytes, offset, Math.min(1024 ** 2, bytes.length - offset), offset);
      if (next.bytesRead === 0) break; offset += next.bytesRead;
    }
    const after = await file.stat();
    if (offset !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new VMError("PROTOCOL_ERROR", "source changed while staging its bytes");
    return { bytes, mode: before.mode & 0o7777, dev: before.dev, ino: before.ino };
  } finally { await file.close(); }
}
/** Copy `source` to `target` through a temporary sibling, admitting it only with its expected size and SHA-256. */
export async function copyVerified(source: string, target: string, expected: { readonly bytes: number; readonly sha256: string }, signal?: AbortSignal): Promise<void> {
  abortIfRequested(signal); await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.installing-${randomUUID()}`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL); abortIfRequested(signal);
    if ((await lstat(temporary)).size !== expected.bytes || await hashFile(temporary, signal) !== expected.sha256) throw new VMError("PROTOCOL_ERROR", "asset changed while installing");
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}
export async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const file = await open(path, constants.O_RDONLY|constants.O_NOFOLLOW); const digest = createHash("sha256"); const buffer = new Uint8Array(1024 ** 2);
  try {
    for (;;) { abortIfRequested(signal); const next = await file.read(buffer, 0, buffer.length, null); if (next.bytesRead === 0) break; digest.update(buffer.subarray(0, next.bytesRead)); }
    return digest.digest("hex");
  } finally { await file.close(); }
}
async function openArtifact(input: FileArtifactInput, recipeDir: string, limit: number, signal?: AbortSignal) {
  abortIfRequested(signal);
  const file = await open(resolve(recipeDir, input.path), constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch(() => { throw new VMError("INVALID_ARGUMENT", "input artifact must be a readable regular file", { path: input.path }); });
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > limit) throw new VMError("INVALID_ARGUMENT", "input artifact exceeds its regular-file bound", { path: input.path, maximumBytes: limit });
    return { file, metadata };
  } catch (error) { await file.close(); throw error; }
}

/** Boot files have a bounded byte API; source archives use streamed verification. */
export async function checkedArtifact(input: FileArtifactInput, recipeDir: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const { file, metadata } = await openArtifact(input, recipeDir, 128 * 1024 ** 2, signal);
  try {
    const bytes = new Uint8Array(metadata.size); let offset = 0;
    while (offset < bytes.length) {
      abortIfRequested(signal);
      const next = await file.read(bytes, offset, Math.min(1024 ** 2, bytes.length - offset), offset);
      if (next.bytesRead === 0) break;
      offset += next.bytesRead;
    }
    if (offset !== bytes.length || (await file.stat()).size !== metadata.size || hash(bytes) !== input.sha256) throw new VMError("PROTOCOL_ERROR", "input artifact digest does not match its pin", { path: input.path });
    return bytes;
  } finally { await file.close(); }
}

export async function verifyArtifact(input: FileArtifactInput, recipeDir: string, signal?: AbortSignal): Promise<void> {
  const { file, metadata } = await openArtifact(input, recipeDir, 2 * 1024 ** 3, signal);
  const digest = createHash("sha256"); const buffer = new Uint8Array(1024 ** 2); let total = 0;
  try {
    for (;;) {
      abortIfRequested(signal); const next = await file.read(buffer, 0, buffer.length, null);
      if (next.bytesRead === 0) break;
      total += next.bytesRead;
      if (total > metadata.size) throw new VMError("PROTOCOL_ERROR", "input artifact changed during verification");
      digest.update(buffer.subarray(0, next.bytesRead));
    }
    if (total !== metadata.size || digest.digest("hex") !== input.sha256) throw new VMError("PROTOCOL_ERROR", "input artifact digest does not match its pin", { path: input.path });
  } finally { await file.close(); }
}
export async function writeArtifact(bundle: string, servingPath: string, bytes: Uint8Array): Promise<{ readonly url: string; readonly bytes: number; readonly sha256: string }> {
  const sha256 = hash(bytes); const relative = `${servingPath}/${sha256}`;
  await mkdir(dirname(join(bundle, relative)), { recursive: true });
  await writeFile(join(bundle, relative), bytes, { flag: "wx" }).catch(async (error: unknown) => {
    const existing = await readFile(join(bundle, relative)).catch(() => undefined);
    if (existing === undefined || hash(existing) !== sha256) throw error instanceof Error ? error : new VMError("STORAGE_ERROR", "artifact write failed");
  });
  return { url: `./${relative}`, bytes: bytes.byteLength, sha256 };
}

/** Corresponding-source archives remain streamed and pinned, including large ones. */
export async function stageFileArtifact(bundle: string, servingPath: string, source: string,
  expected: { readonly bytes: number; readonly sha256: string }, signal?: AbortSignal): Promise<{ readonly url: string; readonly bytes: number; readonly sha256: string }> {
  abortIfRequested(signal);
  const relative = `${servingPath}/${expected.sha256}`; const path = join(bundle, relative);
  await mkdir(dirname(path), { recursive: true });
  const existing = await lstat(path).catch(() => undefined);
  if (existing !== undefined) {
    if (!existing.isFile() || existing.size !== expected.bytes || await hashFile(path, signal) !== expected.sha256) throw new VMError("PROTOCOL_ERROR", "source artifact has conflicting identity");
    return { bytes: expected.bytes, sha256: expected.sha256, url: `./${relative}` };
  }
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new VMError("INVALID_ARGUMENT", "source artifact must be a readable regular file");
  });
  try {
    const metadata = await input.stat();
    if (!metadata.isFile() || metadata.size !== expected.bytes || expected.bytes > 2 * 1024 ** 3) throw new VMError("PROTOCOL_ERROR", "source artifact changed before staging");
    const output = await open(path, "wx"); const digest = createHash("sha256"); const chunk = new Uint8Array(1024 ** 2); let total = 0;
    try {
      for (;;) {
        abortIfRequested(signal); const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > expected.bytes) throw new VMError("PROTOCOL_ERROR", "source artifact expanded while staging");
        digest.update(chunk.subarray(0, bytesRead)); let offset = 0;
        while (offset < bytesRead) { const result = await output.write(chunk, offset, bytesRead - offset); if (result.bytesWritten === 0) throw new VMError("STORAGE_ERROR", "source artifact write stopped"); offset += result.bytesWritten; }
      }
      if (total !== expected.bytes || digest.digest("hex") !== expected.sha256) throw new VMError("PROTOCOL_ERROR", "source artifact changed while staging");
      await output.sync();
    } finally { await output.close(); }
  } finally { await input.close(); }
  return { bytes: expected.bytes, sha256: expected.sha256, url: `./${relative}` };
}

export async function collectRootfs(root: string, bundle: string | undefined, signal?: AbortSignal, original?: ReadonlyMap<string, SourceFileMetadata>, forbidden: readonly Uint8Array[] = []): Promise<{ readonly entries: readonly UserspaceRootfsEntry[]; readonly blobs: readonly UserspaceRootfsBlob[] }> {
  const entries: UserspaceRootfsEntry[] = []; const blobs = new Map<string, UserspaceRootfsBlob>(); const inodes = new Map<string, string>();
  const paths: string[] = [];
  async function enumerate(directory: string): Promise<void> {
    for (const name of await readdir(join(root, directory))) {
      abortIfRequested(signal);
      const path = directory === "" ? name : `${directory}/${name}`;
      if (name.includes("\0") || name === "." || name === "..") throw new VMError("INVALID_ARGUMENT", "invalid rootfs entry");
      paths.push(path);
      if ((await lstat(join(root, path))).isDirectory()) await enumerate(path);
      if (paths.length > 65536) throw new VMError("INVALID_ARGUMENT", "rootfs exceeds supported metadata entry count");
    }
  }
  await enumerate("");
  paths.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const path of paths) {
    abortIfRequested(signal);
    assertNoBuildSecrets(Buffer.from(path), forbidden);
    const metadata = await lstat(join(root, path));
    const source = original?.get(path);
    const common = { path, mode: source?.mode ?? metadata.mode & 0o7777, ownership: source?.ownership ?? { uid: metadata.uid, gid: metadata.gid } };
    if (metadata.isDirectory()) entries.push({ ...common, type: "directory" });
    else if (metadata.isSymbolicLink()) entries.push({ ...common, type: "symlink", target: await readlink(join(root, path)) });
    else if (metadata.isFile()) {
      const inode = `${metadata.dev}:${metadata.ino}`; const preceding = inodes.get(inode);
      if (metadata.nlink > 1 && preceding !== undefined) { entries.push({ ...common, type: "hardlink", target: preceding }); continue; }
      inodes.set(inode, path);
      if (metadata.size > 128 * 1024 ** 2) throw new VMError("INVALID_ARGUMENT", "rootfs file exceeds the admitted artifact bound", { path });
      const read = await readSourceFile(join(root, path), 128 * 1024 ** 2, signal);
      if (read.dev !== metadata.dev || read.ino !== metadata.ino || read.mode !== (metadata.mode & 0o7777)) throw new VMError("PROTOCOL_ERROR", "rootfs entry changed while collecting metadata");
      const bytes = read.bytes;
      assertNoBuildSecrets(bytes, forbidden);
      if (containsPrivateKeyMaterial(bytes)) throw new VMError("INVALID_ARGUMENT", "rootfs contains a private key", { path });
      if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46 && (bytes[4] !== 2 || bytes[5] !== 1 || bytes[18] !== 62 || bytes[19] !== 0)) throw new VMError("INVALID_ARGUMENT", "rootfs contains an unsupported executable", { path });
      const artifact = bundle === undefined ? { bytes: bytes.byteLength, sha256: hash(bytes), url: `./blobs/${hash(bytes)}` } : await writeArtifact(bundle, "blobs", bytes);
      blobs.set(artifact.sha256, { ...artifact, url: new URL(artifact.url, "https://image.invalid/manifest.json") });
      entries.push({ ...common, type: "file", blob: artifact.sha256 });
    } else throw new VMError("INVALID_ARGUMENT", "rootfs contains a socket, device or other unsupported entry", { path });
  }
  return { entries, blobs: [...blobs.values()].sort((a, b) => a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0) };
}
