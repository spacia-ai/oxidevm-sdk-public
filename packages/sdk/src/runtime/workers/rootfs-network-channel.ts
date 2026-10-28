import { exactKeys, integer, record, string } from "../decode.js";
import { VMError, decodeSerializedError, deserializeError, serializeUnknownError } from "../errors.js";
import { managedImageUrl } from "../managed-image.js";
import { decodeOwnedResponseBytes } from "../protocol/decoders.js";
import { PROTOCOL_VERSION } from "../protocol/common.js";
import { MAX_ROOTFS_METADATA_BYTES } from "../userspace-rootfs.js";

const SHA256 = /^[0-9a-f]{64}$/u;

type FetchRequest =
  | { readonly type: "manifest" | "transport"; readonly url: string; readonly progress?: true }
  | { readonly type: "blob"; readonly url: string; readonly bytes: number; readonly sha256: string; readonly priority?:"high"|"low"; readonly progress?: true };

export interface RootfsNetworkProgress { readonly downloadedBytes: number; readonly requestCount: number }

interface Pending {
  readonly resolve: (bytes: Uint8Array<ArrayBuffer>) => void;
  readonly reject: (error: Error) => void;
  readonly progress?: (value: RootfsNetworkProgress) => void;
}

export class RootfsNetworkClient {
  readonly #port: MessagePort;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;

