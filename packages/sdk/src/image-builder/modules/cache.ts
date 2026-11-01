import { createHash, randomUUID } from "node:crypto";
import { constants, copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { VMError } from "../../runtime/errors.js";
import { hashFile } from "../files.js";
import { abortIfRequested } from "../tools.js";

/** `$XDG_CACHE_HOME/oxidevm/wasm`, or `~/.cache/oxidevm/wasm` when it is unset, empty or relative (as the XDG specification requires). */
export function defaultModuleCacheDir(environment: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = environment["XDG_CACHE_HOME"];
  return join(configured !== undefined && isAbsolute(configured) ? configured : join(home, ".cache"), "oxidevm", "wasm");
}

/** A download takes minutes and is bounded by a timeout, so scratch older than this belongs to a process that was killed. */
const SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A content-addressed store of verified files: a blob's location is its sha256, so a name can never alias another file. */
export class BlobCache {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  blobPath(sha256: string): string {
    if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new VMError("INVALID_ARGUMENT", "a blob is named by a lowercase sha256");
    return join(this.root, "blobs", "sha256", sha256.slice(0, 2), sha256);
  }
  /** A scratch path inside the cache, on the same filesystem, for a download in progress. */
  scratchPath(): string {
    return join(this.root, "tmp", randomUUID());
  }
  /** Removes scratch files left by a download whose process was killed. Best effort: a file in use is younger than the limit. */
  async sweepScratch(now: number = Date.now(), maxAgeMs: number = SCRATCH_MAX_AGE_MS): Promise<void> {
    const directory = join(this.root, "tmp");
    let names: string[];
    try { names = await readdir(directory); } catch { return; }
    await Promise.all(names.map(async name => {
      const path = join(directory, name);
      try {
        const metadata = await lstat(path);
        if (metadata.isFile() && now - metadata.mtimeMs > maxAgeMs) await rm(path, { force: true });
      } catch { /* another process removed it first */ }
    }));
  }
  /** The blob's path when it is present with exactly `bytes` bytes and its content still hashes to `sha256`. */
  async find(sha256: string, bytes: number, signal?: AbortSignal): Promise<string | undefined> {
    const path = this.blobPath(sha256);
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size !== bytes) return undefined;
      return await hashFile(path, signal) === sha256 ? path : undefined;
    } catch {
      abortIfRequested(signal);
      return undefined;
    }
  }
  /** Stores small in-memory bytes (a release's `module.json` or `SHA256SUMS`) under their digest and returns it. */
  async putBytes(bytes: Uint8Array): Promise<string> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (await this.find(sha256, bytes.byteLength) !== undefined) return sha256;
    const scratch = this.scratchPath();
    await mkdir(dirname(scratch), { recursive: true });
    await writeFile(scratch, bytes, { flag: "wx", mode: 0o600 });
    await this.adopt(scratch, sha256);
    return sha256;
  }
  /** The bytes of a small blob, or `undefined` when it is absent or no longer matches its digest. */
  async readBytes(sha256: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const path = this.blobPath(sha256);
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > maxBytes) return undefined;
      const bytes = new Uint8Array(await readFile(path));
      return createHash("sha256").update(bytes).digest("hex") === sha256 ? bytes : undefined;
    } catch { return undefined; }
  }
  /**
   * Moves a verified scratch file into place. Where a rename cannot replace a file, an existing blob stands in for it only
   * if it still hashes to its name; a damaged one is an error, not a blob to trust.
   */
  async adopt(scratch: string, sha256: string): Promise<string> {
    const path = this.blobPath(sha256);
    await mkdir(dirname(path), { recursive: true });
    try { await rename(scratch, path); } catch (error: unknown) {
      const size = await stat(scratch).then(metadata => metadata.size, () => undefined);
      const intact = size !== undefined && await this.find(sha256, size) !== undefined;
      await rm(scratch, { force: true });
      if (!intact) throw error;
    }
    return path;
  }
}

/**
 * Copies a verified blob to `destination`, as a copy-on-write clone where the filesystem has them. It is never a hard
 * link: a staged file that is edited in place must not change the shared cache blob behind it.
 */
export async function materialize(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await rm(destination, { force: true });
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
}
