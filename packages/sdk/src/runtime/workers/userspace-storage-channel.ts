import { workspacePublicationTransfers } from "../protocol/workspace-publication.js";
import { UserspaceWorkspaceTransfers } from "./userspace-workspace-transfers.js";
import {decodeWorkspaceBaseMetadata} from "../protocol/workspace-read.js";
import { exactKeys, integer, record, string } from "../decode.js";
import { decodeSerializedError, deserializeError, serializeUnknownError, VMError } from "../errors.js";
import { decodeBytes, decodeOwnedResponseBytes } from "../protocol/decoders.js";
import { PROTOCOL_VERSION } from "../protocol/common.js";
import { decodeAssistanceBinding, type AssistanceBinding } from "../protocol/assistance.js";
import { decodeWorkspaceTransfer, decodeWorkspacePublicationResult, publicationCredit, type WorkspacePublication, type WorkspacePublicationResult, type WorkspaceTransferDescriptor } from "../protocol/workspace-publication.js";
import { decodeWorkspaceReadSelection } from "../protocol/workspace-read.js";
import { decodeWorkspaceStorageRequest, type WorkspaceStorageRequest,type WorkspaceInspectionRequest } from "./snapshot-channel.js";
import type { WorkspaceStorageValue } from "./workspace-publication.js";
import { retireWorkspaceTransfer } from "./workspace-transfer.js";

export type UserspaceStorageRequest =
  | { readonly type: "workspace"; readonly request: WorkspaceStorageRequest|WorkspaceInspectionRequest }
  | { readonly type: "read-rootfs"; readonly path: string }
  | { readonly type: "read-workspace"; readonly path: string }
  | { readonly type: "write-workspace"; readonly path: string; readonly data: Uint8Array<ArrayBuffer> }
  | { readonly type: "read-workspace-snapshot"; readonly workspaceBaseSha256: string }
  | { readonly type: "read-workspace-delta"; readonly workspaceBaseSha256: string }
  | { readonly type: "commit-workspace-snapshot"; readonly workspaceBaseSha256: string; readonly data: Uint8Array<ArrayBuffer> }
  | { readonly type: "open-root-overlay"; readonly rootTreeSha256: string; readonly binding: AssistanceBinding; readonly previous?: AssistanceBinding }
  | { readonly type: "read-root-overlay"; readonly readId: number; readonly offset: number }
  | { readonly type: "close-root-overlay"; readonly readId: number }
  | { readonly type: "commit-root-overlay"; readonly rootTreeSha256: string; readonly input: WorkspaceTransferDescriptor }
  | { readonly type: "read-acceleration-knowledge"; readonly namespace: string }
  | { readonly type: "write-acceleration-knowledge"; readonly namespace: string; readonly data: Uint8Array<ArrayBuffer> };

export interface UserspaceRootfsRead {
  readonly sha256: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

export interface UserspaceRootOverlayRead {
  readonly kind: "root-overlay";
  readonly id: number;
  readonly generation: number;
  readonly bytes: number;
}
export type UserspaceStorageValue = UserspaceRootfsRead | UserspaceRootOverlayRead | WorkspaceStorageValue | {readonly metadata:Uint8Array} | number;

interface Pending {
  readonly resolve: (value: UserspaceStorageValue) => void;
  readonly reject: (error: Error) => void;
  readonly detachAbort: () => void;
}

export class UserspaceStorageClient {
  readonly workspaceTransfers = new UserspaceWorkspaceTransfers(this);
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

  readRootfs(path: string, signal?: AbortSignal): Promise<UserspaceRootfsRead> {
    return this.#request({ type: "read-rootfs", path }, signal).then(requireRootfsRead);
  }

  request(request: WorkspaceStorageRequest|WorkspaceInspectionRequest, transfer: Transferable[] = [], signal?: AbortSignal): Promise<unknown> {
    return this.#request({ type: "workspace", request }, signal, transfer);
  }

