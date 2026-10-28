import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Parser } from "tar";
import type { ReadEntry } from "tar";
import { VMError } from "../runtime/errors.js";
import { readTarFile } from "./tar-reader.js";
import { abortIfRequested } from "./tools.js";

export interface StagedTarEntry {
  readonly type: "File" | "Directory" | "Link" | "SymbolicLink";
  readonly bytes: number;
  readonly linkpath?: string;
}

/** Serialize host writes and await their file closure even if reading or cancellation fails. */
export async function extractTarFiles(archive: string, root: string, expected: ReadonlyMap<string, StagedTarEntry>, signal?: AbortSignal): Promise<void> {
  abortIfRequested(signal);
  const seen = new Set<string>(); const active = new Set<ReadEntry>();
  const state: { failure?: Error } = {};
  let writes: Promise<void> = Promise.resolve();
  function fail(error: Error): void {
    if (state.failure !== undefined) return;
    state.failure = error;
    for (const entry of active) entry.destroy(error);
    parser.abort(error);
  }
  async function write(entry: ReadEntry, path: string, metadata: StagedTarEntry): Promise<void> {
    try {
      if (state.failure !== undefined) return;
      abortIfRequested(signal);
      if (metadata.type === "Directory") { await mkdir(join(root, path), { recursive: true, mode: 0o700 }); return; }
      if (metadata.type !== "File") return; // Guest link creation belongs to the validated graph's owner.
      const output = join(root, path); await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      const file = await open(output, "wx", 0o600);
      try {
        let bytes = 0;
        for await (const chunk of entry) {
          abortIfRequested(signal); bytes += chunk.byteLength;
          if (bytes > metadata.bytes) throw new VMError("PROTOCOL_ERROR", "archive file exceeded its validated byte bound");
          let offset = 0;
          while (offset < chunk.length) {
            abortIfRequested(signal);
            const result = await file.write(chunk, offset, chunk.length - offset);
            if (result.bytesWritten === 0) throw new VMError("STORAGE_ERROR", "archive extraction made no write progress");
            offset += result.bytesWritten;
          }
        }
        if (bytes !== metadata.bytes) throw new VMError("PROTOCOL_ERROR", "archive file differs from its validated size");
      } finally { await file.close(); }
    } finally { active.delete(entry); entry.resume(); }
  }
  const parser = new Parser({ strict: true, onReadEntry: entry => {
    active.add(entry); entry.on("error", (error: unknown) => fail(error instanceof Error ? error : new VMError("PROTOCOL_ERROR", "archive entry failed"))); entry.pause();
    try {
      if (entry.path.startsWith("/") || entry.path.includes("\\") || entry.path.includes("\0") || entry.path.split("/").includes("..")) throw new VMError("PROTOCOL_ERROR", "archive changed after its validation");
      const path = entry.path.split("/").filter(segment => segment !== "" && segment !== ".").join("/");
      if (path === "" && entry.type === "Directory") { active.delete(entry); entry.resume(); return; }
      const metadata = expected.get(path);
      if (metadata === undefined || seen.has(path) || entry.type !== metadata.type || entry.size !== metadata.bytes || (metadata.type === "Link" || metadata.type === "SymbolicLink") && entry.linkpath !== metadata.linkpath) throw new VMError("PROTOCOL_ERROR", "archive changed after its validation");
      seen.add(path);
      writes = writes.then(() => write(entry, path, metadata)).catch((error: unknown) => fail(error instanceof Error ? error : new VMError("STORAGE_ERROR", "archive extraction failed")));
    } catch (error) { fail(error instanceof Error ? error : new VMError("PROTOCOL_ERROR", "invalid staged archive")); }
  } });
  const abort = () => fail(new VMError("ABORTED", "archive extraction was cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted === true) abort();
    await readTarFile(archive, parser, signal);
  } catch (error) { fail(error instanceof Error ? error : new VMError("PROTOCOL_ERROR", "archive reading failed")); }
  finally { signal?.removeEventListener("abort", abort); await writes; }
  if (state.failure !== undefined) throw state.failure;
  if (seen.size !== expected.size) throw new VMError("PROTOCOL_ERROR", "archive entries disappeared after validation");
}
