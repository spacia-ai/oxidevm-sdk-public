import type { BootProgress } from "./contracts.js";
import { imagePublicKeyBytes, type ImageInfo, type ImageRef } from "./image.js";
import { fetchPinnedBytes } from "./engine-assets.js";
import { decodeManagedImageManifest, verifyManagedImageManifest } from "./runtime/managed-image.js";
import { decodeUserspaceRootfsManifest, verifyUserspaceRootfsManifest } from "./runtime/userspace-rootfs.js";
import { VMError } from "./runtime/errors.js";
import type { RuntimeMode } from "./values.js";

export async function verifyImage<M extends RuntimeMode>(image: ImageRef<M>, base: string, signal?: AbortSignal, progress?: (progress: BootProgress) => void): Promise<{ readonly info: ImageInfo & { readonly mode: M }; readonly memoryMiB: number; readonly maxProcesses?: number }> {
  const url = new URL(image.manifestUrl, base);
  const bytes = await fetchPinnedBytes(url, image.manifestSHA256, "image", signal, progress);
  let input: unknown;
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new VMError("PROTOCOL_ERROR", "image manifest must contain UTF-8 JSON"); }
  progress?.({ phase: "validate" });
  const trust = { keyId: image.trust.keyId, publicKey: imagePublicKeyBytes(image.trust) };
  const manifest = image.mode === "system" ? decodeManagedImageManifest(input, url) : decodeUserspaceRootfsManifest(input, url);
  if ("kind" in manifest) {
    // Retained starts accept only whole-manifest identities; refuse a legacy image before it is retained.
    if (manifest.schemaVersion < 5) throw new VMError("PROTOCOL_ERROR", "Userspace public images must authenticate the whole manifest; rebuild this image with `oxidevm image build`");
    await verifyUserspaceRootfsManifest(manifest, trust);
  } else {
    if (manifest.schemaVersion !== 9) throw new VMError("PROTOCOL_ERROR", "System public images must authenticate the whole manifest");
    await verifyManagedImageManifest(manifest, trust);
  }
  return {
    info: { id: manifest.id, version: manifest.version, mode: image.mode, manifestSHA256: image.manifestSHA256, cpuProfile: manifest.cpuProfile, signatureVerified: true, keyId: image.trust.keyId },
    memoryMiB: "memoryMiB" in manifest ? manifest.memoryMiB : manifest.resources?.memoryMiB ?? 1024,
    ...("kind" in manifest && manifest.resources?.maxProcesses !== undefined ? { maxProcesses: manifest.resources.maxProcesses } : {}),
  };
}
