import {decodeWorkspacePublication,type WorkspacePublication} from "../protocol/workspace-publication.js";
import { decodeImageAcquisitionReason, type ImageAcquisitionReason } from "../protocol/image-preparation.js";
import { boolean, exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeBytes } from "../protocol/decoders.js";
import { decodeSnapshotRef, validateAppData, type SnapshotRef } from "../protocol/snapshots.js";
import { decodeHash, decodeKind, decodeLabel, decodeParent } from "./snapshot-manifest-fields.js";
import { MAX_AGENT_STATE_BYTES, SNAPSHOT_CHUNK_BYTES } from "./snapshot-manifest.js";
import type { NativeSnapshotArea, OpenNativeCapture, SealNativeCapture } from "../protocol/native-capture.js";
import type { RootfsCheckpointDestination } from "./rootfs-store.js";
import { decodeNativePayloadRequest, type NativePayloadStorageRequest } from "./snapshot-native-rounds-channel.js";
import {decodeShippedInstallIdentity,type ShippedInstallIdentity} from "../protocol/shipped-source.js";

export type NativeSnapshotStorageRequest =
  | {readonly type:"prepare-native-image"; readonly reason?: ImageAcquisitionReason}
  | {readonly type:"reclaim-native-cache"}
  | NativePayloadStorageRequest
  | (OpenNativeCapture & { readonly type: "open-native-capture"; readonly workspaceBaseSha256: string;
      readonly rootPersistence: "ephemeral" | "persistent"; readonly recovery?: boolean; readonly baseline?: SnapshotRef })
  | (SealNativeCapture & { readonly type: "seal-native-capture" })
  | { readonly type: "put-native-chunk"; readonly area: NativeSnapshotArea; readonly index: number; readonly data: Uint8Array }
  | { readonly type: "commit-native-capture" }
  | { readonly type: "prepare-native-restore"; readonly snapshot: SnapshotRef; readonly rootPersistence: "ephemeral" | "persistent";
      readonly destination: RootfsCheckpointDestination; readonly replacedId?: string; readonly recovery?: SnapshotRef;readonly initialStart?:ShippedInstallIdentity }
  | { readonly type: "stream-native-restore"; readonly area: NativeSnapshotArea; readonly port: MessagePort }
  | { readonly type: "read-native-restore"; readonly area: NativeSnapshotArea; readonly index: number }
  | {readonly type:"stage-native-workspace";readonly publication:WorkspacePublication;readonly preservedId?:string}
  | { readonly type: "stage-native-cold-workspace"; readonly sourceId: string; readonly publication: WorkspacePublication; readonly preserve: boolean }
  | { readonly type: "publish-native-cold" | "complete-native-cold"; readonly sourceId: string }
  | { readonly type: "publish-native-restore" }
  | { readonly type: "complete-native-restore" }
  | { readonly type: "native-session" }
  | { readonly type: "retire-native-recovery"; readonly snapshot: SnapshotRef };

