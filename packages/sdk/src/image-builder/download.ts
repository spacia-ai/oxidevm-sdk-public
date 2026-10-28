import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Parser } from "tar";
import { VMError } from "../runtime/errors.js";
import { hashFile } from "./files.js";
import { abortIfRequested } from "./tools.js";
import { atomicBundle } from "./atomic.js";
import { readTarFile } from "./tar-reader.js";
import { integer } from "../runtime/decode.js";
import { extractTarFiles } from "./extract-tar.js";
import type { StagedTarEntry } from "./extract-tar.js";

async function unpackRelease(archive: string, directory: string, signal?: AbortSignal): Promise<void> {
  const paths = new Map<string, StagedTarEntry>(); let expanded = 0;
  const state: { failure?: Error } = {};
  const parser = new Parser({ strict: true, onReadEntry: entry => {
    try {
      abortIfRequested(signal);
      const raw = entry.path;
      if (raw.startsWith("/") || raw.includes("\\") || raw.includes("\0") || raw.split("/").some(part => part === ".." || Buffer.byteLength(part) > 255) || Buffer.byteLength(raw) > 4096 || raw.split("/").length > 64) throw new VMError("PROTOCOL_ERROR", "release archive path escapes its bounded root");
      const path = raw.split("/").filter(part => part !== "" && part !== ".").join("/");
      if (path === "" && entry.type === "Directory") return;
      if (path === "" || paths.has(path) || (entry.type !== "File" && entry.type !== "Directory")) throw new VMError("PROTOCOL_ERROR", "release archive contains duplicate paths, links or unsupported entries");
      expanded += integer(entry.size, "release entry bytes", 0, 512 * 1024 ** 2);
      if (paths.size >= 65_536 || expanded > 4 * 1024 ** 3) throw new VMError("PROTOCOL_ERROR", "release archive exceeds its expanded bound");
      paths.set(path, { type: entry.type, bytes: entry.size });
    } catch (error) {
      state.failure = error instanceof Error ? error : new VMError("PROTOCOL_ERROR", "release archive validation failed");
      parser.abort(state.failure);
    } finally { entry.resume(); }
  } });
  await readTarFile(archive, parser, signal);
  if (state.failure !== undefined) throw state.failure;
  for (const path of paths.keys()) {
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count++) {
      const parent = paths.get(parts.slice(0, count).join("/"));
      if (parent !== undefined && parent.type !== "Directory") throw new VMError("PROTOCOL_ERROR", "release archive descends through a nondirectory");
    }
  }
  await extractTarFiles(archive, directory, paths, signal);
}

export interface DownloadArtifact { readonly url: string; readonly bytes: number; readonly sha256: string }

/** The private release channel's token: OXIDEVM_DOWNLOAD_TOKEN, else GH_TOKEN; an empty value is none. */
export function privateDownloadToken(): string | undefined {
  for (const name of ["OXIDEVM_DOWNLOAD_TOKEN", "GH_TOKEN"]) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function downloadUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new VMError("PROTOCOL_ERROR", "invalid release artifact pin");
  return url;
}

/** Stream `url` into the new file `out`, which must receive exactly `bound` bytes; returns the count. */
async function streamToFile(url: URL, out: string, bound: number, signal?: AbortSignal): Promise<number> {
  const headers: Record<string, string> = { Accept: "application/octet-stream" };
  const token = privateDownloadToken();
  if (url.hostname === "api.github.com" && token !== undefined) headers["Authorization"] = `Bearer ${token}`;
  await mkdir(dirname(out), { recursive: true });
  const file = await open(out, "wx", 0o600);
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.any([...(signal === undefined ? [] : [signal]), AbortSignal.timeout(300_000)]) });
    if (!response.ok || response.body === null) throw new VMError("STORAGE_ERROR", "release artifact download failed", { status: response.status });
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) !== bound) throw new VMError("PROTOCOL_ERROR", "release archive length differs from its pin");
    const reader = response.body.getReader(); let bytes = 0;
    try {
      for (;;) {
        abortIfRequested(signal); const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > bound) { await reader.cancel(); throw new VMError("PROTOCOL_ERROR", "release artifact exceeded its byte bound"); }
        let offset = 0;
        while (offset < next.value.length) { const write = await file.write(next.value, offset, next.value.length - offset); if (write.bytesWritten === 0) throw new VMError("STORAGE_ERROR", "release archive made no write progress"); offset += write.bytesWritten; }
      }
    } finally { reader.releaseLock(); }
    await file.sync();
    return bytes;
  } finally { await file.close(); }
}

/** Download pinned bytes without forwarding private-channel tokens to arbitrary origins. */
export async function downloadArtifact(artifact: DownloadArtifact, out: string, signal?: AbortSignal): Promise<void> {
  abortIfRequested(signal); const url = downloadUrl(artifact.url);
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 2 * 1024 ** 3 || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw new VMError("PROTOCOL_ERROR", "invalid release artifact pin");
  const bytes = await streamToFile(url, out, artifact.bytes, signal);
  if (bytes !== artifact.bytes || await hashFile(out, signal) !== artifact.sha256) throw new VMError("PROTOCOL_ERROR", "release artifact digest differs from its exact pin");
}

/** Releases contain regular bundle files, unlike rootfs source archives with guest links. */
export async function downloadBundle(artifact: DownloadArtifact, out: string, validate: (directory: string) => Promise<void>, signal?: AbortSignal): Promise<void> {
  await atomicBundle(out, async directory => {
    const archive = join(dirname(directory), `.oxidevm-download-${randomUUID()}.tar.gz`);
    try {
      await downloadArtifact(artifact, archive, signal);
      await unpackRelease(archive, directory, signal);
      await validate(directory); abortIfRequested(signal);
    } finally { await rm(archive, { force: true }); }
  }, signal);
}
