import {defineImage, type TrustedImageKey} from "./image.js";
import {exactKeys, integer, record} from "./runtime/decode.js";
import {VMError} from "./runtime/errors.js";
import {decodeShippedName} from "./runtime/managed-start.js";
import type {RuntimeMode, SHA256} from "./values.js";
import {decodeSHA256} from "./values.js";

const shippedSnapshotRefBrand = Symbol("oxidevm.shipped-snapshot-ref");
const refs = new WeakSet<object>();

export interface ShippedSnapshotLocation<M extends RuntimeMode> {
  readonly mode: M;
  readonly name: string;
  readonly manifestUrl: string | URL;
  readonly manifestSHA256: string;
  readonly manifestBytes: number;
  readonly downloadBytes: number;
  readonly imageManifestSHA256: string;
  readonly trust: TrustedImageKey;
}
export interface ShippedSnapshotRef<M extends RuntimeMode>
  extends Omit<ShippedSnapshotLocation<M>, "manifestUrl" | "manifestSHA256" | "imageManifestSHA256"> {
  readonly [shippedSnapshotRefBrand]: M;
  readonly manifestUrl: string;
  readonly manifestSHA256: SHA256;
  readonly imageManifestSHA256: SHA256;
}

/** Pins independently signed state without browser access or downloads. */
export function defineShippedSnapshot<M extends RuntimeMode>(location: ShippedSnapshotLocation<M>): ShippedSnapshotRef<M> {
  try {
    const source = record(location, "shipped snapshot location");
    exactKeys(source, ["mode", "name", "manifestUrl", "manifestSHA256", "manifestBytes", "downloadBytes", "imageManifestSHA256", "trust"]);
    const image = defineImage({mode: location.mode, manifestUrl: location.manifestUrl, manifestSHA256: location.manifestSHA256, trust: location.trust});
    const name = decodeShippedName(source["name"]);
    if (name === undefined) throw new VMError("INVALID_ARGUMENT", "shipped snapshot name is required");
    const manifestBytes = integer(source["manifestBytes"], "manifestBytes", 1, 4 * 1024 ** 2 + 1024);
    const ref = Object.freeze({
      [shippedSnapshotRefBrand]: image.mode, mode: image.mode, name,
      manifestUrl: image.manifestUrl, manifestSHA256: image.manifestSHA256,
      trust: image.trust, manifestBytes,
      downloadBytes: integer(source["downloadBytes"], "downloadBytes", manifestBytes, 16 * 1024 ** 3),
      imageManifestSHA256: decodeSHA256(source["imageManifestSHA256"], "imageManifestSHA256"),
    });
    refs.add(ref);
    return ref;
  } catch (error) {
    if (error instanceof VMError && error.code === "PROTOCOL_ERROR") throw new VMError("INVALID_ARGUMENT", error.message);
    throw error;
  }
}

export function isShippedSnapshotRef<M extends RuntimeMode>(value: unknown, mode: M): value is ShippedSnapshotRef<M> {
  return typeof value === "object" && value !== null && refs.has(value) && "mode" in value && value.mode === mode;
}
