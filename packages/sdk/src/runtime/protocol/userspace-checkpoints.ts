import {decodeShippedInstallIdentity,type ShippedInstallIdentity} from "./shipped-source.js";
import { decodeUserspaceWorkspaceStart, type UserspaceWorkspaceStart } from "./workspace-start.js";
import { boolean, exactKeys, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import type { Operation, OperationDecoders } from "./operations.js";
import { PROTOCOL_VERSION } from "./common.js";
import { decodeImageAcquisitionReason, type ImageAcquisitionReason } from "./image-preparation.js";
import { decodeBytes, decodeUndefined, finiteNonnegativeNumber } from "./decoders.js";
import { decodeFileMount, type FileMount } from "./userspace-files.js";
import { decodeCancel, decodeMessagePort, decodeRequestBase, type CancelRequest, type RequestBase } from "./request-base.js";
import { decodeRestoredSnapshot, decodeSnapshotId, decodeSnapshotRef, SNAPSHOT_KINDS, validateAppData, validateRestorePointName,
  type RestoredSnapshot, type SnapshotKind, type SnapshotRef } from "./snapshots.js";

export interface NativeCheckpointDestination {
  readonly manifestUrl: string;
  readonly trusted: { readonly keyId: string; readonly publicKey: Uint8Array };
}
export interface NativeCheckpointConfiguration { readonly mount: FileMount; readonly destination: NativeCheckpointDestination }
export interface NativeCheckpointSave { readonly snapshot: SnapshotRef; readonly pauseMilliseconds: number }
export interface NativeCheckpointOperations {
  readonly "cold-start": Operation<{readonly sourceId:string}, UserspaceWorkspaceStart>;
  readonly configure: Operation<NativeCheckpointConfiguration, undefined>;
  readonly capture: Operation<{ readonly kind: SnapshotKind; readonly label?: string }, NativeCheckpointSave>;
  readonly restore: Operation<{ readonly snapshot: SnapshotRef; readonly replacedId?: string; readonly startup?: true; readonly initialStart?: ShippedInstallIdentity }, RestoredSnapshot>;
  readonly dirty: Operation<undefined, boolean>;
  readonly "app-data": Operation<{ readonly data: Uint8Array | null }, undefined>;
  readonly "prepare-image": Operation<{ readonly reason?: ImageAcquisitionReason }, undefined>;
  readonly collect: Operation<undefined, undefined>;
  readonly flush: Operation<undefined, undefined>;
}
export type NativeCheckpointRequest = RequestBase & (
  | {readonly type:"cold-start";readonly sourceId:string}
  | ({ readonly type: "configure" } & NativeCheckpointConfiguration)
  | { readonly type: "capture"; readonly kind: SnapshotKind; readonly label?: string }
  | { readonly type: "restore"; readonly snapshot: SnapshotRef; readonly replacedId?: string; readonly startup?: true; readonly initialStart?: ShippedInstallIdentity }
  | { readonly type: "app-data"; readonly data: Uint8Array | null }
  | { readonly type: "prepare-image"; readonly reason?: ImageAcquisitionReason }
  | { readonly type: "dirty" | "collect" | "flush" }
);

export const nativeCheckpointResponseDecoders: OperationDecoders<NativeCheckpointOperations> = {
  "cold-start":decodeUserspaceWorkspaceStart, configure: decodeUndefined, capture: decodeNativeCheckpointSave, restore: decodeRestoredSnapshot,
  "prepare-image":decodeUndefined, dirty: value => boolean(value, "native checkpoint dirty state"), "app-data": decodeUndefined, collect: decodeUndefined, flush: decodeUndefined,
};

export function decodeNativeCheckpointConnection(value: unknown) {
  const message = record(value, "native checkpoint connection");
  exactKeys(message, ["version", "type", "port", "snapshotPort", "eventsPort"]);
  if (message["version"] !== PROTOCOL_VERSION || message["type"] !== "connect-checkpoints") invalid();
  return { version: PROTOCOL_VERSION, type: "connect-checkpoints", port: decodeMessagePort(message["port"], "native lifecycle port"),
    snapshotPort: decodeMessagePort(message["snapshotPort"], "native storage port"), eventsPort: decodeMessagePort(message["eventsPort"], "native checkpoint events") } as const;
}

export function decodeNativeCheckpointRequest(value: unknown): NativeCheckpointRequest | CancelRequest {
  const message = record(value, "native checkpoint request");
  if (message["type"] === "cancel") return decodeCancel(message);
  const base = decodeRequestBase(message), type = message["type"];
  switch (type) {
    case "cold-start":
      exactKeys(message,["id","version","type","sourceId"]);return {...base,type,sourceId:decodeSnapshotId(message["sourceId"])};
    case "configure":
      exactKeys(message, ["id", "version", "type", "mount", "destination"]);
      return { ...base, type, ...decodeNativeCheckpointConfiguration(message) };
    case "capture": {
      exactKeys(message, ["id", "version", "type", "kind"], ["label"]);
      const kind = SNAPSHOT_KINDS.find(kind => kind === message["kind"]);
      if (kind === undefined) invalid();
      return { ...base, type, kind, ...(message["label"] === undefined ? {} : { label: validateRestorePointName(message["label"]) }) };
    }
    case "restore":
      exactKeys(message, ["id", "version", "type", "snapshot"], ["replacedId", "startup", "initialStart"]);
      if(message["startup"]!==undefined&&message["startup"]!==true)throw new VMError("PROTOCOL_ERROR","Native startup disposition is invalid");
      return { ...base, type, snapshot: decodeSnapshotRef(message["snapshot"]),
        ...(message["initialStart"]===undefined?{}:{initialStart:decodeShippedInstallIdentity(message["initialStart"])}),
        ...(message["startup"]===undefined?{}:{startup:true as const}),
        ...(message["replacedId"] === undefined ? {} : { replacedId: decodeSnapshotId(message["replacedId"]) }) };
    case "app-data":
      exactKeys(message, ["id", "version", "type", "data"]);
      return { ...base, type, data: validateAppData(message["data"]) };
    case "prepare-image":
      exactKeys(message, ["id", "version", "type"], ["reason"]);
      return { ...base, type, reason: decodeImageAcquisitionReason(message["reason"]) };
    case "dirty": case "collect": case "flush":
      exactKeys(message, ["id", "version", "type"]); return { ...base, type };
    default: return invalid();
  }
}

export function decodeNativeCheckpointConfiguration(value: Readonly<Record<string, unknown>>): NativeCheckpointConfiguration {
  const destination = record(value["destination"], "native checkpoint destination");
  exactKeys(destination, ["manifestUrl", "trusted"]);
  const trusted = record(destination["trusted"], "native checkpoint signing key"); exactKeys(trusted, ["keyId", "publicKey"]);
  const publicKey = decodeBytes(trusted["publicKey"]);
  if (publicKey.length !== 32) invalid();
  return { mount: decodeFileMount(value["mount"]), destination: { manifestUrl: string(destination["manifestUrl"], "native manifest URL"),
    trusted: { keyId: string(trusted["keyId"], "native signing key id"), publicKey } } };
}
function decodeNativeCheckpointSave(value: unknown): NativeCheckpointSave {
  const saved = record(value, "native checkpoint result"); exactKeys(saved, ["snapshot", "pauseMilliseconds"]);
  return { snapshot: decodeSnapshotRef(saved["snapshot"]), pauseMilliseconds: finiteNonnegativeNumber(saved["pauseMilliseconds"], "native save pause") };
}
function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Native checkpoint lifecycle request is invalid"); }
