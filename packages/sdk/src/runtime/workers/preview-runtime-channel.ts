import { bigint, exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";

const MAX_BYTES = 1024 * 1024;
const MAX_PENDING = 256;
const MAX_PENDING_BYTES = 8 * MAX_BYTES;
export const PREVIEW_RUNTIME_VERSION = 2;

export interface PreviewTarget {
  readonly generation: bigint;
  readonly process: number;
  readonly connection: number;
}

export type PreviewRuntimeOperation =
  /** `process`: the network-resolved listener task, or null when the runtime
   * must find the listener itself (Userspace processes). */
  | { readonly kind: "open"; readonly port: number; readonly process: number | null }
  | ({ readonly kind: "write"; readonly bytes: Uint8Array } & PreviewTarget)
  | ({ readonly kind: "read"; readonly maxBytes: number } & PreviewTarget)
  | ({ readonly kind: "wait"; readonly interest: "read" | "write" } & PreviewTarget)
  | ({ readonly kind: "close" } & PreviewTarget);

export type PreviewRuntimeCompletion =
  | ({ readonly kind: "opened" } & PreviewTarget)
  | { readonly kind: "written"; readonly bytes: number }
  | { readonly kind: "read"; readonly bytes: Uint8Array }
  | { readonly kind: "blocked" }
  | { readonly kind: "ready" }
  | { readonly kind: "eof" }
  | { readonly kind: "closed" }
  | { readonly kind: "error"; readonly code: PreviewRuntimeErrorCode };

export type PreviewRuntimeErrorCode = "listener" | "process" | "staging" | "write" | "read" | "close" | "channel" | "capacity";

export interface PreviewRuntimeRequest {
  readonly version: typeof PREVIEW_RUNTIME_VERSION;
  readonly kind: "preview-runtime";
  readonly sequence: number;
  readonly operation: PreviewRuntimeOperation;
}

export class PreviewRuntimeClient {
  readonly #port: MessagePort;
  #next = 1;
  #closed = false;
  #pendingBytes = 0;
  readonly #cancelledOpens = new Set<number>();
  readonly #pending = new Map<number, {
    readonly bytes: number;
    resolve(value: PreviewRuntimeCompletion): void;
    reject(error: Error): void;
  }>();

  constructor(port: MessagePort) {
    this.#port = port;
  }

  request(operation: PreviewRuntimeOperation, signal?: AbortSignal): Promise<PreviewRuntimeCompletion> {
    if (this.#closed) return Promise.reject(new VMError("ABORTED", "preview runtime channel closed"));
    const bytes = operation.kind === "write" ? operation.bytes.byteLength : 0;
    if (this.#pending.size + this.#cancelledOpens.size >= MAX_PENDING || this.#pendingBytes + bytes > MAX_PENDING_BYTES || this.#next > 0x7fff_ffff) {
      return Promise.reject(new VMError("QUOTA_EXCEEDED", "preview runtime request capacity exhausted"));
    }
    const sequence = this.#next++;
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) return reject(new VMError("ABORTED", "preview operation aborted"));
      const abort = () => {
        const pending = this.#take(sequence);
        if (pending === undefined) return;
        if (operation.kind === "open") this.#cancelledOpens.add(sequence);
        pending.reject(new VMError("ABORTED", "preview operation aborted"));
        this.#cancel(sequence);
      };
      this.#pending.set(sequence, {
        bytes,
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      this.#pendingBytes += bytes;
      signal?.addEventListener("abort", abort, { once: true });
      const transfer = operation.kind === "write" && operation.bytes.buffer instanceof ArrayBuffer
        ? [operation.bytes.buffer]
        : [];
      try {
        this.#port.postMessage({ version: PREVIEW_RUNTIME_VERSION, kind: "preview-runtime", sequence, operation }, transfer);
      } catch (error) {
        this.#take(sequence);
        signal?.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new VMError("PROTOCOL_ERROR", "preview request transfer failed"));
      }
    });
  }

  receive(value: unknown): boolean {
    const response = decodeResponse(value);
    if (response === undefined) return false;
    if (this.#cancelledOpens.delete(response.sequence) && response.completion.kind === "opened") {
      const { generation, process, connection } = response.completion;
      void this.request({ kind: "close", generation, process, connection }).catch(() => { this.close(); });
    }
    const pending = this.#take(response.sequence);
    if (pending === undefined) return true;
    pending.resolve(response.completion);
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [sequence, pending] of this.#pending) {
      this.#cancel(sequence);
      pending.reject(new VMError("ABORTED", "preview runtime channel closed"));
    }
    this.#pending.clear();
    this.#cancelledOpens.clear();
    this.#pendingBytes = 0;
  }

  #take(sequence: number) {
    const pending = this.#pending.get(sequence);
    if (pending !== undefined) { this.#pending.delete(sequence); this.#pendingBytes -= pending.bytes; }
    return pending;
  }

  #cancel(sequence: number): void {
    try { this.#port.postMessage({ version: PREVIEW_RUNTIME_VERSION, kind: "preview-runtime-cancel", sequence }); }
    catch { this.close(); }
  }
}