  constructor(port: MessagePort) {
    this.#port = port;
    port.addEventListener("message", this.#receive);
    port.addEventListener("messageerror", this.#messageError);
    port.start();
  }

  fetchManifest(url: URL, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    return this.#request({ type: "manifest", url: url.href }, signal);
  }

  async fetchTransport(url: URL, signal?: AbortSignal, progress?: (value: RootfsNetworkProgress) => void): Promise<Uint8Array<ArrayBuffer> | undefined> {
    try { return await this.#request({ type: "transport", url: url.href }, signal, progress); }
    catch (error) {
      if (error instanceof VMError && error.code === "STORAGE_NOT_FOUND" && error.detail?.["reason"] === "image-transport-not-found") return undefined;
      throw error;
    }
  }

  fetchBlob(url: URL, bytes: number, sha256: string, signal?: AbortSignal,priority:"high"|"low"="high",progress?: (value:RootfsNetworkProgress)=>void): Promise<Uint8Array<ArrayBuffer>> {
    return this.#request({ type: "blob", url: url.href, bytes, sha256,priority }, signal, progress);
  }

  cancelAll(): void {
    for (const id of this.#pending.keys()) {
      this.#port.postMessage({ version: PROTOCOL_VERSION, type: "cancel", requestId: id });
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.cancelAll();
    this.#port.close();
    const error = new VMError("ABORTED", "rootfs network channel was closed");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #request(request: FetchRequest, signal?: AbortSignal, progress?: (value:RootfsNetworkProgress)=>void): Promise<Uint8Array<ArrayBuffer>> {
    if (this.#closed) return Promise.reject(new VMError("ABORTED", "rootfs network channel is closed"));
    if (signal?.aborted === true) return Promise.reject(new VMError("ABORTED", "rootfs request was cancelled"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const cancel = () => this.#port.postMessage({ version: PROTOCOL_VERSION, type: "cancel", requestId: id });
      this.#pending.set(id, {
        resolve: bytes => { signal?.removeEventListener("abort", cancel); resolve(bytes); },
        reject: error => { signal?.removeEventListener("abort", cancel); reject(error); },
        ...(progress === undefined ? {} : { progress }),
      });
      this.#port.postMessage({ version: PROTOCOL_VERSION, id, ...request, ...(progress === undefined ? {} : { progress: true }) });
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  readonly #receive = (event: MessageEvent<unknown>) => {
    let response;
    try {
      response = decodeResponse(event.data);
    } catch (error) {
      this.#fail(error);
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      this.#fail(new VMError("PROTOCOL_ERROR", "rootfs network response is stale or duplicated"));
      return;
    }
    if (response.type === "progress") {
      if (pending.progress === undefined) { this.#fail(new VMError("PROTOCOL_ERROR", "Unexpected rootfs network progress")); return; }
      try { pending.progress(response); } catch(error) { this.#fail(error); }
      return;
    }
    this.#pending.delete(response.id);
    if (response.ok) pending.resolve(response.bytes);
    else pending.reject(deserializeError(decodeSerializedError(response.error)));
  };

  readonly #messageError = () => this.#fail(new VMError("PROTOCOL_ERROR", "rootfs network response could not be cloned"));

  #fail(error: unknown): void {
    const normalized = error instanceof VMError ? error : new VMError("PROTOCOL_ERROR", String(error));
    if (this.#closed) return;
    this.#closed = true;
    this.cancelAll();
    this.#port.close();
    for (const pending of this.#pending.values()) pending.reject(normalized);
    this.#pending.clear();
  }
}

export function serveRootfsNetwork(port: MessagePort): void {
  const active = new Map<number, AbortController>();
  let lastId = 0;
  port.addEventListener("message", (event: MessageEvent<unknown>) => {
    let request;
    try {
      request = decodeRequest(event.data);
    } catch (error) {
      const id = requestId(event.data);
      if (id !== undefined) postFailure(port, id, error);
      return;
    }
    if (request.type === "cancel") {
      active.get(request.requestId)?.abort();
      return;
    }
    if (request.id <= lastId) {
      postFailure(port, request.id, new VMError("PROTOCOL_ERROR", "rootfs network request id is stale"));
      return;
    }
    lastId = request.id;
    const controller = new AbortController();
    active.set(request.id, controller);
    void fetchRequest(request, controller.signal, request.progress === true ? value => port.postMessage({ version: PROTOCOL_VERSION, id: request.id, type: "progress", ...value }) : undefined).then(
      (bytes) => port.postMessage({ version: PROTOCOL_VERSION, id: request.id, ok: true, bytes }, [bytes.buffer]),
      (error: unknown) => postFailure(port, request.id, error instanceof DOMException && error.name === "AbortError" ? new VMError("ABORTED", "rootfs fetch was aborted") : error),
    ).finally(() => active.delete(request.id));
  });
  port.start();
}

async function fetchRequest(request: Exclude<ReturnType<typeof decodeRequest>, { readonly type: "cancel" }>, signal: AbortSignal, progress?: (value:RootfsNetworkProgress)=>void): Promise<Uint8Array<ArrayBuffer>> {
  let downloadedBytes = 0, requestCount = 0;
  for (let attempt = 0;; attempt++) {
    signal.throwIfAborted();
    try {
      requestCount++; progress?.({ downloadedBytes, requestCount });
      const response = await fetch(request.url, {
        cache: request.type === "manifest" ? "no-store" : attempt === 0 ? "force-cache" : "reload",
        credentials: "omit", signal,
        ...(request.type==="blob"?{priority:request.priority??"high"}:{}),
      });
      if (request.type !== "manifest" && attempt < 2 && (response.status === 408 || response.status === 429 || response.status >= 500 && response.status < 600)) {
        await response.body?.cancel();
        await retryDelay(attempt, signal);
        continue;
      }
      return await readResponse(request, response, bytes => { downloadedBytes += bytes; progress?.({ downloadedBytes, requestCount }); });
    } catch (error) {
      // Only immutable GETs can be replayed, and integrity failures never reach this retry path.
      if (request.type === "manifest" || attempt >= 2 || !(error instanceof TypeError) || signal.aborted) throw error;
      await retryDelay(attempt, signal);
    }
  }
}

async function retryDelay(attempt: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer); signal.removeEventListener("abort", cancel);
      reject(new DOMException("rootfs fetch was aborted", "AbortError"));
    };
    const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, 200 * 2 ** attempt);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

async function readResponse(request: FetchRequest, response: Response, downloaded?: (bytes:number)=>void): Promise<Uint8Array<ArrayBuffer>> {
  if (request.type === "transport" && response.status === 404) {
    await response.body?.cancel();
    throw new VMError("STORAGE_NOT_FOUND", "rootfs transport is not available", { reason: "image-transport-not-found" });
  }
  if (!response.ok || response.body === null) throw new VMError("STORAGE_ERROR", `rootfs fetch returned ${response.status}`);
  const maximum = request.type === "blob" ? request.bytes : MAX_ROOTFS_METADATA_BYTES;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      downloaded?.(value.byteLength);
      if (length > maximum) throw new VMError("STORAGE_ERROR", "rootfs response exceeds its declared length");
      chunks.push(value);
    }
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  if (request.type === "blob" && length !== request.bytes) throw new VMError("STORAGE_ERROR", "rootfs blob length is invalid");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (request.type === "blob" && await sha256(bytes) !== request.sha256) {
    throw new VMError("STORAGE_ERROR", "rootfs blob SHA-256 is invalid");
  }
  return bytes;
}

function decodeRequest(value: unknown):
  | { readonly type: "cancel"; readonly requestId: number }
  | ({ readonly id: number } & FetchRequest) {
  const request = record(value, "rootfs network request");
  const version = integer(request["version"], "rootfs network version");
  if (version !== PROTOCOL_VERSION) throw new VMError("PROTOCOL_ERROR", "rootfs network version mismatch");
  const type = string(request["type"], "rootfs network operation");
  if (request["progress"] !== undefined && request["progress"] !== true) throw new VMError("PROTOCOL_ERROR", "Invalid rootfs progress request");
  const progress = request["progress"] === true ? { progress: true as const } : {};
  if (type === "cancel") {
    exactKeys(request, ["version", "type", "requestId"]);
    return { type, requestId: integer(request["requestId"], "requestId", 1) };
  }
  if (type === "manifest" || type === "transport") {
    exactKeys(request, ["version", "id", "type", "url"], ["progress"]);
    return { id: integer(request["id"], "id", 1), type, url: managedImageUrl(string(request["url"], "url")).href, ...progress };
  }
  if (type === "blob") {
    exactKeys(request, ["version", "id", "type", "url", "bytes", "sha256"],["priority", "progress"]);
    const priority=request["priority"];
    if(priority!==undefined&&priority!=="high"&&priority!=="low")throw new VMError("PROTOCOL_ERROR","rootfs fetch priority is invalid");
    const sha256 = string(request["sha256"], "sha256");
    if (!SHA256.test(sha256)) throw new VMError("PROTOCOL_ERROR", "rootfs blob digest is invalid");
    return {
      id: integer(request["id"], "id", 1), type,
      url: managedImageUrl(string(request["url"], "url")).href,
      bytes: integer(request["bytes"], "bytes", 0, 8 * 1024 * 1024 * 1024), sha256,...(priority===undefined?{}:{priority}),...progress,
    };
  }
  throw new VMError("PROTOCOL_ERROR", "unknown rootfs network operation");
}

function decodeResponse(value: unknown):
  | ({ readonly id: number; readonly type: "progress" } & RootfsNetworkProgress)
  | { readonly id: number; readonly type: "result"; readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly id: number; readonly type: "result"; readonly ok: false; readonly error: unknown } {
  const response = record(value, "rootfs network response");
  if (response["version"] !== PROTOCOL_VERSION) throw new VMError("PROTOCOL_ERROR", "rootfs network response version mismatch");
  const id = integer(response["id"], "id", 1);
  if (response["type"] === "progress") {
    exactKeys(response, ["version", "id", "type", "downloadedBytes", "requestCount"]);
    return { id, type: "progress", downloadedBytes: integer(response["downloadedBytes"], "rootfs downloaded bytes", 0), requestCount: integer(response["requestCount"], "rootfs requests", 1, 3) };
  }
  if (response["ok"] === true) {
    exactKeys(response, ["version", "id", "ok", "bytes"]);
    return { id, type: "result", ok: true, bytes: decodeOwnedResponseBytes(response["bytes"]) };
  }
  if (response["ok"] === false) {
    exactKeys(response, ["version", "id", "ok", "error"]);
    return { id, type: "result", ok: false, error: response["error"] };
  }
  throw new VMError("PROTOCOL_ERROR", "rootfs network response status is invalid");
}

function requestId(value: unknown): number | undefined {
  try { return integer(record(value, "request")["id"], "id", 1); } catch { return undefined; }
}

function postFailure(port: MessagePort, id: number, error: unknown): void {
  port.postMessage({ version: PROTOCOL_VERSION, id, ok: false, error: serializeUnknownError(error) });
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
