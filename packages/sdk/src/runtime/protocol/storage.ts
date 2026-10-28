import {decodePreparedShippedListings,type PreparedShippedListing} from "./shipped-listings.js";
import {decodeImageInfo,type ImageInfo} from "../../image.js";
import { decodeManagedRuntimes, type ManagedRuntimes } from "../managed-runtimes.js";
import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeBytes } from "./decoders.js";
import { decodeUserspaceWorkspaceStart, type UserspaceWorkspaceStart } from "./workspace-start.js";

export interface WorkspaceEntry {
  readonly kind: "file" | "directory" | "symlink";
  readonly name: string;
  readonly path: string;
}

export const MANAGED_BOOTS = ["live", "pre-resume", "fresh-image", "update-image"] as const;
/**
 * The disk generation a managed image boots: the live one (which a resume replaces and a restart
 * keeps), the one the last resume replaced ("Restart instead", which can hold files newer than
 * the restore point), a new empty one (a reset), or the requested image's own one when the
 * workspace moves to it ("Update Linux"). Only a reset or an update moves a workspace to another
 * image; the other boots keep running the image its disk runs.
 */
export type ManagedBoot = (typeof MANAGED_BOOTS)[number];

export type PreparedImageIdentity = ImageInfo;

export interface PreparedManagedImage {
  readonly identity?: PreparedImageIdentity;
  readonly id: string;
  readonly version: string;
  readonly memoryMiB: number;
  readonly vcpus: 1 | 2 | 3 | 4;
  readonly workspaceBaseSha256?: string;
  readonly kernel: Uint8Array;
  readonly initrd?: Uint8Array;
  readonly commandLine: string;
  readonly diskBytes: number;
  readonly aot: PreparedSystemAot;
  readonly runtimes: ManagedRuntimes;
  /** The image the page asked for, when the workspace keeps running another until it updates. */
  readonly update?: { readonly id: string; readonly version: string };
}

export type PreparedSystemAot =
  | {
      readonly kind: "skipped";
      readonly reason: "no-catalog" | "untrusted-catalog" | "invalid-catalog" | "offline";
    }
  | {
      readonly kind: "ready";
      readonly catalogUrl: string;
      readonly catalogSha256: string;
      readonly machineSha256: string;
      readonly keyId: string;
      readonly signatureVerified: true;
      readonly coreRuntimeKey: string;
      readonly indexSha256: string;
      readonly index: Uint8Array;
      readonly packs: readonly {
        readonly url: string;
        readonly bytes: number;
        readonly sha256: string;
        readonly phase: "command" | "ready" | "first-request" | "warm-request" | "rebuild";
        readonly sourceSha256: string;
        readonly memberCount: number;
        readonly score: number;
      }[];
    };

export interface PreparedUserspaceRootfs {
  readonly update?:{readonly id:string;readonly version:string};
  readonly snapshots?:readonly PreparedShippedListing[];
  readonly identity?: PreparedImageIdentity;
  readonly id: string;
  readonly version: string;
  readonly cpuProfile: "x86-64-v2" | "x86-64-v3";
  readonly rootTreeSha256: string;
  readonly workspaceBaseSha256?: string;
  /** How the workspace's saved /workspace met this image; set when the image has a workspace base. */
  readonly workspace?: UserspaceWorkspaceStart;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly metadata: Uint8Array;
  readonly runtimes: {
    readonly muslLoader?: string;
    readonly glibcLoader?: string;
    readonly node?: string;
    readonly bun?: string;
    readonly supportingFiles: readonly string[];
  };
}


export function decodePreparedManagedImage(
  value: unknown,
): PreparedManagedImage {
  const image = record(value, "prepared managed image");
  exactKeys(
    image,
    [
      "id",
      "version",
      "memoryMiB",
      "vcpus",
      "kernel",
      "commandLine",
      "diskBytes",
      "aot",
      "runtimes",
    ],
    ["initrd", "workspaceBaseSha256", "update", "identity"],
  );
  const identity=image["identity"]===undefined?undefined:decodeImageInfo(image["identity"]);
  if(identity!==undefined&&(identity.mode!=="system"||identity.id!==image["id"]||identity.version!==image["version"])) throw new VMError("PROTOCOL_ERROR","prepared image identity is inconsistent");
  const update = image["update"] === undefined ? undefined : record(image["update"], "managed image update");
  if (update !== undefined) exactKeys(update, ["id", "version"]);

  return {
    ...(identity===undefined?{}:{identity}),
    ...(update===undefined?{}:{update:{id:string(update["id"],"rootfs update id"),version:string(update["version"],"rootfs update version")}}),
    id: string(image["id"], "managed image id"),
    version: string(image["version"], "managed image version"),
    memoryMiB: integer(image["memoryMiB"], "managed image memory", 256, 3072),
    vcpus: decodeVcpus(image["vcpus"]),
    ...(image["workspaceBaseSha256"] === undefined
      ? {}
      : { workspaceBaseSha256: decodeSha256(image["workspaceBaseSha256"], "workspace base hash") }),
    kernel: decodeBytes(image["kernel"]),
    ...(image["initrd"] === undefined
      ? {}
      : { initrd: decodeBytes(image["initrd"]) }),
    commandLine: string(image["commandLine"], "managed image command line"),
    diskBytes: integer(image["diskBytes"], "managed image disk bytes", 512),
    aot: decodePreparedSystemAot(image["aot"]),
    runtimes: decodeManagedRuntimes(image["runtimes"]),
    ...(update === undefined
      ? {}
      : { update: { id: string(update["id"], "managed image update id"), version: string(update["version"], "managed image update version") } }),
  };
}