  async publishWorkspace(publication: WorkspacePublication, signal?: AbortSignal): Promise<WorkspacePublicationResult> {
    const sources = workspacePublicationTransfers(publication);
    return decodeWorkspacePublicationResult(await this.request({ type: "commit-workspace-streams", publication },
      sources.flatMap(source => [source.stream, source.retirementPort]), signal));
  }

  /** ADR 0026: the remembered-failure record file Rust exported for this engine and SDK. */
  readAccelerationKnowledge(namespace: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
    return this.#request({ type: "read-acceleration-knowledge", namespace }, signal).then(optionalBytes);
  }

  async writeAccelerationKnowledge(namespace: string, data: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<void> {
    requireUndefined(await this.#request({ type: "write-acceleration-knowledge", namespace, data }, signal));
  }

  readWorkspace(path: string): Promise<Uint8Array<ArrayBuffer>> {
    return this.#request({ type: "read-workspace", path }).then(requireBytes);
  }

  async writeWorkspace(path: string, data: Uint8Array<ArrayBuffer>): Promise<void> {
    requireUndefined(await this.#request({ type: "write-workspace", path, data }));
  }

  readWorkspaceSnapshot(workspaceBaseSha256: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
    return this.#request({ type: "read-workspace-snapshot", workspaceBaseSha256 }, signal).then(optionalBytes);
  }

  readWorkspaceDelta(workspaceBaseSha256: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
    return this.#request({ type: "read-workspace-delta", workspaceBaseSha256 }, signal).then(optionalBytes);
  }

  commitWorkspaceSnapshot(workspaceBaseSha256: string, data: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<number> {
    return this.#request({ type: "commit-workspace-snapshot", workspaceBaseSha256, data }, signal).then(requireGeneration);
  }

  async openRootOverlay(rootTreeSha256: string, binding: AssistanceBinding, signal?: AbortSignal, previous?: AssistanceBinding): Promise<UserspaceRootOverlayRead | undefined> {
    const value = await this.#request({ type: "open-root-overlay", rootTreeSha256, binding, ...(previous === undefined ? {} : { previous }) }, signal);
    if (value === undefined) return undefined;
    if (typeof value !== "object" || !("kind" in value) || value.kind !== "root-overlay") {
      throw new VMError("PROTOCOL_ERROR", "Userspace root overlay read is invalid");
    }
    return value;
  }

  readRootFrame(readId: number, offset: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
    return this.#request({ type: "read-root-overlay", readId, offset }, signal).then(optionalBytes);
  }

  async closeRootOverlay(readId: number): Promise<void> {
    requireUndefined(await this.#request({ type: "close-root-overlay", readId }));
  }

  commitRootOverlay(rootTreeSha256: string, input: WorkspaceTransferDescriptor, signal?: AbortSignal): Promise<number> {
    return this.#request({ type: "commit-root-overlay", rootTreeSha256, input }, signal).then(requireGeneration);
  }

  cancelAll(): void {
    for (const id of this.#pending.keys()) this.#port.postMessage({ version: PROTOCOL_VERSION, type: "cancel", requestId: id });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.cancelAll();
    this.#port.postMessage(userspaceStorageClose());
    this.#port.close();
    const error = new VMError("ABORTED", "Userspace storage channel was closed");
    for (const pending of this.#pending.values()) {
      pending.detachAbort();
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #request(
    request: UserspaceStorageRequest,
    signal?: AbortSignal,
    transfer: Transferable[] = request.type === "commit-root-overlay" ? [request.input.stream, request.input.retirementPort] : [],
  ): Promise<UserspaceStorageValue> {
    if (this.#closed) return this.#rejectUnsent(request, new VMError("ABORTED", "Userspace storage channel is closed"));
    if (signal?.aborted === true) return this.#rejectUnsent(request, new VMError("ABORTED", "Userspace storage request was aborted"));
    if (!Number.isSafeInteger(this.#nextId)) return this.#rejectUnsent(request, new VMError("QUOTA_EXCEEDED", "Userspace storage sequence exhausted"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const deadline = request.type === "workspace" && request.request.type !== "commit-workspace-streams"
        || request.type === "open-root-overlay" || request.type === "read-root-overlay" || request.type === "close-root-overlay" ? setTimeout(() => {
        this.#fail(new VMError("STORAGE_ERROR", "Storage read owner did not confirm completion; reopen the VM", { cleanupFailed: true }));
      }, 30_000) : undefined;
      const abort = () => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        signal?.removeEventListener("abort", abort);
        this.#port.postMessage({ version: PROTOCOL_VERSION, type: "cancel", requestId: id });
        // Cancellation is a request, not proof of retirement or rollback. The
        // storage owner returns the actual result after its producer has stopped.
      };
      const detachAbort = () => { clearTimeout(deadline); signal?.removeEventListener("abort", abort); };
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, { resolve, reject, detachAbort });
      try {
        this.#port.postMessage({ version: PROTOCOL_VERSION, id, ...request }, transfer);
      } catch (error) {
        this.#pending.delete(id);
        detachAbort();
        void this.#rejectUnsent(request, error instanceof Error ? error : new VMError("PROTOCOL_ERROR", "Storage request could not be cloned")).catch(reject);
      }
    });
  }

  async #rejectUnsent(request: UserspaceStorageRequest, error: Error): Promise<never> {
    if (request.type === "commit-root-overlay") await retireWorkspaceTransfer(request.input);
    if (request.type === "workspace" && request.request.type === "commit-workspace-streams") {
      const publication = request.request.publication;
      const results = await Promise.allSettled(workspacePublicationTransfers(publication).map(retireWorkspaceTransfer));
      for (const result of results) if (result.status === "rejected") throw result.reason;
    }
    throw error;
  }

  readonly #receive = (event: MessageEvent<unknown>) => {
    let response;
    try {
      response = decodeResponse(event.data);
    } catch (error) {
      this.#fail(error);
      return;
    }
    if ("type" in response) {
      this.#fail(new VMError("ABORTED", "Userspace storage channel was retired"));
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      this.#fail(new VMError("PROTOCOL_ERROR", "Userspace storage response is stale or duplicated"));
      return;
    }
    this.#pending.delete(response.id);
    pending.detachAbort();
    if (response.ok) pending.resolve(response.value);
    else {
      try {
        const failure = deserializeError(decodeSerializedError(response.error));
        pending.reject(failure);
        if (response.closed) this.#fail(failure);
      }
      catch (error) {
        const failure = error instanceof VMError ? error : new VMError("PROTOCOL_ERROR", "Invalid storage terminal error");
        pending.reject(failure);
        this.#fail(failure);
      }
    }
  };

  readonly #messageError = () => this.#fail(new VMError("PROTOCOL_ERROR", "Userspace storage response could not be cloned"));

  #fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.cancelAll();
    this.#port.postMessage(userspaceStorageClose());
    this.#port.close();
    const normalized = error instanceof VMError ? error : new VMError("PROTOCOL_ERROR", String(error));
    for (const pending of this.#pending.values()) {
      pending.detachAbort();
      pending.reject(normalized);
    }
    this.#pending.clear();
  }
}

export function decodeUserspaceStorageIncoming(value: unknown):
  | { readonly type: "close" }
  | { readonly type: "cancel"; readonly requestId: number }
  | ({ readonly id: number } & UserspaceStorageRequest) {
  const message = record(value, "Userspace storage request");
  if (integer(message["version"], "storage protocol version") !== PROTOCOL_VERSION) {
    throw new VMError("PROTOCOL_ERROR", "Userspace storage protocol version mismatch");
  }
  const type = string(message["type"], "storage operation");
  if (type === "close") {
    exactKeys(message, ["version", "type"]);
    return { type };
  }
  if (type === "cancel") {
    exactKeys(message, ["version", "type", "requestId"]);
    return { type, requestId: integer(message["requestId"], "requestId", 1) };
  }
  const id = integer(message["id"], "request id", 1);
  if (type === "workspace") {
    exactKeys(message, ["version", "id", "type", "request"]);
    return { id, type, request: decodeWorkspaceStorageRequest(message["request"]) };
  }
  if (type === "open-root-overlay") {
    exactKeys(message, ["version", "id", "type", "rootTreeSha256", "binding"], ["previous"]);
    return { id, type, rootTreeSha256: sha256(message["rootTreeSha256"]), binding: decodeAssistanceBinding(message["binding"]),
      ...(message["previous"] === undefined ? {} : { previous: decodeAssistanceBinding(message["previous"]) }) };
  }
  if (type === "commit-root-overlay") {
    exactKeys(message, ["version", "id", "type", "rootTreeSha256", "input"]);
    return { id, type, rootTreeSha256: sha256(message["rootTreeSha256"]), input: decodeWorkspaceTransfer(message["input"]) };
  }
  if (type === "read-root-overlay" || type === "close-root-overlay") {
    exactKeys(message, ["version", "id", "type", "readId", ...(type === "read-root-overlay" ? ["offset"] : [])]);
    const readId = integer(message["readId"], "root read id", 1);
    return type === "close-root-overlay" ? { id, type, readId }
      : { id, type, readId, offset: integer(message["offset"], "root read offset", 0, 1024 ** 4) };
  }
  if (type === "read-rootfs" || type === "read-workspace") {
    exactKeys(message, ["version", "id", "type", "path"]);
    return { id, type, path: string(message["path"], "storage path") };
  }
  if (type === "read-workspace-snapshot" || type === "read-workspace-delta") {
    exactKeys(message, ["version", "id", "type", "workspaceBaseSha256"]);
    return { id, type, workspaceBaseSha256: sha256(message["workspaceBaseSha256"]) };
  }
  if (type === "commit-workspace-snapshot") {
    exactKeys(message, ["version", "id", "type", "workspaceBaseSha256", "data"]);
    return {
      id,
      type,
      workspaceBaseSha256: sha256(message["workspaceBaseSha256"]),
      data: new Uint8Array(decodeBytes(message["data"])),
    };
  }
  if (type === "write-workspace") {
    exactKeys(message, ["version", "id", "type", "path", "data"]);
    return { id, type, path: string(message["path"], "storage path"), data: new Uint8Array(decodeBytes(message["data"])) };
  }
  if (type === "read-acceleration-knowledge" || type === "write-acceleration-knowledge") {
    exactKeys(message, ["version", "id", "type", "namespace", ...(type === "write-acceleration-knowledge" ? ["data"] : [])]);
    const namespace = string(message["namespace"], "acceleration knowledge namespace");
    if (!/^[0-9a-f]{64}-[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(namespace)) throw new VMError("PROTOCOL_ERROR", "Invalid acceleration knowledge namespace");
    return type === "read-acceleration-knowledge" ? { id, type, namespace }
      : { id, type, namespace, data: new Uint8Array(decodeBytes(message["data"])) };
  }
  throw new VMError("PROTOCOL_ERROR", "unknown Userspace storage operation");
}

export function userspaceStorageSuccess(id: number, value: UserspaceStorageValue): unknown {
  return { version: PROTOCOL_VERSION, id, ok: true, value };
}

export function userspaceStorageFailure(id: number, error: unknown, closed = false): unknown {
  return { version: PROTOCOL_VERSION, id, ok: false, error: serializeUnknownError(error), ...(closed ? { closed: true } : {}) };
}

export function userspaceStorageClose(): unknown {
  return { version: PROTOCOL_VERSION, type: "close" };
}

function decodeResponse(value: unknown):
  | { readonly type: "close" }
  | { readonly id: number; readonly ok: true; readonly value: UserspaceStorageValue }
  | { readonly id: number; readonly ok: false; readonly error: unknown; readonly closed: boolean } {
  const response = record(value, "Userspace storage response");
  if (response["version"] !== PROTOCOL_VERSION) throw new VMError("PROTOCOL_ERROR", "Userspace storage response version mismatch");
  if (response["type"] === "close") {
    exactKeys(response, ["version", "type"]);
    return { type: "close" };
  }
  const id = integer(response["id"], "response id", 1);
  if (response["ok"] === true) {
    exactKeys(response, ["version", "id", "ok", "value"]);
    return { id, ok: true, value: decodeSuccessValue(response["value"]) };
  }
  if (response["ok"] === false) {
    exactKeys(response, ["version", "id", "ok", "error"], ["closed"]);
    if (response["closed"] !== undefined && response["closed"] !== true) throw new VMError("PROTOCOL_ERROR", "Invalid storage channel retirement flag");
    return { id, ok: false, error: response["error"], closed: response["closed"] === true };
  }
  throw new VMError("PROTOCOL_ERROR", "Userspace storage response status is invalid");
}

function requireBytes(value: UserspaceStorageValue): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array)) throw new VMError("PROTOCOL_ERROR", "Userspace workspace read returned no bytes");
  return value;
}

function requireRootfsRead(value: UserspaceStorageValue): UserspaceRootfsRead {
  if (value === undefined || value instanceof Uint8Array || typeof value === "number" || !("sha256" in value)) {
    throw new VMError("PROTOCOL_ERROR", "Userspace rootfs read returned no digest-qualified bytes");
  }
  return value;
}

function requireUndefined(value: UserspaceStorageValue): void {
  if (value !== undefined) throw new VMError("PROTOCOL_ERROR", "Userspace storage write returned a value");
}

function optionalBytes(value: UserspaceStorageValue): Uint8Array<ArrayBuffer> | undefined {
  if (value === undefined) return undefined;
  return requireBytes(value);
}

function requireGeneration(value: UserspaceStorageValue): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new VMError("PROTOCOL_ERROR", "Userspace workspace generation is invalid");
  }
  return value;
}

