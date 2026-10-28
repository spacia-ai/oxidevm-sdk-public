import { workspacePublicationTransfers } from "../protocol/workspace-publication.js";
import type {CurrentSystemImage} from "../protocol/current-system-image.js";
import { decodeImagePreparationReport, IMAGE_PREPARATION_DETAILS, type ImagePreparationReport } from "../protocol/image-preparation.js";
import { decodeBuildScriptDecisions, type BuildScriptDecision } from "../protocol/build-script-approval.js";
import { exactKeys, integer, record, string } from "../decode.js";
import {
  decodeSerializedError,
  deserializeError,
  VMError,
  type SerializedError,
} from "../errors.js";
import { decodeBytes } from "../protocol/decoders.js";
import { decodeWorkspaceReadRequest, decodeWorkspaceReadIdentity, decodeWorkspaceReadKind, type WorkspaceReadRequest, type WorkspaceReadIdentity, type WorkspaceReadKind } from "../protocol/workspace-read.js";
import { decodeSnapshotRef, decodeWorkspacePublication, decodeWorkspacePublicationResult, SNAPSHOT_KINDS, type SnapshotKind, validateAppData, type WorkspacePublication, type WorkspacePublicationResult, type SnapshotRef } from "../protocol.js";
import { decodeWorkspaceStageResult, type WorkspaceStageResult } from "../protocol/workspace-stage.js";
import { decodeNativeSnapshotRequest, type NativeSnapshotStorageRequest } from "./snapshot-native-channel.js";
import {decodeShippedInstallIdentity,type ShippedInstallIdentity} from "../protocol/shipped-source.js";

export {SNAPSHOT_CHANNEL_VERSION} from "../protocol/snapshot-channel-version.js";
import {SNAPSHOT_CHANNEL_VERSION} from "../protocol/snapshot-channel-version.js";
export type ImagePreparationBytes = ImagePreparationReport;
export type SnapshotStorageProgress = number | ImagePreparationBytes;
interface ImageProgress extends ImagePreparationBytes {readonly version:typeof SNAPSHOT_CHANNEL_VERSION;readonly id:number}


/**
 * How long storage may take without making progress on a save. A request queued behind a stuck
 * storage turn then fails the save, which says where it stopped, instead of leaving it saving.
 */
export const SNAPSHOT_CAPTURE_REQUEST_TIMEOUT_MILLISECONDS = 120_000;

/** The requests a save makes, including the abort that undoes a failed one. */
const CAPTURE_REQUESTS: ReadonlySet<SnapshotStorageRequest["type"]> = new Set([
  "open-capture",
  "seal-capture",
  "put-capture-chunk",
  "commit-capture",
  "abort",
  "open-native-capture", "seal-native-capture", "put-native-chunk", "commit-native-capture",
  "native-payload-round-open", "native-payload-round-put", "native-payload-round-seal",
  "native-live-index-put", "native-live-index-seal", "native-payload-consolidate",
]);

export type SnapshotDiskKind = "none" | "core" | "managed";

