import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { defineImage, imagePublicKeyBytes } from "../image.js";
import type { ImageRef, TrustedImageKey } from "../image.js";
import type { RuntimeMode } from "../values.js";
import { exactKeys, record, string } from "../runtime/decode.js";
import { decodeUserspaceRootfsManifest, verifyUserspaceRootfsManifest, MAX_ROOTFS_METADATA_BYTES } from "../runtime/userspace-rootfs.js";
import type { UserspaceRootfsManifest } from "../runtime/userspace-rootfs.js";
import { decodeManagedImageManifest, managedImageIdentityBytes, verifyManagedImageManifest } from "../runtime/managed-image.js";
import type { ManagedImageManifest } from "../runtime/managed-image.js";
import { verifyShippedManifest } from "../runtime/workers/snapshot-archive/shipped.js";
import { USERSPACE_SNAPSHOT_SCHEMA } from "../runtime/workers/snapshot-manifest.js";
import { VMError } from "../runtime/errors.js";
import { hash } from "./files.js";
import type { ImageInspection } from "./contracts.js";
import { abortIfRequested } from "./tools.js";
import { artifactRelativePath, decodeBundleJSON, readBundleFile, verifyBundleArtifact } from "./bundle-files.js";
import { decodeImageDistribution } from "./reports.js";
import { readDistributionClosure } from "./distribution-closure.js";
import { verifyProvenanceLock } from "./provenance-lock.js";

export interface ReadImageBundle {
  readonly bundle: string;
  readonly image: ImageRef<RuntimeMode>;
  readonly base: URL;
  readonly manifest: UserspaceRootfsManifest | ManagedImageManifest;
  readonly manifestBytes: Uint8Array<ArrayBuffer>;
  readonly manifestValue: unknown;
}

/** This reader accepts exactly one lock format. Its version is checked before the field set, so a bundle from an older SDK gets the version error rather than an unrelated field error. */
function requireLockVersion(lock: Readonly<Record<string, unknown>>): void {
  const found = lock["schemaVersion"];
  if (found === 2) return;
  const described = typeof found === "number" ? `${found}` : `(a ${typeof found} value)`;
  throw new VMError("PROTOCOL_ERROR", `unsupported image lock version ${described}: this image was built by an older SDK; update the SDK or rebuild the image`, { reason: "image-lock-version", found: typeof found === "number" ? found : null, supported: 2 });
}

export async function readImageBundle(bundleDir: string, trust?: TrustedImageKey, signal?: AbortSignal): Promise<ReadImageBundle> {
  abortIfRequested(signal); const bundle = resolve(bundleDir);
  const lock = record(decodeBundleJSON(await readBundleFile(bundle, "image.lock.json", 1024 ** 2, signal)), "image lock");
  requireLockVersion(lock);
  exactKeys(lock, ["schemaVersion", "mode", "id", "version", "manifestUrl", "manifestSHA256", "trust", "distribution", "smokeTest", "sourceIdentity"], ["sourceDateEpoch", "buildInputs"]);
  decodeImageDistribution(lock["distribution"]);
  const mode = lock["mode"];
  if (mode !== "system" && mode !== "userspace") throw new VMError("PROTOCOL_ERROR", "invalid image mode");
  const claimed = record(lock["trust"], "author trust");
  exactKeys(claimed, ["algorithm", "keyId", "publicKey"]);
  if (claimed["algorithm"] !== "Ed25519") throw new VMError("PROTOCOL_ERROR", "invalid image trust algorithm");
  const image = defineImage({ mode, manifestUrl: string(lock["manifestUrl"], "manifest URL"), manifestSHA256: string(lock["manifestSHA256"], "manifest digest"), trust: trust ?? { algorithm: "Ed25519", keyId: string(claimed["keyId"], "key ID"), publicKey: string(claimed["publicKey"], "SPKI") } });
  const manifestBytes = await readBundleFile(bundle, "manifest.json", mode === "userspace" ? MAX_ROOTFS_METADATA_BYTES : 16 * 1024 ** 2, signal);
  if (hash(manifestBytes) !== image.manifestSHA256) throw new VMError("PROTOCOL_ERROR", "manifest digest mismatch");
  const base = new URL(image.manifestUrl, "https://image.invalid"); const manifestValue = decodeBundleJSON(manifestBytes);
  const manifest = mode === "userspace" ? decodeUserspaceRootfsManifest(manifestValue, base) : decodeManagedImageManifest(manifestValue, base);
  if (manifest.id !== lock["id"] || manifest.version !== lock["version"] || ("entries" in manifest ? manifest.schemaVersion !== 5 && manifest.schemaVersion !== 6 && manifest.schemaVersion !== 7 && manifest.schemaVersion !== 8 : manifest.schemaVersion !== 9)) throw new VMError("PROTOCOL_ERROR", "image lock disagrees with its whole-image manifest");
  if (lock["sourceDateEpoch"] !== undefined && lock["sourceDateEpoch"] !== manifest.sourceDateEpoch) throw new VMError("PROTOCOL_ERROR", "locked build epoch differs from its signed manifest");
  if (trust !== undefined) {
    const anchor = { keyId: trust.keyId, publicKey: imagePublicKeyBytes(trust) };
    if ("entries" in manifest) await verifyUserspaceRootfsManifest(manifest, anchor); else await verifyManagedImageManifest(manifest, anchor);
  }
  const read = { bundle, image, base, manifest, manifestBytes, manifestValue };
  await verifyProvenanceLock(read, lock, signal);
  return read;
}