function decodeSuccessValue(value: unknown): UserspaceStorageValue {
  if (value === undefined) return undefined;
  if (typeof value === "number") return integer(value, "workspace generation", 1);
  if (value instanceof Uint8Array) return decodeOwnedResponseBytes(value);
  const rootfs = record(value, "Userspace rootfs read");
  if (rootfs["kind"] === "root-overlay") {
    exactKeys(rootfs, ["kind", "id", "generation", "bytes"]);
    return { kind: "root-overlay", id: integer(rootfs["id"], "root read id", 1),
      generation: integer(rootfs["generation"], "root generation", 1), bytes: integer(rootfs["bytes"], "root stream bytes", 1, 1024 ** 4) };
  }
  if (rootfs["metadata"] !== undefined)return decodeWorkspaceBaseMetadata(rootfs);
  if (rootfs["outcome"] !== undefined) return decodeWorkspacePublicationResult(rootfs);
  if (rootfs["kind"] === "return") return publicationCredit(rootfs, "return");
  if (rootfs["generation"] !== undefined) return decodeWorkspaceReadSelection(rootfs);
  exactKeys(rootfs, ["sha256", "bytes"]);
  const sha256 = string(rootfs["sha256"], "rootfs SHA-256");
  if (!/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new VMError("PROTOCOL_ERROR", "rootfs SHA-256 must be lowercase hexadecimal");
  }
  return { sha256, bytes: decodeOwnedResponseBytes(rootfs["bytes"]) };
}

function sha256(value: unknown): string {
  const result = string(value, "workspace base SHA-256");
  if (!/^[0-9a-f]{64}$/u.test(result)) {
    throw new VMError("PROTOCOL_ERROR", "workspace base SHA-256 is invalid");
  }
  return result;
}
