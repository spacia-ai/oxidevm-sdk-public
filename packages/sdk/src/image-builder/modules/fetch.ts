import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { VMError } from "../../runtime/errors.js";
import { abortIfRequested } from "../tools.js";

/** Stable `detail.reason` for a download that failed. */
export const DOWNLOAD_REASON = "wasm-module-download";
/** Stable `detail.reason` for downloaded bytes that differ from their pin. */
export const DOWNLOAD_INTEGRITY_REASON = "wasm-module-integrity";

export type Fetch = (url: URL, init: RequestInit) => Promise<Response>;

/** Which addresses a request may be redirected to. Every hop, including the first, must satisfy it. */
export interface RedirectPolicy {
  readonly maxHops: number;
  allows(url: URL): boolean;
}

export interface FetchOptions {
  /** Sent on the first request only: a redirect never receives them, so a token cannot leave its host. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly redirect: RedirectPolicy;
  readonly timeoutMs: number;
  readonly fetchImpl?: Fetch;
  readonly signal?: AbortSignal;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function failure(message: string, status?: number): VMError {
  return new VMError("STORAGE_ERROR", message, { reason: DOWNLOAD_REASON, ...(status === undefined ? {} : { status }) });
}

/** Follows redirects by hand so that each hop can be checked, and withholds the caller's headers from every hop after the first. */
export async function request(url: URL, options: FetchOptions): Promise<Response> {
  const send = options.fetchImpl ?? ((target, init) => fetch(target, init));
  const signal = AbortSignal.any([...(options.signal === undefined ? [] : [options.signal]), AbortSignal.timeout(options.timeoutMs)]);
  let current = url;
  for (let hop = 0; hop <= options.redirect.maxHops; hop++) {
    abortIfRequested(options.signal);
    if (!options.redirect.allows(current)) throw failure(`${current.host} is not an allowed download location`);
    let response: Response;
    try {
      response = await send(current, { redirect: "manual", signal, headers: hop === 0 ? { ...options.headers } : {} });
    } catch (error: unknown) {
      abortIfRequested(options.signal);
      throw failure(`${current.host} could not be reached${error instanceof Error && error.name === "TimeoutError" ? " in time" : ""}`);
    }
    if (!REDIRECTS.has(response.status)) return response;
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    if (location === null) throw failure("a redirect named no location", response.status);
    try { current = new URL(location, current); } catch { throw failure("a redirect named an invalid location", response.status); }
  }
  throw failure(`more than ${String(options.redirect.maxHops)} redirects`);
}

/** Reads a small JSON or text response, never more than `maxBytes`. */
export async function fetchBytes(url: URL, maxBytes: number, options: FetchOptions): Promise<Uint8Array<ArrayBuffer>> {
  const response = await request(url, options);
  if (!response.ok || response.body === null) throw failure(`${url.host} answered ${String(response.status)}`, response.status);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw failure(`the response is larger than ${String(maxBytes)} bytes`); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function fetchJSON(url: URL, maxBytes: number, options: FetchOptions): Promise<unknown> {
  const bytes = await fetchBytes(url, maxBytes, options);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw failure(`${url.host} answered something that is not JSON`); }
}

export interface FileTarget {
  readonly path: string;
  /** The most bytes ever written; a longer body is cut off and rejected. */
  readonly maxBytes: number;
  readonly expectedBytes?: number;
  readonly expectedSha256?: string;
}

/**
 * Streams a response into a new file while hashing it, refusing anything longer than `maxBytes` or different from
 * the expected size and digest. On any failure the partial file is removed.
 */
export async function fetchToFile(url: URL, target: FileTarget, options: FetchOptions): Promise<{ readonly bytes: number; readonly sha256: string }> {
  await mkdir(dirname(target.path), { recursive: true });
  const file = await open(target.path, "wx", 0o600);
  let response: Response;
  const limit = Math.min(target.maxBytes, target.expectedBytes ?? target.maxBytes);
  try {
    response = await request(url, options);
    if (!response.ok || response.body === null) throw failure(`${url.host} answered ${String(response.status)}`, response.status);
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > limit) { await response.body.cancel(); throw failure(`the download declares ${declared} bytes, more than the ${String(limit)} allowed`); }
  } catch (error: unknown) {
    await file.close();
    await rm(target.path, { force: true });
    throw error;
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      abortIfRequested(options.signal);
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw failure(`the download exceeds the ${String(limit)} bytes allowed`); }
      hash.update(part.value);
      let offset = 0;
      while (offset < part.value.length) {
        const written = await file.write(part.value, offset, part.value.length - offset);
        if (written.bytesWritten === 0) throw new VMError("STORAGE_ERROR", "the download made no write progress", { reason: DOWNLOAD_REASON });
        offset += written.bytesWritten;
      }
    }
    await file.sync();
  } catch (error: unknown) {
    await file.close();
    await rm(target.path, { force: true });
    throw error;
  } finally { reader.releaseLock(); }
  await file.close();
  const sha256 = hash.digest("hex");
  if ((target.expectedBytes !== undefined && bytes !== target.expectedBytes) || (target.expectedSha256 !== undefined && sha256 !== target.expectedSha256)) {
    await rm(target.path, { force: true });
    throw new VMError("PROTOCOL_ERROR", "the download differs from its pinned size or sha256", { reason: DOWNLOAD_INTEGRITY_REASON });
  }
  return { bytes, sha256 };
}