export function decodePreparedSystemAot(value: unknown): PreparedSystemAot {
  const aot = record(value, "prepared system AOT");
  const kind = string(aot["kind"], "prepared system AOT kind");
  if (kind === "skipped") {
    exactKeys(aot, ["kind", "reason"]);
    const reason = string(aot["reason"], "prepared system AOT skip reason");
    if (
      reason !== "no-catalog"
      && reason !== "untrusted-catalog"
      && reason !== "invalid-catalog"
      && reason !== "offline"
    ) {
      throw new VMError("PROTOCOL_ERROR", "prepared system AOT skip reason is invalid");
    }
    return { kind, reason };
  }
  if (kind !== "ready") {
    throw new VMError("PROTOCOL_ERROR", "prepared system AOT kind is invalid");
  }
  exactKeys(aot, [
    "kind", "catalogUrl", "catalogSha256", "machineSha256", "keyId",
    "signatureVerified", "coreRuntimeKey", "indexSha256", "index", "packs",
  ]);
  if (aot["signatureVerified"] !== true || !Array.isArray(aot["packs"])) {
    throw new VMError("PROTOCOL_ERROR", "prepared system AOT proof is invalid");
  }
  return {
    kind,
    catalogUrl: string(aot["catalogUrl"], "prepared system AOT catalog URL"),
    catalogSha256: decodeSha256(aot["catalogSha256"], "prepared system AOT catalog hash"),
    machineSha256: decodeSha256(aot["machineSha256"], "prepared system AOT machine hash"),
    keyId: string(aot["keyId"], "prepared system AOT key ID"),
    signatureVerified: true,
    coreRuntimeKey: decodeSha256(
      aot["coreRuntimeKey"],
      "prepared system AOT core runtime key",
    ),
    indexSha256: decodeSha256(aot["indexSha256"], "prepared system AOT index hash"),
    index: decodeBytes(aot["index"]),
    packs: aot["packs"].map((value, index) => decodePreparedSystemAotPack(value, index)),
  };
}

function decodePreparedSystemAotPack(
  value: unknown,
  index: number,
): Extract<PreparedSystemAot, { readonly kind: "ready" }>["packs"][number] {
  const label = `prepared system AOT packs[${index}]`;
  const pack = record(value, label);
  exactKeys(pack, [
    "url", "bytes", "sha256", "phase", "sourceSha256", "memberCount", "score",
  ]);
  const phase = string(pack["phase"], `${label}.phase`);
  if (
    phase !== "command"
    && phase !== "ready"
    && phase !== "first-request"
    && phase !== "warm-request"
    && phase !== "rebuild"
  ) {
    throw new VMError("PROTOCOL_ERROR", `${label}.phase is invalid`);
  }
  return {
    url: string(pack["url"], `${label}.url`),
    bytes: integer(pack["bytes"], `${label}.bytes`, 1, 4 * 1024 * 1024),
    sha256: decodeSha256(pack["sha256"], `${label}.sha256`),
    phase,
    sourceSha256: decodeSha256(pack["sourceSha256"], `${label}.sourceSha256`),
    memberCount: integer(pack["memberCount"], `${label}.memberCount`, 1, 256),
    score: decodeNonnegativeNumber(pack["score"], `${label}.score`),
  };
}

function decodeNonnegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new VMError("PROTOCOL_ERROR", `${label} must be a finite nonnegative number`);
  }
  return value;
}

