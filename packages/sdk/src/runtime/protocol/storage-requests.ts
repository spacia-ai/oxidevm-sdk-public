import {decodeSHA256} from "../../values.js";
import type { ImagePreparation } from "../../values.js";
import { decodeImagePreparation } from "./image-preparation.js";
import {decodeInspectStartImageFields,type InspectStartImageRequest} from "./start-image.js";
import { boolean, exactKeys, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { validateWorkspaceId } from "../workspace-path.js";
import { decodeBytes } from "./decoders.js";
import { decodeCancel, decodeRequestBase, decodeMessagePort, decodeDiskBridge, type RequestBase, type CancelRequest } from "./request-base.js";
import { decodeSnapshotId, decodeSnapshotCatalogRequest, isSnapshotCatalogType, decodeSnapshotMachine, type SnapshotCatalogRequest, type SnapshotMachine } from "./snapshots.js";
import { decodeSnapshotArchiveRequest, isSnapshotArchiveType, type SnapshotArchiveRequest } from "./snapshot-archive.js";
import { decodeWorkspacePublication, type WorkspacePublication } from "./workspace-publication.js";
import { MANAGED_BOOTS, type ManagedBoot } from "./storage.js";
import {decodeShippedInstallIdentity,type ShippedInstallIdentity} from "./shipped-source.js";
export type StorageRequest =
  | (RequestBase & { readonly type: "check-system-update"; readonly manifestUrl: string; readonly manifestSHA256?: string; readonly trustedKeyId?: string; readonly trustedPublicKey?: Uint8Array })
  | (RequestBase & { readonly type: "prepare-current-system-image" })
  | (RequestBase & {readonly type:"initial-start-state"})
  | (RequestBase & {readonly type:"initial-start-retire"})
  | (RequestBase & {readonly type:"initial-start-begin";readonly source:ShippedInstallIdentity})
  | (RequestBase & {readonly type:"abort-userspace-files";readonly sourceId:string})
  | (RequestBase & {readonly type:"current-userspace-image"|"current-userspace-rootfs"|"current-system-image"})
  | (RequestBase & {readonly type:"select-userspace-files";readonly boot:ManagedBoot;readonly rootTreeSha256:string;readonly rootPersistence:"ephemeral"|"persistent"})
  | (RequestBase & InspectStartImageRequest & {readonly type:"inspect-start-image"})
  | (RequestBase & { readonly type: "erase-local-data" })
  | (RequestBase & { readonly type: "check-userspace-update"; readonly manifestUrl:string; readonly manifestSHA256?:string; readonly trustedKeyId:string; readonly trustedPublicKey:Uint8Array })
  | (RequestBase & { readonly type: "commit-workspace-streams"; readonly publication: WorkspacePublication })
  | (RequestBase & SnapshotCatalogRequest)
  | (RequestBase & SnapshotArchiveRequest)
  | (RequestBase & {
      readonly type: "initialize";
      readonly workspaceId: string;
      readonly ephemeral?: boolean;
      readonly snapshotPort: InstanceType<typeof MessagePort>;
      readonly rootfsNetworkPort?: InstanceType<typeof MessagePort>;
      readonly userspaceStoragePort?: InstanceType<typeof MessagePort>;
      readonly diskBridge?: SharedArrayBuffer;
      readonly diskPort?: InstanceType<typeof MessagePort>;
      readonly machine?: SnapshotMachine;
    })
  | (RequestBase & {
      readonly type: "prepare-managed-image";
      readonly imagePreparation?: ImagePreparation;
      readonly manifestUrl: string;
      readonly manifestSHA256?: string;
      readonly trustedKeyId?: string;
      readonly trustedPublicKey?: Uint8Array;
      readonly boot?: ManagedBoot;
      readonly cachedOnly?: boolean;
    })
  | (RequestBase & {
      readonly type: "prepare-userspace-rootfs";
      readonly imagePreparation?: ImagePreparation;
      readonly boot?:ManagedBoot;
      readonly cachedOnly?: boolean;
      readonly manifestUrl: string;
      readonly manifestSHA256?: string;
      readonly trustedKeyId: string;
      readonly trustedPublicKey: Uint8Array;
    })
  | (RequestBase & { readonly type: "read-rootfs-file"; readonly path: string })
  | (RequestBase & { readonly type: "read-file"; readonly path: string })
  | (RequestBase & {
      readonly type: "write-file";
      readonly path: string;
      readonly data: Uint8Array;
    })
  | (RequestBase & { readonly type: "list"; readonly path: string })
  | (RequestBase & {
      readonly type: "remove";
      readonly path: string;
      readonly recursive: boolean;
    })
  | (RequestBase & {
      readonly type: "commit-workspace-snapshot";
      readonly workspaceBaseSha256: string;
      readonly data: Uint8Array;
    })
  | (RequestBase & {
      readonly type: "commit-workspace-delta";
      readonly workspaceBaseSha256: string;
      readonly data: Uint8Array;
    })
  | (RequestBase & {
      readonly type: "read-workspace-snapshot";
      readonly workspaceBaseSha256: string;
    })
  | (RequestBase & {
      readonly type: "read-workspace-delta";
      readonly workspaceBaseSha256: string;
    })
  | (RequestBase & { readonly type: "dispose" | "workspace-persistence" });

export type StorageIncoming = StorageRequest | CancelRequest;
function decodeManagedBoot(value: unknown): ManagedBoot {
  const boot = MANAGED_BOOTS.find((candidate) => candidate === value);
  if (boot === undefined) throw new VMError("PROTOCOL_ERROR", "managed image boot is invalid");
  return boot;
}

export function decodeStorageIncoming(value: unknown): StorageIncoming {
  const message = record(value, "storage request");
  const type = string(message["type"], "request type");
  if (type === "cancel") return decodeCancel(message);
  const base = decodeRequestBase(message);
  if (isSnapshotCatalogType(type)) return { ...base, ...decodeSnapshotCatalogRequest(message, type) };
  if (isSnapshotArchiveType(type)) return { ...base, ...decodeSnapshotArchiveRequest(message, type) };
  switch (type) {
    case "initial-start-state":
    case "initial-start-retire":
      exactKeys(message,["id","version","type"]);return {...base,type};
    case "initial-start-begin":
      exactKeys(message,["id","version","type","source"]);return {...base,type,source:decodeShippedInstallIdentity(message["source"])};
    case "current-system-image":
    case "prepare-current-system-image":
    case "current-userspace-rootfs":
    case "current-userspace-image":
      exactKeys(message,["id","version","type"]);return {...base,type};
    case "abort-userspace-files":
      exactKeys(message,["id","version","type","sourceId"]);return {...base,type,sourceId:decodeSnapshotId(message["sourceId"])};
    case "select-userspace-files": {
      exactKeys(message,["id","version","type","boot","rootTreeSha256","rootPersistence"]);
      const rootPersistence=message["rootPersistence"];if(rootPersistence!=="ephemeral"&&rootPersistence!=="persistent")throw new VMError("PROTOCOL_ERROR","native root persistence is invalid");
      return {...base,type,boot:decodeManagedBoot(message["boot"]),rootTreeSha256:decodeSHA256(message["rootTreeSha256"],"native root identity"),rootPersistence};
    }
    case "inspect-start-image":
      exactKeys(message,["id","version","type","workspaceId","mode","resume","manifestUrl","manifestSHA256","trustedKeyId","trustedPublicKey"]);
      return {...base,type,...decodeInspectStartImageFields(message),workspaceId:validateWorkspaceId(string(message["workspaceId"],"workspaceId"))};
    case "initialize":
      exactKeys(
        message,
        ["id", "version", "type", "workspaceId", "snapshotPort"],
        ["diskBridge", "diskPort", "rootfsNetworkPort", "userspaceStoragePort", "machine", "ephemeral"],
      );
      return {
        ...base,
        type,
        ...(message["ephemeral"] === undefined ? {} : { ephemeral: boolean(message["ephemeral"], "ephemeral workspace") }),
        workspaceId: validateWorkspaceId(
          string(message["workspaceId"], "workspaceId"),
        ),
        snapshotPort: decodeMessagePort(message["snapshotPort"], "snapshotPort"),
        ...(message["rootfsNetworkPort"] === undefined ? {} : { rootfsNetworkPort: decodeMessagePort(message["rootfsNetworkPort"], "rootfsNetworkPort") }),
        ...(message["userspaceStoragePort"] === undefined ? {} : { userspaceStoragePort: decodeMessagePort(message["userspaceStoragePort"], "userspaceStoragePort") }),
        ...(message["machine"] === undefined ? {} : { machine: decodeSnapshotMachine(message["machine"]) }),
        ...decodeDiskBridge(message),
      };
    case "prepare-managed-image":
      exactKeys(
        message,
        ["id", "version", "type", "manifestUrl"],
        ["trustedKeyId", "trustedPublicKey", "boot", "manifestSHA256", "cachedOnly", "imagePreparation"],
      );
      if (
        (message["trustedKeyId"] === undefined)
        !== (message["trustedPublicKey"] === undefined)
      ) {
        throw new VMError(
          "PROTOCOL_ERROR",
          "managed system AOT trust requires both key fields",
        );
      }
      return {
        ...base,
        type,
        manifestUrl: string(message["manifestUrl"], "manifestUrl"),
        ...(message["imagePreparation"] === undefined ? {} : { imagePreparation: decodeImagePreparation(message["imagePreparation"]) }),
        ...(message["cachedOnly"]===undefined?{}:{cachedOnly:boolean(message["cachedOnly"],"cachedOnly")}),
        ...(message["boot"]===undefined?{}:{boot:decodeManagedBoot(message["boot"])}),
        ...(message["manifestSHA256"] === undefined ? {} : { manifestSHA256: decodeManifestPin(message["manifestSHA256"]) }),
        ...(message["trustedKeyId"] === undefined
          ? {}
          : {
              trustedKeyId: string(message["trustedKeyId"], "trustedKeyId"),
              trustedPublicKey: decodeBytes(message["trustedPublicKey"]),
            }),
        ...(message["boot"] === undefined ? {} : { boot: decodeManagedBoot(message["boot"]) }),
      };
    case "check-system-update": {
      exactKeys(message,["id","version","type","manifestUrl"],["manifestSHA256","trustedKeyId","trustedPublicKey"]);
      if ((message["trustedKeyId"] === undefined) !== (message["trustedPublicKey"] === undefined)) throw new VMError("PROTOCOL_ERROR", "Image update trust requires both key fields");
      return {...base,type,manifestUrl:string(message["manifestUrl"],"manifestUrl"),
        ...(message["manifestSHA256"]===undefined?{}:{manifestSHA256:decodeManifestPin(message["manifestSHA256"])}),
        ...(message["trustedKeyId"]===undefined?{}:{trustedKeyId:string(message["trustedKeyId"],"trustedKeyId"),trustedPublicKey:decodeBytes(message["trustedPublicKey"])})};
    }
    case "check-userspace-update":
      exactKeys(message,["id","version","type","manifestUrl","trustedKeyId","trustedPublicKey"],["manifestSHA256"]);
      return {...base,type,manifestUrl:string(message["manifestUrl"],"manifestUrl"),trustedKeyId:string(message["trustedKeyId"],"trustedKeyId"),trustedPublicKey:decodeBytes(message["trustedPublicKey"]),
        ...(message["manifestSHA256"]===undefined?{}:{manifestSHA256:decodeManifestPin(message["manifestSHA256"])})};
    case "prepare-userspace-rootfs":
      exactKeys(message, ["id", "version", "type", "manifestUrl", "trustedKeyId", "trustedPublicKey"], ["manifestSHA256", "cachedOnly","boot","imagePreparation"]);
      return {
        ...base,
        type,
        manifestUrl: string(message["manifestUrl"], "manifestUrl"),
        ...(message["imagePreparation"] === undefined ? {} : { imagePreparation: decodeImagePreparation(message["imagePreparation"]) }),
        ...(message["cachedOnly"]===undefined?{}:{cachedOnly:boolean(message["cachedOnly"],"cachedOnly")}),
        ...(message["boot"]===undefined?{}:{boot:decodeManagedBoot(message["boot"])}),
        trustedKeyId: string(message["trustedKeyId"], "trustedKeyId"),
        ...(message["manifestSHA256"] === undefined ? {} : { manifestSHA256: decodeManifestPin(message["manifestSHA256"]) }),
        trustedPublicKey: decodeBytes(message["trustedPublicKey"]),
      };
    case "read-file":
    case "read-rootfs-file":
    case "list":
      exactKeys(message, ["id", "version", "type", "path"]);
      return {
        ...base,
        type,
        path: string(message["path"], "path"),
      };
    case "write-file":
      exactKeys(message, ["id", "version", "type", "path", "data"]);
      return {
        ...base,
        type,
        path: string(message["path"], "path"),
        data: decodeBytes(message["data"]),
      };
    case "remove":
      exactKeys(message, [
        "id",
        "version",
        "type",
        "path",
        "recursive",
      ]);
      return {
        ...base,
        type,
        path: string(message["path"], "path"),
        recursive: boolean(message["recursive"], "recursive"),
      };
    case "commit-workspace-streams":
      exactKeys(message, ["id", "version", "type", "publication"]);
      return { ...base, type, publication: decodeWorkspacePublication(message["publication"]) };
    case "commit-workspace-snapshot":
    case "commit-workspace-delta": {
      exactKeys(message, ["id", "version", "type", "workspaceBaseSha256", "data"]);
      const workspaceBaseSha256 = string(message["workspaceBaseSha256"], "workspace base SHA-256");
      if (!/^[0-9a-f]{64}$/u.test(workspaceBaseSha256)) {
        throw new VMError("PROTOCOL_ERROR", "workspace base SHA-256 is invalid");
      }
      return {
        ...base,
        type,
        workspaceBaseSha256,
        data: decodeBytes(message["data"]),
      };
    }
    case "read-workspace-snapshot":
    case "read-workspace-delta": {
      exactKeys(message, ["id", "version", "type", "workspaceBaseSha256"]);
      const workspaceBaseSha256 = string(message["workspaceBaseSha256"], "workspace base SHA-256");
      if (!/^[0-9a-f]{64}$/u.test(workspaceBaseSha256)) {
        throw new VMError("PROTOCOL_ERROR", "workspace base SHA-256 is invalid");
      }
      return { ...base, type, workspaceBaseSha256 };
    }
    case "erase-local-data":
    case "dispose":
    case "workspace-persistence":
      exactKeys(message, ["id", "version", "type"]);
      return { ...base, type };
    default:
      throw new VMError(
        "PROTOCOL_ERROR",
        `unknown storage operation ${type}`,
      );
  }
}

function decodeManifestPin(value: unknown): string {
  const digest = string(value, "manifest SHA256");
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new VMError("PROTOCOL_ERROR", "manifest SHA256 must be lowercase SHA256");
  return digest;
}