export type PreviewRuntimeHandler = (operation: PreviewRuntimeOperation, signal: AbortSignal) => PreviewRuntimeCompletion | Promise<PreviewRuntimeCompletion>;

/** One pending-request owner shared by the Userspace and Full-system adapters. */
export class PreviewRuntimeServer {
  readonly #pending = new Map<number, { readonly controller: AbortController; readonly bytes: number }>();
  #pendingBytes = 0;
  #lastSequence = 0;
  #closed = false;

  constructor(readonly port: Pick<MessagePort, "postMessage">, readonly handler: PreviewRuntimeHandler) {}

  receive(value: unknown): boolean {
    const input = record(value, "preview runtime message");
    if (input["kind"] === "preview-runtime-cancel") {
      exactKeys(input, ["version", "kind", "sequence"]); version(input["version"]);
      const sequence = integer(input["sequence"], "preview cancellation sequence", 1, this.#lastSequence);
      const pending = this.#pending.get(sequence);
      if (pending !== undefined) { this.#retire(sequence); pending.controller.abort(); }
      this.#reply(sequence, { kind: "error", code: "channel" });
      return true;
    }
    const request = decodePreviewRuntimeRequest(value);
    if (request === undefined) return false;
    if (this.#closed) return true;
    if (request.sequence <= this.#lastSequence) throw new VMError("PROTOCOL_ERROR", "Stale preview runtime request");
    this.#lastSequence = request.sequence;
    const bytes = request.operation.kind === "write" ? request.operation.bytes.byteLength : 0;
    if (this.#pending.size >= MAX_PENDING || this.#pendingBytes + bytes > MAX_PENDING_BYTES) {
      this.#reply(request.sequence, { kind: "error", code: "capacity" }); return true;
    }
    const controller = new AbortController();
    this.#pending.set(request.sequence, { controller, bytes }); this.#pendingBytes += bytes;
    void Promise.resolve().then(() => controller.signal.aborted ? { kind: "error", code: "channel" } as const
      : this.handler(request.operation, controller.signal)).then(completion => {
      if (this.#retire(request.sequence)) this.#reply(request.sequence, completion);
    }, () => {
      if (this.#retire(request.sequence)) this.#reply(request.sequence, { kind: "error", code: "channel" });
    });
    return true;
  }

  #retire(sequence: number): boolean {
    const pending = this.#pending.get(sequence);
    if (pending === undefined) return false;
    this.#pending.delete(sequence); this.#pendingBytes -= pending.bytes;
    return true;
  }

  #reply(sequence: number, completion: PreviewRuntimeCompletion): void {
    if (this.#closed) return;
    try { this.port.postMessage(encodePreviewRuntimeResponse(sequence, completion)); }
    catch { this.close(); }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.controller.abort();
    this.#pending.clear(); this.#pendingBytes = 0;
  }
}

export function decodePreviewRuntimeRequest(value: unknown): PreviewRuntimeRequest | undefined {
  const request = record(value, "preview runtime request");
  if (request["kind"] !== "preview-runtime") return undefined;
  exactKeys(request, ["version", "kind", "sequence", "operation"]); version(request["version"]);
  return {
    version: PREVIEW_RUNTIME_VERSION,
    kind: "preview-runtime",
    sequence: integer(request["sequence"], "preview sequence", 1, 0x7fff_ffff),
    operation: decodeOperation(request["operation"]),
  };
}

export function encodePreviewRuntimeResponse(
  sequence: number,
  completion: PreviewRuntimeCompletion,
): unknown {
  return { version: PREVIEW_RUNTIME_VERSION, kind: "preview-runtime-response", sequence, completion };
}

function decodeOperation(value: unknown): PreviewRuntimeOperation {
  const operation = record(value, "preview runtime operation");
  const kind = string(operation["kind"], "preview runtime operation kind");
  if (kind === "open") {
    exactKeys(operation, ["kind", "port"], ["process"]);
    const process = operation["process"];
    return { kind, port: integer(operation["port"], "preview port", 1, 65_535),
      process: process === undefined || process === null ? null : integer(process, "preview process", 1, 0xffff_ffff) };
  }
  const process = integer(operation["process"], "preview process", 1, 0xffff_ffff);
  const connection = integer(operation["connection"], "preview connection", 1, 0xffff_ffff);
  const generation = decodePreviewGeneration(operation["generation"]);
  if (kind === "write") {
    exactKeys(operation, ["kind", "generation", "process", "connection", "bytes"]);
    const bytes = operation["bytes"];
    if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteLength > MAX_BYTES) throw new TypeError("invalid preview bytes");
    return { kind, generation, process, connection, bytes };
  }
  if (kind === "read") {
    exactKeys(operation, ["kind", "generation", "process", "connection", "maxBytes"]);
    return { kind, generation, process, connection, maxBytes: integer(operation["maxBytes"], "preview read length", 1, MAX_BYTES) };
  }
  if (kind === "close") {
    exactKeys(operation, ["kind", "generation", "process", "connection"]);
    return { kind, generation, process, connection };
  }
  if (kind === "wait") {
    exactKeys(operation, ["kind", "generation", "process", "connection", "interest"]);
    const interest = string(operation["interest"], "preview readiness interest");
    if (interest !== "read" && interest !== "write") throw new TypeError("invalid preview readiness interest");
    return { kind, generation, process, connection, interest };
  }
  throw new TypeError("unknown preview runtime operation");
}

function decodeResponse(value: unknown): {
  readonly sequence: number;
  readonly completion: PreviewRuntimeCompletion;
} | undefined {
  const response = record(value, "preview runtime response");
  if (response["kind"] !== "preview-runtime-response") return undefined;
  exactKeys(response, ["version", "kind", "sequence", "completion"]); version(response["version"]);
  return {
    sequence: integer(response["sequence"], "preview response sequence", 1),
    completion: decodeCompletion(response["completion"]),
  };
}

function decodeCompletion(value: unknown): PreviewRuntimeCompletion {
  const completion = record(value, "preview runtime completion");
  const kind = string(completion["kind"], "preview completion kind");
  if (kind === "opened") {
    exactKeys(completion, ["kind", "generation", "process", "connection"]);
    return {
      kind,
      generation: decodePreviewGeneration(completion["generation"]),
      process: integer(completion["process"], "preview process", 1, 0xffff_ffff),
      connection: integer(completion["connection"], "preview connection", 1, 0xffff_ffff),
    };
  }
  if (kind === "written") {
    exactKeys(completion, ["kind", "bytes"]);
    return { kind, bytes: integer(completion["bytes"], "preview written bytes", 0, MAX_BYTES) };
  }
  if (kind === "read") {
    exactKeys(completion, ["kind", "bytes"]);
    const bytes = completion["bytes"];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) throw new TypeError("invalid preview response bytes");
    return { kind, bytes };
  }
  if (kind === "error") {
    exactKeys(completion, ["kind", "code"]);
    const code = string(completion["code"], "preview error code");
    if (code !== "listener" && code !== "process" && code !== "staging" && code !== "write" && code !== "read" && code !== "close" && code !== "channel" && code !== "capacity") throw new TypeError("unknown preview error code");
    return { kind, code };
  }
  if (kind === "blocked" || kind === "ready" || kind === "eof" || kind === "closed") {
    exactKeys(completion, ["kind"]);
    return { kind };
  }
  throw new TypeError("unknown preview runtime completion");
}

function version(value: unknown): void {
  if (value !== PREVIEW_RUNTIME_VERSION) throw new VMError("PROTOCOL_ERROR", "Preview runtime protocol version mismatch");
}

export function decodePreviewGeneration(value: unknown): bigint {
  const generation = bigint(value, "preview generation");
  if (generation <= 0n || generation > 0xffff_ffff_ffff_ffffn) throw new VMError("PROTOCOL_ERROR", "Invalid preview generation");
  return generation;
}