export async function bundleReference(bundle: string, trust: TrustedImageKey): Promise<ImageRef<RuntimeMode>> { return (await readImageBundle(bundle, trust)).image; }

export function verifyDecodedGzip(encoded: Uint8Array, expected: { readonly bytes: number; readonly sha256: string }): Uint8Array {
  let decoded: Uint8Array;
  try { decoded = gunzipSync(encoded, { maxOutputLength: Math.max(1, expected.bytes) }); }
  catch { throw new VMError("PROTOCOL_ERROR", "compressed artifact is invalid or exceeds its decoded bound"); }
  if (decoded.byteLength !== expected.bytes || hash(decoded) !== expected.sha256) throw new VMError("PROTOCOL_ERROR", "compressed artifact decoded identity mismatch");
  return decoded;
}

export interface VerifiedBundleFile { readonly relative: string; readonly bytes: number; readonly sha256: string }
export interface InspectedImageFiles { readonly inspection: ImageInspection; readonly read: ReadImageBundle; readonly files: readonly VerifiedBundleFile[] }

/** The same verified closure serves inspection and installation. Unreferenced author files never ship. */
export async function inspectImageFiles(bundleDir: string, options: { readonly trust?: TrustedImageKey; readonly signal?: AbortSignal } = {}): Promise<InspectedImageFiles> {
  const read = await readImageBundle(bundleDir, options.trust, options.signal);
  const { bundle, base, manifest, image } = read; const provenance = manifest.provenance;
  if (provenance === undefined) throw new VMError("PROTOCOL_ERROR", "image has no whole-image provenance");
  const evidence = [provenance.sbom, provenance.notices, provenance.correspondingSources, provenance.reproducibility];
  const closure = await readDistributionClosure(read, options.signal);
  const additional = closure?.artifacts ?? [];
  const artifacts = "entries" in manifest ? [...manifest.blobs, ...(manifest.packs?.artifacts.map(pack => ({ url: pack.url, sha256: pack.encodedSha256, bytes: pack.encodedBytes })) ?? []), ...evidence, ...additional] : [manifest.kernel, ...(manifest.initrd === undefined ? [] : [manifest.initrd]), ...(manifest.aot === undefined ? [] : [manifest.aot]), ...manifest.disk.chunks.map(chunk => ({ url: chunk.url, sha256: chunk.encodedSha256, bytes: chunk.encodedBytes })), ...evidence, ...additional];
  const verified = new Map<string, { readonly bytes: number; readonly sha256: string }>(); let total = 0;
  const files = new Map<string, VerifiedBundleFile>();
  const remember = (relative: string, bytes: number, sha256: string) => { files.set(relative, { relative, bytes, sha256 }); };
  remember("manifest.json", read.manifestBytes.length, hash(read.manifestBytes));
  const lockBytes = await readBundleFile(bundle, "image.lock.json", 1024 ** 2, options.signal);
  remember("image.lock.json", lockBytes.length, hash(lockBytes));
  for (const artifact of artifacts) {
    const previous = verified.get(artifact.url.href);
    if (previous !== undefined) { if (previous.bytes !== artifact.bytes || previous.sha256 !== artifact.sha256) throw new VMError("PROTOCOL_ERROR", "artifact URL has conflicting identities"); continue; }
    await verifyBundleArtifact(bundle, base, artifact, options.signal); verified.set(artifact.url.href, artifact); total += artifact.bytes;
    remember(artifactRelativePath(base, artifact.url), artifact.bytes, artifact.sha256);
  }
  if ("entries" in manifest && manifest.packs !== undefined) {
    for (const artifact of manifest.packs.artifacts) {
      const chunk = manifest.packs.index.chunks.find(chunk => chunk.sha256 === artifact.sha256);
      if (chunk === undefined) throw new VMError("PROTOCOL_ERROR", "Pack has no decoded identity");
      verifyDecodedGzip(await readBundleFile(bundle, artifactRelativePath(base, artifact.url), artifact.encodedBytes, options.signal), chunk);
    }
  }
  if (!("entries" in manifest)) {
    const decoded = new Set<string>();
    for (const chunk of manifest.disk.chunks) {
      const key = `${chunk.url.href}:${String(chunk.bytes)}:${chunk.sha256}`;
      if (decoded.has(key)) continue;
      verifyDecodedGzip(await readBundleFile(bundle, artifactRelativePath(base, chunk.url), chunk.encodedBytes, options.signal), chunk); decoded.add(key);
    }
  }
    for (const snapshot of manifest.snapshots ?? []) {
      if (options.trust === undefined) throw new VMError("PERMISSION_DENIED", "inspection of shipped snapshots requires explicit author trust");
      await verifyBundleArtifact(bundle, base, snapshot.manifest, options.signal);
      remember(artifactRelativePath(base, snapshot.manifest.url), snapshot.manifest.bytes, snapshot.manifest.sha256);
      const signed = await verifyShippedManifest(await readBundleFile(bundle, artifactRelativePath(base, snapshot.manifest.url), snapshot.manifest.bytes, options.signal), {
        name: snapshot.name, trusted: { keyId: options.trust.keyId, publicKey: imagePublicKeyBytes(options.trust) },
        image: {mode:image.mode, id: manifest.id, version: manifest.version, identity: "entries" in manifest?manifest.rootTreeSha256:hash(managedImageIdentityBytes(read.manifestValue, new TextDecoder().decode(read.manifestBytes), manifest)) }, nowUnixMs: Date.now(),
      });
      let stored = snapshot.manifest.bytes;
      for (const object of signed.objects) {
        const url = new URL(`chunks/${object.sha256}.gz`, snapshot.manifest.url);
        const encoded = await readBundleFile(bundle, artifactRelativePath(base, url), object.bytes + 65536, options.signal);
        const decoded=verifyDecodedGzip(encoded, object);
        if(signed.snapshot.schema===USERSPACE_SNAPSHOT_SCHEMA&&object.sha256===signed.snapshot.rootfs.manifest.sha256) {
          const source=decodeUserspaceRootfsManifest(decodeBundleJSON(decoded),base);
          await verifyUserspaceRootfsManifest(source,{keyId:options.trust.keyId,publicKey:imagePublicKeyBytes(options.trust)});
          const root=signed.snapshot.rootfs;
          if(source.rootTreeSha256!==root.rootTreeSha256||source.id!==root.image.id||source.version!==root.image.version) throw new VMError("PROTOCOL_ERROR","native shipped start source differs from its signed image identity");
        }
        stored += encoded.length;
        remember(artifactRelativePath(base, url), encoded.length, hash(encoded));
      }
      if (stored !== snapshot.bytes) throw new VMError("PROTOCOL_ERROR", "shipped snapshot byte count differs from its signed declaration");
      total += stored;
    }
  return { read, files: [...files.values()], inspection: { mode: image.mode, id: manifest.id, version: manifest.version, manifestSHA256: image.manifestSHA256, artifactCount: verified.size + (manifest.snapshots ?? []).length, artifactBytes: total,
    authentication: options.trust === undefined ? { kind: "unverified", keyId: provenance.keyId } : { kind: "verified", keyId: options.trust.keyId } } };
}

export async function inspectImage(bundleDir: string, options: { readonly trust?: TrustedImageKey; readonly signal?: AbortSignal } = {}): Promise<ImageInspection> {
  return (await inspectImageFiles(bundleDir, options)).inspection;
}