export function decodePreparedUserspaceRootfs(value: unknown): PreparedUserspaceRootfs {
  const rootfs = record(value, "prepared Userspace rootfs");
  exactKeys(rootfs, ["id", "version", "cpuProfile", "rootTreeSha256", "fileCount", "totalBytes", "metadata", "runtimes"], ["workspaceBaseSha256", "workspace", "identity", "snapshots", "update"]);
  if (rootfs["workspace"] !== undefined && rootfs["workspaceBaseSha256"] === undefined) {
    throw new VMError("PROTOCOL_ERROR", "prepared workspace details require the verified workspace base");
  }
  const update=rootfs["update"]===undefined?undefined:record(rootfs["update"],"rootfs image update");
  if(update!==undefined)exactKeys(update,["id","version"]);
  const identity=rootfs["identity"]===undefined?undefined:decodeImageInfo(rootfs["identity"]);
  if(identity!==undefined&&(identity.mode!=="userspace"||identity.id!==rootfs["id"]||identity.version!==rootfs["version"]||identity.cpuProfile!==rootfs["cpuProfile"])) throw new VMError("PROTOCOL_ERROR","prepared rootfs identity is inconsistent");
  const cpuProfile = string(rootfs["cpuProfile"], "rootfs CPU profile");
  if (cpuProfile !== "x86-64-v2" && cpuProfile !== "x86-64-v3") {
    throw new VMError("PROTOCOL_ERROR", "rootfs CPU profile is invalid");
  }
  const hash = string(rootfs["rootTreeSha256"], "rootfs tree hash");
  if (!/^[0-9a-f]{64}$/u.test(hash)) throw new VMError("PROTOCOL_ERROR", "rootfs tree hash is invalid");
  const runtimes = record(rootfs["runtimes"], "rootfs runtimes");
  exactKeys(runtimes, ["supportingFiles"], ["muslLoader", "glibcLoader", "node", "bun"]);
  if (!Array.isArray(runtimes["supportingFiles"])) {
    throw new VMError("PROTOCOL_ERROR", "rootfs supporting files must be an array");
  }
  return {
    ...(identity===undefined?{}:{identity}),
    ...(update===undefined?{}:{update:{id:string(update["id"],"rootfs update id"),version:string(update["version"],"rootfs update version")}}),
    id: string(rootfs["id"], "rootfs id"),
    version: string(rootfs["version"], "rootfs version"),
    cpuProfile,
    rootTreeSha256: hash,
    ...(rootfs["snapshots"]===undefined?{}:{snapshots:decodePreparedShippedListings(rootfs["snapshots"])}),
    ...(rootfs["workspaceBaseSha256"] === undefined
      ? {}
      : { workspaceBaseSha256: decodeSha256(rootfs["workspaceBaseSha256"], "workspace base hash") }),
    ...(rootfs["workspace"] === undefined ? {} : { workspace: decodeUserspaceWorkspaceStart(rootfs["workspace"]) }),
    fileCount: integer(rootfs["fileCount"], "rootfs file count", 0, 262_144),
    totalBytes: integer(rootfs["totalBytes"], "rootfs bytes", 0, 8 * 1024 * 1024 * 1024),
    metadata: decodeBytes(rootfs["metadata"]),
    runtimes: {
      ...Object.fromEntries(Object.entries(runtimes).filter(([key]) => key !== "supportingFiles").map(([key, item]) => [key, string(item, `runtimes.${key}`)])),
      supportingFiles: runtimes["supportingFiles"].map((item, index) => string(item, `runtimes.supportingFiles[${index}]`)),
    },
  };
}

function decodeSha256(value: unknown, name: string): string {
  const hash = string(value, name);
  if (!/^[0-9a-f]{64}$/u.test(hash)) throw new VMError("PROTOCOL_ERROR", `${name} is invalid`);
  return hash;
}

function decodeVcpus(value: unknown): 1 | 2 | 3 | 4 {
  const vcpus = integer(value, "managed image vcpus", 1, 4);
  if (vcpus === 1 || vcpus === 2 || vcpus === 3 || vcpus === 4) return vcpus;
  throw new VMError("PROTOCOL_ERROR", "managed image vcpus are invalid");
}

export function decodeWorkspaceEntries(value: unknown): WorkspaceEntry[] {
  if (!Array.isArray(value)) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "workspace entries must be an array",
    );
  }
  return value.map((entryValue) => {
    const entry = record(entryValue, "workspace entry");
    exactKeys(entry, ["kind", "name", "path"]);
    const kind = string(entry["kind"], "workspace entry kind");
    if (kind !== "file" && kind !== "directory" && kind !== "symlink") {
      throw new VMError(
        "PROTOCOL_ERROR",
        "workspace entry kind is invalid",
      );
    }
    return {
      kind,
      name: string(entry["name"], "workspace entry name"),
      path: string(entry["path"], "workspace entry path"),
    };
  });
}
