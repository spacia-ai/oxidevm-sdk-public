import { VMError } from "../errors.js";
import { RegistryMetadata } from "./registry-metadata.js";
import { decodeRegistryGatewayPolicy } from "../protocol/system-network.js";
import type { RegistryRepresentation } from "../protocol/registry.js";

export type RegistryRelayFetch = (target:string,policy:RegistryGatewayPolicy,representation:RegistryRepresentation,signal:AbortSignal)=>Promise<Response>;

const CHUNK_BYTES = 64 * 1024;
const HEADER_BYTES = 64 * 1024;

export type { RegistryFetchPolicy, RegistryGatewayPolicy } from "../protocol/system-network.js";
import type { RegistryGatewayPolicy } from "../protocol/system-network.js";

/** Network-owner primitive. The bound transport reserves VM credit before
 * allocating each read buffer; this owner neither prefetches nor grants credit.
 * Received bytes are unverified until pnpm/storage validate their integrity. */
export async function openRegistryResponse(
  target: string,
  policy: RegistryGatewayPolicy,
  signal: AbortSignal,
  representation: RegistryRepresentation = "full",
  relay?: RegistryRelayFetch,
): Promise<RegistryResponse> {
  policy = decodeRegistryGatewayPolicy(policy);
  let url: URL;
  try { url = new URL(target); } catch { throw new VMError("INVALID_ARGUMENT", "Invalid registry URL"); }
  if (url.protocol !== "https:" || url.origin !== policy.origin || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new VMError("PERMISSION_DENIED", "Registry destination is outside the installation grant");
  }
  if (!Number.isSafeInteger(policy.maximumBytes) || policy.maximumBytes < 0) {
    throw new VMError("INVALID_ARGUMENT", "Invalid registry response bound");
  }
  requireActive(signal);
  let response: Response;
  try {
    response = await fetch(url.href, { method: "GET", mode: "cors", credentials: "omit", redirect: "error", cache: "no-store", signal,
      // Preserve full retries for pnpm's supply-chain checks. Only this closed
      // content choice crosses the boundary; guest credentials never do.
      headers: { accept: representation === "install" ? "application/vnd.npm.install-v1+json" : "application/json" } });
  } catch {
    requireActive(signal);
    if(relay===undefined)throw new VMError("RELAY_ERROR", "Direct registry transport failed; enable an authorized relay if CORS or redirects prevent access");
    response=await relay(url.href,policy,representation,signal);
  }
  try {
    requireActive(signal);
    if (response.type === "opaque" || response.type === "opaqueredirect" || response.status < 200 || response.status > 599 || response.redirected) {
      throw new VMError("RELAY_ERROR", "Registry response requires an authorized relay transport");
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const document = contentType === "application/json" || contentType === "application/vnd.npm.install-v1+json";
    // A frozen install's packuments are pruned to what pnpm's supply-chain
    // checks read; pnpm must never revalidate such a document from its cache,
    // so the validators stay behind with the upstream response.
    const locked = document ? frozenVersionsFor(policy, url.pathname) : undefined;
    const headers: Array<readonly [string, string]> = [];
    let size = 0;
    for (const [name, value] of response.headers) {
      size += name.length + value.length;
      if (size > HEADER_BYTES) throw new VMError("QUOTA_EXCEEDED", "Registry response headers exceed their bound");
      if (name === "content-type" || name === "cache-control" || ((name === "etag" || name === "last-modified") && locked === undefined)) {
        headers.push([name, value]);
      }
    }
    // Fetch decodes Content-Encoding, which CORS can hide while exposing the
    // original compressed Content-Length. Do not frame decoded bytes with it.
    const encoded = response.type === "cors" || response.headers.has("content-encoding");
    const value = encoded ? null : response.headers.get("content-length");
    const length = value === null ? undefined : Number(value);
    if (value !== null && (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(length))) {
      throw new VMError("PROTOCOL_ERROR", "Invalid registry content length");
    }
    if (length !== undefined && length > policy.maximumBytes) throw new VMError("QUOTA_EXCEEDED", "Registry response exceeds its granted size");
    const metadata = policy.gatewayOrigin !== undefined && document
      ? new RegistryMetadata(policy.origin, policy.gatewayOrigin, locked) : undefined;
    if (value !== null && metadata === undefined) headers.push(["content-length", value]);
    // Leave bounded space for correlation fields and status in the envelope.
    if (new TextEncoder().encode(JSON.stringify(headers)).byteLength > 128 * 1024 - 1024) {
      throw new VMError("QUOTA_EXCEEDED", "Encoded registry headers exceed the transport envelope");
    }
    return new RegistryResponse(response, headers, length, policy.maximumBytes, signal, metadata);
  } catch (error) {
    const failure = error instanceof VMError ? error : new VMError("RELAY_ERROR", "Registry response initialization failed");
    try { await response.body?.cancel(); }
    catch { throw new VMError(failure.code, failure.message, { ...failure.detail, cleanupFailed: true }); }
    throw failure;
  }
}

/** The lockfile's versions for the package a metadata path names (`/next`,
 * `/@img%2Fcolour`); tarball paths and unlisted packages get no set. */
function frozenVersionsFor(policy: RegistryGatewayPolicy, pathname: string): ReadonlySet<string> | undefined {
  if (policy.frozenVersions === undefined || !pathname.startsWith("/") || pathname.includes("/-/")) return undefined;
  let name: string;
  try { name = decodeURIComponent(pathname.slice(1)); } catch { return undefined; }
  if (!Object.hasOwn(policy.frozenVersions, name)) return undefined;
  const versions = policy.frozenVersions[name];
  return versions === undefined ? undefined : new Set(versions);
}

class RegistryResponse {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly #reader: ReadableStreamBYOBReader | undefined;
  readonly #length: number | undefined;
  readonly #maximum: number;
  readonly #signal: AbortSignal;
  #metadata: RegistryMetadata | undefined;
  #output: Uint8Array<ArrayBuffer> = new Uint8Array();
  #offset = 0;
  #received = 0;
  #reading = false;
  #eof = false;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(response: Response, headers: ReadonlyArray<readonly [string, string]>, length: number | undefined, maximum: number, signal: AbortSignal, metadata: RegistryMetadata | undefined) {
    this.status = response.status;
    this.headers = headers;
    this.#reader = response.body?.getReader({ mode: "byob" });
    this.#length = length;
    this.#maximum = maximum;
    this.#signal = signal;
    this.#metadata = metadata;
  }

  async read(buffer: Uint8Array<ArrayBuffer>): Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; readonly done: boolean }> {
    this.#requireOpen();
    if (this.#reading) throw new VMError("PROTOCOL_ERROR", "Concurrent registry reads are not allowed");
    if (!(buffer instanceof Uint8Array) || !(buffer.buffer instanceof ArrayBuffer) || buffer.byteLength === 0 || buffer.byteLength > CHUNK_BYTES
      || buffer.byteOffset !== 0 || buffer.buffer.byteLength !== buffer.byteLength) {
      throw new VMError("INVALID_ARGUMENT", "Registry reads require a granted buffer of 1–65536 bytes");
    }
    this.#reading = true;
    try {
      if (this.#metadata !== undefined) {
        let count = 0;
        while (count < buffer.byteLength) {
          if (this.#offset === this.#output.byteLength) {
            if (this.#eof) break;
            const input = await this.#readRaw(new Uint8Array(4096));
            this.#output = this.#metadata.write(input.bytes, input.done); this.#offset = 0;
          }
          const length = Math.min(buffer.byteLength - count, this.#output.byteLength - this.#offset);
          buffer.set(this.#output.subarray(this.#offset, this.#offset + length), count);
          this.#offset += length; count += length;
        }
        return { bytes: buffer.subarray(0, count), done: this.#eof && this.#offset === this.#output.byteLength };
      }
      return await this.#readRaw(buffer);
    } catch (error) {
      this.#closed = true;
      requireActive(this.#signal);
      if (error instanceof VMError) throw error;
      throw new VMError("RELAY_ERROR", "Registry response was interrupted");
    } finally { this.#reading = false; }
  }

  async #readRaw(buffer: Uint8Array<ArrayBuffer>): Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; readonly done: boolean }> {
      const result = this.#eof || this.#reader === undefined ? { done: true, value: undefined } : await this.#reader.read(buffer);
      this.#requireOpen();
      const bytes = result.value ?? new Uint8Array(0);
      this.#received += bytes.byteLength;
      if (this.#received > this.#maximum) throw new VMError("QUOTA_EXCEEDED", "Registry response exceeds its granted size");
      if (this.#length !== undefined && (this.#received > this.#length || (result.done && this.#received !== this.#length))) {
        throw new VMError("PROTOCOL_ERROR", "Registry response length differs from its headers");
      }
      this.#eof = result.done;
      return { bytes, done: result.done };
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    this.#closing = this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    try { await this.#reader?.cancel(); }
    catch (error) {
      // Fetch errors its reader with AbortError on cancellation. An unrelated
      // cleanup failure remains uncertain even if abort races this await.
      if (!this.#signal.aborted || !(error instanceof DOMException) || error.name !== "AbortError") {
        throw new VMError("RELAY_ERROR", "Registry response cleanup failed");
      }
    }
    finally { this.#reader?.releaseLock(); this.#metadata = undefined; this.#output = new Uint8Array(); this.#offset = 0; }
  }

  #requireOpen(): void {
    if (this.#closed) throw new VMError("ABORTED", "Registry response closed");
    requireActive(this.#signal);
  }
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new VMError("ABORTED", "Registry request cancelled");
}