export type SnapshotStorageRequest =
  | NativeSnapshotStorageRequest
  | { readonly type: "read-build-policy"; readonly workspaceBaseSha256: string }
  | { readonly type: "commit-build-policy"; readonly workspaceBaseSha256: string; readonly decisions: readonly BuildScriptDecision[] }
  | { readonly type: "stage-workspace-streams"; readonly publication: WorkspacePublication }
  | { readonly type: "finish-workspace-stage"; readonly identity: WorkspaceReadIdentity; readonly decision: "commit" | "abort" }
  | {readonly type:"inspect-workspace-base";readonly workspaceBaseSha256:string}
  | { readonly type: "open-workspace-read"; readonly input: WorkspaceReadRequest }
  | { readonly type: "read-workspace-frame"; readonly identity: WorkspaceReadIdentity; readonly source: WorkspaceReadKind; readonly offset: number }
  | { readonly type: "retire-workspace-source"; readonly identity: WorkspaceReadIdentity; readonly source: WorkspaceReadKind }
  | { readonly type: "retire-workspace-read"; readonly identity: WorkspaceReadIdentity }
  | { readonly type: "commit-workspace-streams"; readonly publication: WorkspacePublication }
  | { readonly type: "cancel-workspace-operation"; readonly requestId: number }
  | {
      readonly type: "remember-boot";
      readonly kernel: Uint8Array;
      readonly initrd?: Uint8Array;
      readonly disk?: Uint8Array;
      readonly managedDisk: boolean;
    }
  /**
   * Starts a capture before its cut. RAM chunks may follow while the guest still runs (a
   * pre-copy); the latest copy of a chunk wins.
   */
  | {
      readonly type: "open-capture";
      readonly snapshot: SnapshotRef;
      readonly kind: SnapshotKind;
      readonly label?: string;
      readonly parentId?: string;
      readonly memoryBytes: number;
      readonly vcpus: number;
    }
  /** The capture's cut: the frozen machine, and the chunks that follow it. */
  | {
      readonly type: "seal-capture";
      readonly capturedAtUnixMs: number;
      readonly machineRecord: Uint8Array;
      /** The OXHA record of the guest-agent session, taken in the same cut. */
      readonly agentState?: Uint8Array;
      /** The page data saved with this restore point, at most 1 MiB. */
      readonly appData?: Uint8Array;
      /** RAM chunks changed since their last copy; each follows this request. */
      readonly ramChunks: readonly number[];
      readonly disk: {
        readonly kind: SnapshotDiskKind;
        readonly bytes: number;
        readonly chunks: readonly number[];
      };
    }
  | {
      readonly type: "put-capture-chunk";
      readonly area: "ram" | "disk";
      readonly index: number;
      readonly data: Uint8Array;
    }
  | { readonly type: "commit-capture" }
  | { readonly type: "prepare-restore"; readonly snapshot: SnapshotRef;readonly initialStart?:ShippedInstallIdentity }
  /** What a resumed guest needs from the workspace store since `snapshot` (workspace-index.ts). */
  | { readonly type: "plan-workspace"; readonly snapshot: SnapshotRef }
  /** Streams the prepared restore's chunks over `port` (snapshot-restore-stream.ts). */
  | { readonly type: "stream-restore"; readonly port: MessagePort }
  | { readonly type: "commit-restore-disk" }
  | { readonly type: "complete-restore" }
  | { readonly type: "abort" }
  /** Thins automatic saves and removes what no restore point needs, as when space runs short. */
  | { readonly type: "collect" };

export type WorkspaceInspectionRequest=Extract<SnapshotStorageRequest,{readonly type:"inspect-workspace-base"}>;
export type WorkspaceStorageRequest = Extract<SnapshotStorageRequest, { readonly type:
  "open-workspace-read" | "read-workspace-frame" | "retire-workspace-source" | "retire-workspace-read" | "commit-workspace-streams" }>;

export function decodeWorkspaceStorageRequest(value: unknown): WorkspaceStorageRequest|WorkspaceInspectionRequest {
  const request = decodeRequest(value);
  if (request.type === "inspect-workspace-base" || request.type === "open-workspace-read" || request.type === "read-workspace-frame" ||
      request.type === "retire-workspace-source" || request.type === "retire-workspace-read" ||
      request.type === "commit-workspace-streams") return request;
  throw new VMError("PROTOCOL_ERROR", "Operation does not belong to workspace storage");
}

export interface PreparedSnapshotRestore {
  readonly systemImage?:CurrentSystemImage;
  readonly snapshot: SnapshotRef;
  readonly capturedAtUnixMs: number;
  /** The managed disk the restore replaces holds files newer than the snapshot. */
  readonly newerFiles: boolean;
  readonly machineRecord: Uint8Array;
  readonly memoryBytes: number;
  readonly ramChunks: readonly number[];
  /** The OXHA record of the guest-agent session at the cut, when one was running. */
  readonly agentState?: Uint8Array;
  /** The page data saved with the snapshot. */
  readonly appData?: Uint8Array;
  readonly disk: {
    readonly mode: "none" | "core" | "host";
    readonly bytes: number;
    readonly baseChunks: readonly number[];
    readonly overlayChunks: readonly number[];
  };
}

