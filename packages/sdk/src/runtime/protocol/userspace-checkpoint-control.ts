import {decodeShippedInstallIdentity,type ShippedInstallIdentity} from "./shipped-source.js";
import {VMError} from "../errors.js";
import { decodeImageAcquisitionReason, type ImageAcquisitionReason } from "./image-preparation.js";
import { decodeUserspaceWorkspaceStart, type UserspaceWorkspaceStart } from "./workspace-start.js";
import { exactKeys } from "../decode.js";
import type { Operation, OperationDecoders } from "./operations.js";
import { decodeUndefined } from "./decoders.js";
import { decodeNativeCheckpointConfiguration, type NativeCheckpointConfiguration } from "./userspace-checkpoints.js";
import { decodeMessagePort, type RequestBase } from "./request-base.js";
import { decodeRestoredSnapshot, decodeSnapshotId, decodeSnapshotRef, type RestoredSnapshot, type SnapshotRef } from "./snapshots.js";

export interface NativeCheckpointControlOperations {
  readonly "prepare-image": Operation<{ readonly reason?: ImageAcquisitionReason }, undefined>;
  readonly "start-userspace-cold": Operation<{readonly sourceId:string}, UserspaceWorkspaceStart>;
  readonly "attach-userspace": Operation<{ readonly port: MessagePort; readonly snapshotPort?: MessagePort }, undefined>;
  readonly "configure-userspace-checkpoints": Operation<NativeCheckpointConfiguration, undefined>;
  readonly "restore-userspace-checkpoint": Operation<{ readonly snapshot: SnapshotRef; readonly replacedId?: string; readonly startup?: true; readonly initialStart?: ShippedInstallIdentity }, RestoredSnapshot>;
  readonly "flush-userspace": Operation<undefined, undefined>;
}
export type NativeCheckpointControlRequest = RequestBase & (
  | { readonly type: "prepare-image"; readonly reason?: ImageAcquisitionReason }
  | {readonly type:"start-userspace-cold";readonly sourceId:string}
  | { readonly type: "attach-userspace"; readonly port: MessagePort; readonly snapshotPort?: MessagePort }
  | ({ readonly type: "configure-userspace-checkpoints" } & NativeCheckpointConfiguration)
  | { readonly type: "restore-userspace-checkpoint"; readonly snapshot: SnapshotRef; readonly replacedId?: string; readonly startup?: true; readonly initialStart?: ShippedInstallIdentity }
  | { readonly type: "flush-userspace" }
);
export function isNativeCheckpointControl(type: string): type is NativeCheckpointControlRequest["type"] {
  return type === "prepare-image" || type === "start-userspace-cold" || type === "attach-userspace" || type === "configure-userspace-checkpoints" || type === "restore-userspace-checkpoint" || type === "flush-userspace";
}
export function decodeNativeCheckpointControl(message: Readonly<Record<string, unknown>>, base: RequestBase,
  type: NativeCheckpointControlRequest["type"]): NativeCheckpointControlRequest {
  switch (type) {
    case "prepare-image":
      exactKeys(message, ["id", "version", "type"], ["reason"]);
      return { ...base, type, reason: decodeImageAcquisitionReason(message["reason"]) };
    case "start-userspace-cold":
      exactKeys(message,["id","version","type","sourceId"]);return {...base,type,sourceId:decodeSnapshotId(message["sourceId"])};
    case "attach-userspace":
      exactKeys(message, ["id", "version", "type", "port"], ["snapshotPort"]);
      return { ...base, type, port: decodeMessagePort(message["port"], "native process port"),
        ...(message["snapshotPort"] === undefined ? {} : { snapshotPort: decodeMessagePort(message["snapshotPort"], "native snapshot port") }) };
    case "configure-userspace-checkpoints":
      exactKeys(message, ["id", "version", "type", "mount", "destination"]);
      return { ...base, type, ...decodeNativeCheckpointConfiguration(message) };
    case "restore-userspace-checkpoint":
      exactKeys(message, ["id", "version", "type", "snapshot"], ["replacedId", "startup", "initialStart"]);
      if(message["startup"]!==undefined&&message["startup"]!==true)throw new VMError("PROTOCOL_ERROR","Native startup disposition is invalid");
      return { ...base, type, snapshot: decodeSnapshotRef(message["snapshot"]),
        ...(message["initialStart"]===undefined?{}:{initialStart:decodeShippedInstallIdentity(message["initialStart"])}),
        ...(message["startup"]===undefined?{}:{startup:true as const}),
        ...(message["replacedId"] === undefined ? {} : { replacedId: decodeSnapshotId(message["replacedId"]) }) };
    case "flush-userspace":
      exactKeys(message, ["id", "version", "type"]); return { ...base, type };
  }
}
export const nativeCheckpointControlDecoders: OperationDecoders<NativeCheckpointControlOperations> = {
  "prepare-image": decodeUndefined,
  "start-userspace-cold":decodeUserspaceWorkspaceStart, "attach-userspace": decodeUndefined, "configure-userspace-checkpoints": decodeUndefined,
  "restore-userspace-checkpoint": decodeRestoredSnapshot, "flush-userspace": decodeUndefined,
};