const MAX_STREAM_BYTES = 16 * 1024 ** 3;
export function decodeNativeSnapshotRequest(value: unknown): NativeSnapshotStorageRequest {
  const input = record(value, "native snapshot request");
  const type = string(input["type"], "native snapshot operation");
  switch (type) {
    case "prepare-native-image": exactKeys(input,["type"],["reason"]);return {type,reason:decodeImageAcquisitionReason(input["reason"])};
    case "reclaim-native-cache":exactKeys(input,["type"]);return {type};
    case "native-payload-round-open":
    case "native-payload-round-put":
    case "native-payload-round-seal":
    case "native-live-index-put":
    case "native-live-index-seal":
    case "native-payload-consolidate":
      return decodeNativePayloadRequest(input);
    case "open-native-capture": {
      exactKeys(input, ["type", "snapshot", "kind", "memoryBytes", "workspaceBaseSha256", "rootPersistence"], ["label", "parentId", "recovery", "baseline"]);
      const recovery = input["recovery"];
      if (recovery !== undefined && typeof recovery !== "boolean") invalid();
      const parentId = input["parentId"] === undefined ? undefined : uuid(input["parentId"]);
      const memoryBytes = integer(input["memoryBytes"], "native memory", 16 * SNAPSHOT_CHUNK_BYTES, 3072 * SNAPSHOT_CHUNK_BYTES);
      if (memoryBytes % SNAPSHOT_CHUNK_BYTES !== 0) invalid();
      return { type, snapshot: decodeSnapshotRef(input["snapshot"]), kind: decodeKind(input["kind"]), memoryBytes,
        workspaceBaseSha256: decodeHash(input["workspaceBaseSha256"]), rootPersistence: persistence(input["rootPersistence"]),
        ...(input["label"] === undefined ? {} : { label: decodeLabel(input["label"]) }),
        ...(input["baseline"] === undefined ? {} : { baseline: decodeSnapshotRef(input["baseline"]) }),
        ...(parentId === undefined ? {} : { parentId }), ...(recovery === undefined ? {} : { recovery }) };
    }
    case "seal-native-capture":
      exactKeys(input, ["type", "capturedAtUnixMs", "graphBytes", "payloadBytes"], ["attachment", "appData"]);
      return { type, capturedAtUnixMs: integer(input["capturedAtUnixMs"], "native capture time", 0),
        graphBytes: integer(input["graphBytes"], "native graph length", 1, MAX_STREAM_BYTES),
        payloadBytes: integer(input["payloadBytes"], "native payload length", 0, MAX_STREAM_BYTES),
        ...(input["attachment"] === undefined ? {} : { attachment: bytes(input["attachment"], MAX_AGENT_STATE_BYTES) }),
        ...(input["appData"] === undefined ? {} : { appData: validateAppData(input["appData"]) ?? invalid() }) };
    case "stream-native-restore":
      exactKeys(input, ["type", "area", "port"]);
      if (!(input["port"] instanceof MessagePort)) invalid();
      return { type, area: area(input["area"]), port: input["port"] };
    case "put-native-chunk":
    case "read-native-restore":
      exactKeys(input, type === "put-native-chunk" ? ["type", "area", "index", "data"] : ["type", "area", "index"]);
      return type === "put-native-chunk"
        ? { type, area: area(input["area"]), index: index(input["index"]), data: bytes(input["data"], SNAPSHOT_CHUNK_BYTES) }
        : { type, area: area(input["area"]), index: index(input["index"]) };
    case "prepare-native-restore": {
      exactKeys(input, ["type", "snapshot", "rootPersistence", "destination"], ["replacedId", "recovery","initialStart"]);
      const destination = record(input["destination"], "native snapshot destination");
      exactKeys(destination, ["manifestUrl", "trusted"]);
      const trusted = record(destination["trusted"], "rootfs signing key");
      exactKeys(trusted, ["keyId", "publicKey"]);
      const publicKey = bytes(trusted["publicKey"], 32);
      if (publicKey.length !== 32) invalid();
      return { type, snapshot: decodeSnapshotRef(input["snapshot"]), rootPersistence: persistence(input["rootPersistence"]),
        ...(input["initialStart"]===undefined?{}:{initialStart:decodeShippedInstallIdentity(input["initialStart"])}),
        destination: { manifestUrl: string(destination["manifestUrl"], "rootfs manifest URL"),
          trusted: { keyId: string(trusted["keyId"], "rootfs key id"), publicKey: publicKey.slice() } },
        ...(input["replacedId"] === undefined ? {} : { replacedId: uuid(input["replacedId"]) }),
        ...(input["recovery"] === undefined ? {} : { recovery: decodeSnapshotRef(input["recovery"]) }) };
    }
    case "stage-native-cold-workspace":
      exactKeys(input,["type","sourceId","publication","preserve"]);
      return {type,sourceId:uuid(input["sourceId"]),publication:decodeWorkspacePublication(input["publication"]),preserve:boolean(input["preserve"],"preserve cold source")};
    case "publish-native-cold": case "complete-native-cold":
      exactKeys(input,["type","sourceId"]); return {type,sourceId:uuid(input["sourceId"])};
    case "stage-native-workspace":
      exactKeys(input,["type","publication"],["preservedId"]);return {type,publication:decodeWorkspacePublication(input["publication"]),...(input["preservedId"]===undefined?{}:{preservedId:uuid(input["preservedId"])})};
    case "retire-native-recovery":
      exactKeys(input, ["type", "snapshot"]);
      return { type, snapshot: decodeSnapshotRef(input["snapshot"]) };
    case "commit-native-capture":
    case "publish-native-restore":
    case "complete-native-restore":
    case "native-session":
      exactKeys(input, ["type"]);
      return { type };
    default: return invalid();
  }
}

function bytes(value: unknown, maximum: number): Uint8Array {
  const decoded = decodeBytes(value);
  if (decoded.length === 0 || decoded.length > maximum) invalid();
  return decoded;
}
function area(value: unknown): NativeSnapshotArea { if (value === "graph" || value === "payloads") return value; return invalid(); }
function persistence(value: unknown): "ephemeral" | "persistent" { if (value === "ephemeral" || value === "persistent") return value; return invalid(); }
function index(value: unknown): number { return integer(value, "native chunk", 0, MAX_STREAM_BYTES / SNAPSHOT_CHUNK_BYTES - 1); }
function uuid(value: unknown): string { return decodeParent(value) ?? invalid(); }
function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Native snapshot storage request is invalid"); }