interface RequestEnvelope {
  readonly version: typeof SNAPSHOT_CHANNEL_VERSION;
  readonly id: number;
  readonly request: SnapshotStorageRequest;
}

interface ResponseEnvelope {
  readonly version: typeof SNAPSHOT_CHANNEL_VERSION;
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: SerializedError;
}

interface CaptureProgress {
  readonly version: typeof SNAPSHOT_CHANNEL_VERSION;
  readonly id: number;
  readonly completedObjects: number;
}

export class SnapshotStorageClient {
  readonly #port: MessagePort;
  readonly #pending = new Map<
    number,
    { readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void;
      readonly cleanup: () => void; readonly progress: (completedObjects: number) => void; readonly imageProgress:(value:ImagePreparationBytes)=>void }
  >();
  #nextId = 1;
  #failed: VMError | undefined;
  /** Requests that timed out: their answers may still come, and are ignored. */
  readonly #late = new Set<number>();

  constructor(port: MessagePort) {
    this.#port = port;
    port.addEventListener("message", (event) => this.#receive(event.data));
    port.addEventListener("messageerror", () =>
      this.#fail(new VMError("PROTOCOL_ERROR", "snapshot storage channel failed")),
    );
    port.start();
  }

  request(
    request: SnapshotStorageRequest,
    transfer: Transferable[] = [],
    signal?: AbortSignal,
    imageProgress?: (value:ImagePreparationBytes)=>void,
  ): Promise<unknown> {
    if (this.#failed !== undefined) return Promise.reject(this.#failed);
    if (signal !== undefined && !cancellableWorkspaceOperation(request.type)) return Promise.reject(new VMError("INVALID_ARGUMENT", "operation does not accept workspace cancellation"));
    if (!Number.isSafeInteger(this.#nextId)) return Promise.reject(new VMError("PROTOCOL_ERROR", "snapshot request sequence exhausted"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const reading = request.type === "inspect-workspace-base" || request.type === "open-workspace-read" || request.type === "read-workspace-frame"
        || request.type === "retire-workspace-source" || request.type === "retire-workspace-read";
      let completedObjects = 0;
      const timedOut = (): void => {
        this.#pending.delete(id);
        this.#late.add(id);
        cleanup();
        if (cancellableWorkspaceOperation(request.type)) cancel();
        reject(new VMError("STORAGE_ERROR", `snapshot storage did not answer ${request.type} in time`, {
          reason: "storage-timeout", request: request.type,
        }));
      };
      let deadline = reading ? setTimeout(() => {
        this.#fail(new VMError("STORAGE_ERROR", "Workspace read owner did not confirm completion; reopen the VM", {
          reason: "workspace-read-response-timeout", cleanupFailed: true,
        }));
        this.#port.close();
      }, 30_000) : CAPTURE_REQUESTS.has(request.type) ? setTimeout(timedOut, SNAPSHOT_CAPTURE_REQUEST_TIMEOUT_MILLISECONDS) : undefined;
      const cancel = (): void => {
        void this.request({ type: "cancel-workspace-operation", requestId: id }).catch((error: unknown) => {
          this.#fail(error instanceof VMError ? error : new VMError("PROTOCOL_ERROR", String(error)));
        });
      };
      const cleanup = (): void => { clearTimeout(deadline); signal?.removeEventListener("abort", cancel); };
      this.#pending.set(id, { resolve, reject, cleanup, imageProgress:value=>{if(request.type!=="prepare-native-image"&&request.type!=="open-native-capture")throw new VMError("PROTOCOL_ERROR","Unexpected image preparation progress");imageProgress?.(value);}, progress: completed => {
        if (request.type !== "open-native-capture" || completed <= completedObjects) {
          throw new VMError("PROTOCOL_ERROR", "Snapshot capture progress is stale or unexpected");
        }
        completedObjects = completed;
        clearTimeout(deadline);
        deadline = setTimeout(timedOut, SNAPSHOT_CAPTURE_REQUEST_TIMEOUT_MILLISECONDS);
      } });
      const envelope: RequestEnvelope = {
        version: SNAPSHOT_CHANNEL_VERSION,
        id,
        request,
      };
      try {
        this.#port.postMessage(envelope, transfer);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted === true) cancel();
      } catch (error) {
        cleanup();
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new VMError("PROTOCOL_ERROR", String(error)));
      }
    });
  }

  async readBuildPolicy(workspaceBaseSha256: string, signal?: AbortSignal): Promise<readonly BuildScriptDecision[]> {
    if (signal?.aborted === true) throw new VMError("ABORTED", "Build approval read cancelled");
    return decodeBuildScriptDecisions(await this.request({ type: "read-build-policy", workspaceBaseSha256 }, [], signal));
  }

  async commitBuildPolicy(workspaceBaseSha256: string, decisions: readonly BuildScriptDecision[], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw new VMError("ABORTED", "Build approval commit cancelled");
    const result = await this.request({ type: "commit-build-policy", workspaceBaseSha256, decisions }, [], signal);
    if (result !== undefined) throw new VMError("PROTOCOL_ERROR", "Unexpected build policy commit result");
  }

  async publishWorkspace(publication: WorkspacePublication, signal?: AbortSignal): Promise<WorkspacePublicationResult> {
    const transfers = workspacePublicationTransfers(publication);
    return decodeWorkspacePublicationResult(await this.request(
      { type: "commit-workspace-streams", publication },
      transfers.flatMap(transfer => [transfer.stream, transfer.retirementPort]), signal,
    ));
  }

  async stageWorkspace(publication: WorkspacePublication, signal?: AbortSignal): Promise<WorkspaceStageResult> {
    const transfers = workspacePublicationTransfers(publication);
    return decodeWorkspaceStageResult(await this.request({ type: "stage-workspace-streams", publication },
      transfers.flatMap(transfer => [transfer.stream, transfer.retirementPort]), signal));
  }

  async finishWorkspaceStage(identity: WorkspaceReadIdentity, decision: "commit" | "abort"): Promise<WorkspacePublicationResult> {
    const result = decodeWorkspacePublicationResult(await this.request({ type: "finish-workspace-stage", identity, decision }));
    if (result.retired && (result.credit.session !== identity.session || result.credit.generation !== identity.generation
      || result.credit.reservation !== identity.transfer)) throw new VMError("PROTOCOL_ERROR", "Workspace staging returned another reservation", { cleanupFailed: true });
    return result;
  }

  close(): void {
    this.#fail(new VMError("ABORTED", "snapshot storage channel closed"));
    this.#port.close();
  }

  #receive(value: unknown): void {
    try {
      const response = decodeResponse(value);
      const pending = this.#pending.get(response.id);
      if (pending === undefined) {
        if (this.#late.has(response.id)) {
          if (!("completedObjects" in response) && !("completedBytes" in response)) this.#late.delete(response.id);
          return;
        }
        throw new VMError("PROTOCOL_ERROR", "unexpected snapshot storage response");
      }
      if ("completedBytes" in response) { pending.imageProgress({completedBytes:response.completedBytes,totalBytes:response.totalBytes}); return; }
      if ("completedObjects" in response) { pending.progress(response.completedObjects); return; }
      this.#pending.delete(response.id);
      pending.cleanup();
      if (response.ok) {
        pending.resolve(response.value);
      } else if (response.error !== undefined) {
        pending.reject(deserializeError(response.error));
      } else {
        throw new VMError("PROTOCOL_ERROR", "snapshot response error is missing");
      }
    } catch (error) {
      this.#fail(
        error instanceof VMError
          ? error
          : new VMError("PROTOCOL_ERROR", String(error)),
      );
    }
  }

  #fail(error: VMError): void {
    if (this.#failed !== undefined) return;
    this.#failed = error;
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(error); }
    this.#pending.clear();
  }
}

