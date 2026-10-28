import {imagePublicKeyBytes} from "../../image.js";
import type {ManagedImageSnapshot} from "../managed-image.js";
import {decodeSHA256, type RuntimeMode} from "../../values.js";
import type {ShippedInstallIdentity, ShippedSource} from "../protocol.js";
import {shippedError, type ShippedExpectation} from "./snapshot-archive/shipped.js";

export interface PreparedShippedImage {
  readonly mode: RuntimeMode;
  readonly id: string;
  readonly version: string;
  readonly identity: string;
  readonly manifestSHA256?: string;
  readonly snapshots: readonly ManagedImageSnapshot[];
}
export function resolveShippedSource(
  source: ShippedSource,
  image: PreparedShippedImage,
  trusted: ShippedExpectation["trusted"],
): {readonly listing: ManagedImageSnapshot; readonly expectation: Pick<ShippedExpectation,"image" | "trusted">; readonly identity?: ShippedInstallIdentity} {
  const expectationImage = {mode:image.mode,id:image.id,version:image.version,identity:image.identity};
  if (source.kind === "listed") {
    const listing = image.snapshots.find(entry => entry.name === source.name);
    if (listing === undefined) throw shippedError("unavailable","The prepared image lists no such shipped start");
    return {listing,expectation:{image:expectationImage,trusted}};
  }
  const ref = source.reference;
  if (ref.mode !== image.mode || ref.imageManifestSHA256 !== image.manifestSHA256) {
    throw shippedError("incompatible","The prepared state belongs to a different verified image");
  }
  return {
    listing:{name:ref.name,bytes:ref.downloadBytes-ref.manifestBytes,manifest:{url:new URL(ref.manifestUrl),bytes:ref.manifestBytes,sha256:ref.manifestSHA256}},
    expectation:{image:expectationImage,trusted:{keyId:ref.trust.keyId,publicKey:imagePublicKeyBytes(ref.trust)}},
    identity:{mode:ref.mode,snapshotManifestSHA256:decodeSHA256(ref.manifestSHA256,"shipped digest"),imageManifestSHA256:decodeSHA256(ref.imageManifestSHA256,"image digest")},
  };
}
