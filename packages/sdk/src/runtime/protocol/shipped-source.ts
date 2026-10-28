import {defineShippedSnapshot, isShippedSnapshotRef, type ShippedSnapshotRef, type ShippedSnapshotLocation} from "../../shipped-snapshot.js";
import {decodeTrustedImageKey} from "../../image.js";
import {decodeSHA256, type RuntimeMode, type SHA256} from "../../values.js";
import {exactKeys, integer, record, string} from "../decode.js";
import {VMError} from "../errors.js";
import {decodeShippedName} from "../managed-start.js";

export interface ShippedInstallIdentity {
  readonly mode: RuntimeMode;
  readonly snapshotManifestSHA256: SHA256;
  readonly imageManifestSHA256: SHA256;
}
export interface SerializedShippedSnapshotRef extends Omit<ShippedSnapshotLocation<RuntimeMode>, "manifestUrl"> {readonly manifestUrl: string}
export type ShippedSource = {readonly kind:"listed"; readonly name:string} | {readonly kind:"reference"; readonly reference:SerializedShippedSnapshotRef};

export function serializeShippedSnapshot(ref: ShippedSnapshotRef<RuntimeMode>, page?: string): SerializedShippedSnapshotRef {
  return {mode:ref.mode,name:ref.name,manifestUrl:page === undefined ? ref.manifestUrl : new URL(ref.manifestUrl,page).href,
    manifestSHA256:ref.manifestSHA256,manifestBytes:ref.manifestBytes,downloadBytes:ref.downloadBytes,imageManifestSHA256:ref.imageManifestSHA256,trust:{...ref.trust}};
}
export function decodeSerializedShippedSnapshot(value: unknown): ShippedSnapshotRef<RuntimeMode> {
  const ref = record(value,"shipped reference");
  exactKeys(ref,["mode","name","manifestUrl","manifestSHA256","manifestBytes","downloadBytes","imageManifestSHA256","trust"]);
  const mode = ref["mode"];
  if (mode !== "system" && mode !== "userspace") throw new VMError("PROTOCOL_ERROR","shipped reference mode is invalid");
  return defineShippedSnapshot({mode,name:string(ref["name"],"shipped name"),manifestUrl:string(ref["manifestUrl"],"shipped URL"),
    manifestSHA256:string(ref["manifestSHA256"],"shipped digest"),imageManifestSHA256:string(ref["imageManifestSHA256"],"image digest"),
    manifestBytes:integer(ref["manifestBytes"],"manifest bytes",1),downloadBytes:integer(ref["downloadBytes"],"download bytes",1),trust:decodeTrustedImageKey(ref["trust"])});
}
export function decodeShippedSource(value: unknown): ShippedSource {
  const source = record(value,"shipped source");
  if (source["kind"] === "listed") {
    exactKeys(source,["kind","name"]);
    const name = decodeShippedName(source["name"]);
    if (name === undefined) throw new VMError("PROTOCOL_ERROR","shipped source name is required");
    return {kind:"listed",name};
  }
  exactKeys(source,["kind","reference"]);
  if (source["kind"] !== "reference") throw new VMError("PROTOCOL_ERROR","shipped source kind is invalid");
  return {kind:"reference",reference:serializeShippedSnapshot(decodeSerializedShippedSnapshot(source["reference"]))};
}
export function decodeShippedInstallIdentity(value: unknown): ShippedInstallIdentity {
  const source = record(value,"shipped identity");
  exactKeys(source,["mode","snapshotManifestSHA256","imageManifestSHA256"]);
  const mode = source["mode"];
  if (mode !== "system" && mode !== "userspace") throw new VMError("PROTOCOL_ERROR","shipped identity mode is invalid");
  return {mode,snapshotManifestSHA256:decodeSHA256(source["snapshotManifestSHA256"],"snapshot digest"),imageManifestSHA256:decodeSHA256(source["imageManifestSHA256"],"image digest")};
}
export function sameShippedIdentity(left: ShippedInstallIdentity, right: ShippedInstallIdentity): boolean {
  return left.mode === right.mode && left.snapshotManifestSHA256 === right.snapshotManifestSHA256 && left.imageManifestSHA256 === right.imageManifestSHA256;
}
export function bootShippedSource(value: unknown, mode: RuntimeMode, page: string): ShippedSource | undefined {
  if (isShippedSnapshotRef(value,mode)) return {kind:"reference",reference:serializeShippedSnapshot(value,page)};
  const name = decodeShippedName(value);
  return name === undefined ? undefined : {kind:"listed",name};
}