export function decodeSnapshotStorageRequest(value: unknown): {
  readonly id: number;
  readonly request: SnapshotStorageRequest;
} {
  const envelope = record(value, "snapshot storage request");
  exactKeys(envelope, ["version", "id", "request"]);
  if (
    integer(envelope["version"], "snapshot channel version", SNAPSHOT_CHANNEL_VERSION, SNAPSHOT_CHANNEL_VERSION) !==
    SNAPSHOT_CHANNEL_VERSION
  ) {
    throw new VMError("PROTOCOL_ERROR", "snapshot channel version mismatch");
  }
  return {
    id: integer(envelope["id"], "snapshot channel request id", 1),
    request: decodeRequest(envelope["request"]),
  };
}

export function snapshotStorageResponse(
  id: number,
  value: unknown,
): ResponseEnvelope {
  return { version: SNAPSHOT_CHANNEL_VERSION, id, ok: true, value };
}

export function snapshotStorageFailure(
  id: number,
  error: SerializedError,
): ResponseEnvelope {
  return { version: SNAPSHOT_CHANNEL_VERSION, id, ok: false, error };
}

export function snapshotCaptureProgress(id: number, completedObjects: number): CaptureProgress {
  return { version: SNAPSHOT_CHANNEL_VERSION, id, completedObjects };
}

function decodeRequest(value: unknown): SnapshotStorageRequest {
  const request = record(value, "snapshot storage operation");
  const type = string(request["type"], "snapshot storage operation type");
  switch (type) {
    case "native-payload-round-open":
    case "native-payload-round-put":
    case "native-payload-round-seal":
    case "native-live-index-put":
    case "native-live-index-seal":
    case "native-payload-consolidate":
    case "open-native-capture":
    case "seal-native-capture":
    case "put-native-chunk":
    case "commit-native-capture":
    case "stage-native-cold-workspace":
    case "publish-native-cold":
    case "complete-native-cold":
    case "stage-native-workspace":
    case "prepare-native-restore":
    case "stream-native-restore":
    case "prepare-native-image":
    case "reclaim-native-cache":
    case "read-native-restore":
    case "publish-native-restore":
    case "complete-native-restore":
    case "native-session":
    case "retire-native-recovery":
      return decodeNativeSnapshotRequest(request);
    case "read-build-policy":
    case "commit-build-policy": {
      exactKeys(request, type === "read-build-policy" ? ["type", "workspaceBaseSha256"] : ["type", "workspaceBaseSha256", "decisions"]);
      const workspaceBaseSha256 = string(request["workspaceBaseSha256"], "workspace base SHA-256");
      if (!/^[a-f0-9]{64}$/.test(workspaceBaseSha256)) throw new VMError("PROTOCOL_ERROR", "Invalid build policy workspace");
      return type === "read-build-policy" ? { type, workspaceBaseSha256 }
        : { type, workspaceBaseSha256, decisions: decodeBuildScriptDecisions(request["decisions"]) };
    }
    case "inspect-workspace-base": {
      exactKeys(request,["type","workspaceBaseSha256"]);const workspaceBaseSha256=string(request["workspaceBaseSha256"],"workspace base identity");
      if(!/^[0-9a-f]{64}$/u.test(workspaceBaseSha256))throw new VMError("PROTOCOL_ERROR","Workspace base identity is invalid");return {type,workspaceBaseSha256};
    }
    case "open-workspace-read":
      exactKeys(request, ["type", "input"]);
      return { type, input: decodeWorkspaceReadRequest(request["input"]) };
    case "read-workspace-frame":
      exactKeys(request, ["type", "identity", "source", "offset"]);
      return { type, identity: decodeWorkspaceReadIdentity(request["identity"]), source: decodeWorkspaceReadKind(request["source"]), offset: integer(request["offset"], "workspace offset", 0, 1024 ** 4) };
    case "retire-workspace-source":
      exactKeys(request, ["type", "identity", "source"]);
      return { type, identity: decodeWorkspaceReadIdentity(request["identity"]), source: decodeWorkspaceReadKind(request["source"]) };
    case "retire-workspace-read":
      exactKeys(request, ["type", "identity"]);
      return { type, identity: decodeWorkspaceReadIdentity(request["identity"]) };
    case "commit-workspace-streams":
    case "stage-workspace-streams":
      exactKeys(request, ["type", "publication"]);
      return { type, publication: decodeWorkspacePublication(request["publication"]) };
    case "finish-workspace-stage": {
      exactKeys(request, ["type", "identity", "decision"]);
      const decision = request["decision"];
      if (decision !== "commit" && decision !== "abort") throw new VMError("PROTOCOL_ERROR", "Invalid staging decision");
      return { type, identity: decodeWorkspaceReadIdentity(request["identity"]), decision };
    }
    case "cancel-workspace-operation":
      exactKeys(request, ["type", "requestId"]);
      return { type, requestId: integer(request["requestId"], "publication request id", 1) };
    case "remember-boot": {
      exactKeys(request, ["type", "kernel", "managedDisk"], ["initrd", "disk"]);
      if (typeof request["managedDisk"] !== "boolean") invalid();
      return {
        type,
        kernel: decodeBytes(request["kernel"]),
        managedDisk: request["managedDisk"],
        ...(request["initrd"] === undefined
          ? {}
          : { initrd: decodeBytes(request["initrd"]) }),
        ...(request["disk"] === undefined
          ? {}
          : { disk: decodeBytes(request["disk"]) }),
      };
    }
    case "open-capture":
      exactKeys(request, ["type", "snapshot", "kind", "memoryBytes", "vcpus"], ["label", "parentId"]);
      return {
        type,
        snapshot: decodeSnapshotRef(request["snapshot"]),
        kind: SNAPSHOT_KINDS.find((candidate) => candidate === request["kind"]) ?? invalid(),
        memoryBytes: integer(request["memoryBytes"], "snapshot memory bytes", 1),
        vcpus: integer(request["vcpus"], "snapshot vCPUs", 1, 4),
        ...(request["label"] === undefined
          ? {}
          : { label: string(request["label"], "snapshot label") }),
        ...(request["parentId"] === undefined
          ? {}
          : { parentId: decodeUuid(request["parentId"], "parent snapshot id") }),
      };
    case "seal-capture": {
      exactKeys(request, ["type", "capturedAtUnixMs", "machineRecord", "ramChunks", "disk"], ["agentState", "appData"]);
      const disk = record(request["disk"], "snapshot disk descriptor");
      exactKeys(disk, ["kind", "bytes", "chunks"]);
      return {
        type,
        capturedAtUnixMs: integer(request["capturedAtUnixMs"], "snapshot capture time", 0),
        machineRecord: decodeBytes(request["machineRecord"]),
        ramChunks: decodeIndices(request["ramChunks"]),
        disk: {
          kind: decodeDiskKind(disk["kind"]),
          bytes: integer(disk["bytes"], "snapshot disk bytes", 0),
          chunks: decodeIndices(disk["chunks"]),
        },
        ...(request["agentState"] === undefined
          ? {}
          : { agentState: decodeBytes(request["agentState"]) }),
        ...(request["appData"] === undefined ? {} : { appData: decodeAppData(request["appData"]) }),
      };
    }
    case "put-capture-chunk": {
      exactKeys(request, ["type", "area", "index", "data"]);
      const area = string(request["area"], "snapshot chunk area");
      if (area !== "ram" && area !== "disk") invalid();
      return {
        type,
        area,
        index: integer(request["index"], "snapshot chunk index", 0),
        data: decodeBytes(request["data"]),
      };
    }
    case "prepare-restore":
      exactKeys(request, ["type", "snapshot"],["initialStart"]);
      return { type, snapshot: decodeSnapshotRef(request["snapshot"]),...(request["initialStart"]===undefined?{}:{initialStart:decodeShippedInstallIdentity(request["initialStart"])}) };
    case "plan-workspace":
      exactKeys(request, ["type", "snapshot"]);
      return { type, snapshot: decodeSnapshotRef(request["snapshot"]) };
    case "stream-restore": {
      exactKeys(request, ["type", "port"]);
      const port = request["port"];
      if (!(port instanceof MessagePort)) invalid();
      return { type, port };
    }
    case "commit-capture":
    case "commit-restore-disk":
    case "complete-restore":
    case "abort":
    case "collect":
      exactKeys(request, ["type"]);
      return { type };
    default:
      throw new VMError("PROTOCOL_ERROR", `unknown snapshot operation ${type}`);
  }
}

export function cancellableWorkspaceOperation(type: SnapshotStorageRequest["type"]): boolean {
  if (type === "native-payload-round-open" || type === "native-payload-round-put" || type === "native-payload-round-seal"
    || type === "native-live-index-put" || type === "native-live-index-seal" || type === "native-payload-consolidate") return true;
  if (type === "prepare-native-image" || type === "reclaim-native-cache" || type === "open-native-capture" || type === "seal-native-capture" || type === "put-native-chunk" || type === "commit-native-capture"
    || type === "stream-native-restore" || type === "prepare-native-restore" || type === "read-native-restore" || type === "publish-native-restore" || type === "publish-native-cold") return true;
  return type === "stage-native-cold-workspace" || type === "stage-native-workspace" || type === "inspect-workspace-base" || type === "read-build-policy" || type === "commit-build-policy" || type === "commit-workspace-streams" || type === "stage-workspace-streams" || type === "open-workspace-read" || type === "read-workspace-frame";
}

function decodeResponse(value: unknown): ResponseEnvelope | CaptureProgress | ImageProgress {
  const response = record(value, "snapshot storage response");
  if ("completedBytes" in response) {
    exactKeys(response,["version","id","completedBytes","totalBytes"],IMAGE_PREPARATION_DETAILS);
    integer(response["version"],"snapshot channel",SNAPSHOT_CHANNEL_VERSION,SNAPSHOT_CHANNEL_VERSION);
    const id=integer(response["id"],"snapshot request",1),completedBytes=integer(response["completedBytes"],"prepared bytes",0),totalBytes=integer(response["totalBytes"],"image bytes",0);
    if(completedBytes>totalBytes)throw new VMError("PROTOCOL_ERROR","Image preparation progress exceeds its total");
    return {version:SNAPSHOT_CHANNEL_VERSION,id,...decodeImagePreparationReport(response)};
  }
  if ("completedObjects" in response) {
    exactKeys(response, ["version", "id", "completedObjects"]);
    integer(response["version"], "snapshot channel version", SNAPSHOT_CHANNEL_VERSION, SNAPSHOT_CHANNEL_VERSION);
    return snapshotCaptureProgress(integer(response["id"], "snapshot response id", 1),
      integer(response["completedObjects"], "verified snapshot objects", 1));
  }
  const ok = response["ok"];
  if (ok === true) {
    exactKeys(response, ["version", "id", "ok", "value"]);
  } else if (ok === false) {
    exactKeys(response, ["version", "id", "ok", "error"]);
  } else {
    invalid();
  }
  if (
    integer(response["version"], "snapshot channel version", SNAPSHOT_CHANNEL_VERSION, SNAPSHOT_CHANNEL_VERSION) !==
    SNAPSHOT_CHANNEL_VERSION
  ) {
    invalid();
  }
  return {
    version: SNAPSHOT_CHANNEL_VERSION,
    id: integer(response["id"], "snapshot response id", 1),
    ok,
    ...(ok
      ? { value: response["value"] }
      : { error: decodeSerializedError(response["error"]) }),
  };
}

function decodeAppData(value: unknown): Uint8Array {
  const appData = validateAppData(decodeBytes(value));
  return appData ?? invalid();
}

function decodeIndices(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 1_000_000) invalid();
  const indices = value.map((entry) => integer(entry, "snapshot chunk index", 0));
  if (
    indices.some((entry, index) => {
      const previous = indices[index - 1];
      return previous !== undefined && entry <= previous;
    })
  ) {
    invalid();
  }
  return indices;
}

function decodeDiskKind(value: unknown): SnapshotDiskKind {
  const kind = string(value, "snapshot disk kind");
  if (kind === "none" || kind === "core" || kind === "managed") return kind;
  return invalid();
}

function decodeUuid(value: unknown, name: string): string {
  const id = string(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    invalid();
  }
  return id;
}

function invalid(): never {
  throw new VMError("PROTOCOL_ERROR", "snapshot storage message is invalid");
}

export function snapshotImageProgress(id:number,progress:ImagePreparationBytes):ImageProgress {return {version:SNAPSHOT_CHANNEL_VERSION,id,...progress};}
