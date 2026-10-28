import {decodeSHA256} from "../../values.js";
import { VMError } from "../errors.js";
import {
  decodeAotCatalog,
  verifyAotCatalog,
  type TrustedAotKey,
} from "../aot-catalog.js";
import {
  managedBaseCacheEntryIsStale,
  managedBaseIsComplete,
  managedBaseMarker,
} from "../managed-disk-state.js";
import {
  decodeManagedImageManifest,
  managedImageIdentityBytes,
  managedImageUrl,
  verifyManagedImageManifest,
  type ManagedImageArtifact,
  type ManagedImageManifest,
  type ManagedImageSnapshot,
} from "../managed-image.js";
import type { ManagedBoot, PreparedManagedImage } from "../protocol.js";
import type { ManagedBases } from "./managed-base.js";
import { ManagedDisk } from "./managed-disk.js";
import { removeIfPresent } from "./managed-disk-files.js";
import { generationFor, liveImage, managedImageStem, type ManagedImageRef } from "./managed-disk-head.js";
import {
  baseIsKept,
  keptBootAsset,
  keptImageFor,
  keptImageNamed,
  keptImageByManifest,
  type PinnedImage,
  pinManagedImage,
  pinnedStems,
} from "./managed-image-pins.js";
import { sha256Hex } from "./snapshot-content.js";
import { installManagedBase } from "./managed-base-installation.js";
import { writeOpfsFile } from "./snapshot-objects.js";
import { fetchVerified, fetchVerifiedChunk, readManagedBody, assertManagedImageActive } from "./managed-image-fetch.js";

const MAX_BOOT_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_INDEX_BYTES = 128 * 1024 * 1024;

/** Repair only the active immutable cache; keep its disk generation and guest attachments open. */
export async function prepareCurrentManagedImage(images: FileSystemDirectoryHandle, workspaceId: string,
  ref: ManagedImageRef, trusted?: TrustedAotKey, signal?: AbortSignal, bases?: ManagedBases): Promise<void> {
  signal?.throwIfAborted();
  const kept = await keptImageNamed(images, workspaceId, ref.identity);
  if (kept === undefined) throw new VMError("STORAGE_NOT_FOUND", "The active image manifest is not cached", { reason: "image-not-cached" });
  await authenticateKept(kept, trusted);
  const kernel = await keptOrFetched(images, managedImageStem(ref), "kernel", kept.manifest.kernel, signal);
  const initrd = kept.manifest.initrd === undefined ? undefined : await keptOrFetched(images, managedImageStem(ref), "initrd", kept.manifest.initrd, signal);
  signal?.throwIfAborted();
  await prepareBaseDisk(images, kept.manifest, ref, signal, true, bases);
  signal?.throwIfAborted();
  await pinManagedImage(images, workspaceId, { ref, url: kept.url, manifestText: kept.manifestText, kernel,
    ...(initrd === undefined ? {} : { initrd }) });
}

export interface PreparedManagedDisk {
  readonly image: PreparedManagedImage;
  readonly disk: ManagedDisk;
  /** The shipped restore points the profile lists (schema 8). */
  readonly snapshots: readonly ManagedImageSnapshot[];
}

/** Where a managed disk lives: the origin's image cache and the workspace that boots it. */
export interface ManagedDiskStorage {
  readonly oxidevm: FileSystemDirectoryHandle;
  readonly workspace: FileSystemDirectoryHandle;
  readonly workspaceId: string;
  readonly bases: ManagedBases;
}

/**
 * Prepares `manifestHref`'s image and opens the disk generation `boot` selects. A kernel or
 * initrd this browser keeps for the image is not downloaded again. When the network cannot be
 * reached, the image the workspace keeps for that manifest (the version its disk runs) boots
 * offline, without AOT code. When the workspace's disk runs another image, a live boot or a
 * restart keeps running that kept image and names the requested one as an update; only an update
 * or a reset moves the workspace (ADR 0014). `release` must close the disk running now; it is
 * called only once the image is ready, just before the generation opens, which may be the same one.
 */
export async function prepareManagedDisk(
  storage: ManagedDiskStorage,
  manifestHref: string,
  trustedAotKey: TrustedAotKey | undefined,
  boot: ManagedBoot,
  release: () => void,
  policy: {readonly manifestSHA256?:string;readonly cachedOnly?:boolean;readonly imagePreparation?:"on-demand"|"before-ready";readonly signal?:AbortSignal} = {},
): Promise<PreparedManagedDisk> {
  const signal = policy.signal;
  assertManagedImageActive(signal);
  const manifestSHA256=policy.manifestSHA256;
  const manifestUrl = managedImageUrl(manifestHref);
  const images = await storage.oxidevm.getDirectoryHandle("managed-images", { create: true });
  if(policy.cachedOnly===true) {
    if(manifestSHA256===undefined) throw new VMError("PROTOCOL_ERROR","cached public startup requires an exact manifest pin");
    return prepareKeptImage(storage,images,manifestUrl,boot,release,{trustedKey:trustedAotKey,manifestSHA256,signal});
  }
  if (policy.imagePreparation === "before-ready" && (boot === "live" || boot === "pre-resume")) {
    const disks = await storage.workspace.getDirectoryHandle("managed-disks", { create: true });
    const kept = await keptImageFor(images, storage.workspaceId, manifestUrl, (await liveImage(disks))?.identity)
      ?? await keptImageByManifest(images, manifestUrl, manifestSHA256);
    if (kept !== undefined) {
      await authenticateKept(kept, trustedAotKey, manifestSHA256);
      await inspectCachedBase(images, kept, signal);
      signal?.throwIfAborted();
      return prepareKept(storage, images, kept, boot, release, { aot: { kind: "skipped", reason: "offline" }, signal });
    }
  }
  let response: Response;
  try {
    response = await fetch(manifestUrl, { cache: "no-store", credentials: "omit", ...(signal === undefined ? {} : { signal }) });
  } catch (error) {
    assertManagedImageActive(signal);
    // fetch rejects with a TypeError only when the request cannot be made at all.
    if (!(error instanceof TypeError)) throw error;
    return prepareKeptImage(storage, images, manifestUrl, boot, release, {trustedKey:trustedAotKey,manifestSHA256,signal});
  }
  if (!response.ok) {
    throw new VMError(
      "STORAGE_ERROR",
      `managed image manifest returned ${response.status}`,
    );
  }
  const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(await readManagedBody(response.body, 16 * 1024 ** 2, signal));
  if (manifestSHA256 !== undefined && await sha256Hex(new TextEncoder().encode(manifestText)) !== manifestSHA256) throw new VMError("PROTOCOL_ERROR", "managed image manifest digest differs from its pin");
  const manifestValue: unknown = JSON.parse(manifestText);
  const manifest = decodeManagedImageManifest(manifestValue, manifestUrl);
  if (manifest.schemaVersion === 9) {
    if (trustedAotKey === undefined) throw new VMError("PROTOCOL_ERROR", "signed managed image requires explicit trust");
    await verifyManagedImageManifest(manifest, trustedAotKey);
  }
  const identity = await sha256Hex(managedImageIdentityBytes(manifestValue, manifestText, manifest));
  const ref = { id: manifest.id, version: manifest.version, identity };
  if (boot === "live" || boot === "pre-resume") {
    const disks = await storage.workspace.getDirectoryHandle("managed-disks", { create: true });
    const running = await liveImage(disks);
    if (running !== undefined && running.identity !== identity) {
      const kept = await keptImageNamed(images, storage.workspaceId, running.identity);
      if (kept === undefined) {
        throw new VMError("STORAGE_NOT_FOUND", "the image this workspace's disk runs is no longer kept in this browser", {
          reason: "image-not-cached",
        });
      }
      await authenticateKept(kept, trustedAotKey);
      const aot = policy.imagePreparation === "before-ready" ? { kind: "skipped" as const, reason: "offline" as const }
        : await prepareSystemAot(kept.manifest, kept.ref.identity, trustedAotKey, signal);
      const prepared = await prepareKept(storage, images, kept, boot, release, { aot, signal });
      return { ...prepared, image: { ...prepared.image, update: { id: manifest.id, version: manifest.version } } };
    }
  }
  const stem = managedImageStem(ref);
  const aot = policy.imagePreparation === "before-ready" ? { kind: "skipped" as const, reason: "offline" as const }
    : await prepareSystemAot(manifest, identity, trustedAotKey, signal);
  const [kernel, initrd] = await Promise.all([
    keptOrFetched(images, stem, "kernel", manifest.kernel, signal),
    manifest.initrd === undefined ? Promise.resolve(undefined) : keptOrFetched(images, stem, "initrd", manifest.initrd, signal),
    prepareBaseDisk(images, manifest, ref, signal),
  ]);
  assertManagedImageActive(signal);
  await pinManagedImage(images, storage.workspaceId, {
    ref,
    url: manifestUrl,
    manifestText,
    kernel,
    ...(initrd === undefined ? {} : { initrd }),
  });
  assertManagedImageActive(signal);
  return {
    image: preparedImage(manifest, kernel, initrd, aot, manifest.schemaVersion===9 && trustedAotKey!==undefined ? {id:manifest.id,version:manifest.version,mode:"system",manifestSHA256:decodeSHA256(await sha256Hex(new TextEncoder().encode(manifestText)),"signed manifest digest"),cpuProfile:manifest.cpuProfile,keyId:trustedAotKey.keyId,signatureVerified:true}:undefined),
    disk: await openGeneration(storage, images, { ref, manifest }, boot, release, signal),
    snapshots: manifest.snapshots ?? [],
  };
}

async function inspectCachedBase(images: FileSystemDirectoryHandle, image: PinnedImage, signal?: AbortSignal): Promise<void> {
  assertManagedImageActive(signal);
  const file = await (await images.getFileHandle(`${managedImageStem(image.ref)}.pack`)).getFile();
  const packedBytes = image.manifest.disk.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
  if (file.size !== packedBytes) throw new VMError("STORAGE_NOT_FOUND", "Complete image base is unavailable", { reason: "image-not-cached" });
  assertManagedImageActive(signal);
}

/** Boots the image the workspace keeps for `manifestUrl` without the network. */
async function prepareKeptImage(
  storage: ManagedDiskStorage,
  images: FileSystemDirectoryHandle,
  manifestUrl: URL,
  boot: ManagedBoot,
  release: () => void,
  policy: { readonly trustedKey: TrustedAotKey | undefined; readonly manifestSHA256: string | undefined; readonly signal: AbortSignal | undefined },
): Promise<PreparedManagedDisk> {
  const disks = await storage.workspace.getDirectoryHandle("managed-disks", { create: true });
  const running = await liveImage(disks);
  let image = await keptImageFor(images, storage.workspaceId, manifestUrl, running?.identity);
  if (image === undefined) {
    const installed = await keptImageByManifest(images, manifestUrl, policy.manifestSHA256);
    if (running === undefined || installed?.ref.identity === running.identity) image = installed;
  }
  if (image === undefined) {
    throw new VMError("STORAGE_NOT_FOUND", "the managed image is not kept in this browser for offline use", {
      reason: "image-not-cached",
    });
  }
  await authenticateKept(image, policy.trustedKey, policy.manifestSHA256);
  await inspectCachedBase(images, image, policy.signal);
  return prepareKept(storage, images, image, boot, release, { aot: { kind: "skipped", reason: "offline" }, signal: policy.signal });
}

async function authenticateKept(image: PinnedImage, trustedKey?: TrustedAotKey, manifestSHA256?: string): Promise<void> {
  if (manifestSHA256 !== undefined && await sha256Hex(new TextEncoder().encode(image.manifestText)) !== manifestSHA256) throw new VMError("PROTOCOL_ERROR", "cached image manifest differs from the caller's exact pin");
  if (manifestSHA256 !== undefined && image.manifest.schemaVersion !== 9) throw new VMError("PROTOCOL_ERROR", "pinned public images require whole-image authentication");
  if (image.manifest.schemaVersion === 9) {
    if (trustedKey === undefined) throw new VMError("PROTOCOL_ERROR", "cached signed image requires explicit trust");
    await verifyManagedImageManifest(image.manifest, trustedKey);
  }
}

/** Boots `image` from what this browser keeps for it: its boot assets and base, then the generation. */
async function prepareKept(
  storage: ManagedDiskStorage,
  images: FileSystemDirectoryHandle,
  image: PinnedImage,
  boot: ManagedBoot,
  release: () => void,
  policy: { readonly aot: PreparedManagedImage["aot"]; readonly signal: AbortSignal | undefined },
): Promise<PreparedManagedDisk> {
  assertManagedImageActive(policy.signal);
  const stem = managedImageStem(image.ref);
  const kernel = await keptBootAsset(images, stem, "kernel", image.manifest.kernel);
  const initrdArtifact = image.manifest.initrd;
  const initrd = initrdArtifact === undefined ? undefined : await keptBootAsset(images, stem, "initrd", initrdArtifact);
  if (kernel === undefined || (initrdArtifact !== undefined && initrd === undefined) || !(await baseIsKept(images, stem, image.ref.identity))) {
    throw new VMError("STORAGE_NOT_FOUND", "the managed image is not kept in this browser", { reason: "image-not-cached" });
  }
  assertManagedImageActive(policy.signal);
  await pinManagedImage(images, storage.workspaceId, { ref: image.ref, url: image.url, manifestText: image.manifestText, kernel,
    ...(initrd === undefined ? {} : { initrd }) });
  return {
    image: preparedImage(image.manifest, kernel, initrd, policy.aot, image.manifest.schemaVersion===9 ? {id:image.manifest.id,version:image.manifest.version,mode:"system",manifestSHA256:decodeSHA256(await sha256Hex(new TextEncoder().encode(image.manifestText)),"signed manifest digest"),cpuProfile:image.manifest.cpuProfile,keyId:retainedKeyId(image.manifest),signatureVerified:true}:undefined),
    disk: await openGeneration(storage, images, { ref: image.ref, manifest: image.manifest }, boot, release, policy.signal),
    snapshots: image.manifest.snapshots ?? [],
  };
}

/** The boot asset kept beside `stem` when it is intact, otherwise a verified download. */
async function keptOrFetched(
  images: FileSystemDirectoryHandle,
  stem: string,
  kind: "kernel" | "initrd",
  artifact: ManagedImageArtifact,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (artifact.bytes > MAX_BOOT_ASSET_BYTES) {
    throw new VMError("STORAGE_ERROR", `managed artifact exceeds ${MAX_BOOT_ASSET_BYTES} bytes`);
  }
  signal?.throwIfAborted();
  const kept = await keptBootAsset(images, stem, kind, artifact);
  if (kept !== undefined) return kept;
  const bytes = await fetchVerified(artifact, MAX_BOOT_ASSET_BYTES, signal);
  signal?.throwIfAborted();
  await writeOpfsFile(images, `${stem}.${kind}`, bytes);
  return bytes;
}

async function openGeneration(
  storage: ManagedDiskStorage,
  images: FileSystemDirectoryHandle,
  image: { readonly ref: ManagedImageRef; readonly manifest: ManagedImageManifest },
  boot: ManagedBoot,
  release: () => void,
  signal?: AbortSignal,
): Promise<ManagedDisk> {
  const disks = await storage.workspace.getDirectoryHandle("managed-disks", { create: true });
  const base = await storage.bases.acquire(images, managedImageStem(image.ref), image.manifest.disk.chunks);
  let generation: string;
  try {
    assertManagedImageActive(signal);
    generation = await generationFor(disks, image.ref, boot, signal);
    release();
  } catch (error) {
    base.release();
    throw error;
  }
  return ManagedDisk.open(disks, generation, image, base);
}

function preparedImage(
  manifest: ManagedImageManifest,
  kernel: Uint8Array<ArrayBuffer>,
  initrd: Uint8Array<ArrayBuffer> | undefined,
  aot: PreparedManagedImage["aot"],
  identity: PreparedManagedImage["identity"],
): PreparedManagedImage {
  return {
    ...(identity===undefined?{}:{identity}),
    id: manifest.id,
    version: manifest.version,
    memoryMiB: manifest.memoryMiB,
    vcpus: manifest.vcpus,
    ...(manifest.workspaceBaseSha256 === undefined
      ? {}
      : { workspaceBaseSha256: manifest.workspaceBaseSha256 }),
    kernel,
    ...(initrd === undefined ? {} : { initrd }),
    commandLine: manifest.commandLine,
    diskBytes: manifest.disk.bytes,
    aot,
    runtimes: manifest.runtimes,
  };
}

async function prepareSystemAot(
  manifest: ManagedImageManifest,
  machineSha256: string,
  trustedKey: TrustedAotKey | undefined,
  signal?: AbortSignal,
): Promise<PreparedManagedImage["aot"]> {
  if (manifest.aot === undefined) return { kind: "skipped", reason: "no-catalog" };
  if (trustedKey === undefined) {
    return { kind: "skipped", reason: "untrusted-catalog" };
  }
  try {
    const catalogBytes = await fetchVerified(manifest.aot, MAX_INDEX_BYTES, signal);
    const catalogValue: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(catalogBytes));
    const catalog = decodeAotCatalog(catalogValue, manifest.aot.url);
    if (catalog.machineSha256 !== machineSha256) {
      throw new VMError("PROTOCOL_ERROR", "AOT catalog machine identity does not match");
    }
    await verifyAotCatalog(catalog, trustedKey);
    const index = await fetchVerified(
      {
        url: catalog.index.url,
        bytes: catalog.index.bytes,
        sha256: catalog.index.sha256,
      },
      MAX_INDEX_BYTES,
      signal,
    );
    return {
      kind: "ready",
      catalogUrl: manifest.aot.url.href,
      catalogSha256: manifest.aot.sha256,
      machineSha256,
      keyId: catalog.signing.keyId,
      signatureVerified: true,
      coreRuntimeKey: catalog.compatibility.coreRuntimeKey,
      indexSha256: catalog.index.sha256,
      index,
      packs: catalog.packs.map((pack) => ({
        url: pack.url.href,
        bytes: pack.bytes,
        sha256: pack.sha256,
        phase: pack.phase,
        sourceSha256: pack.sourceSha256,
        memberCount: pack.memberCount,
        score: pack.score,
      })),
    };
  } catch {
    assertManagedImageActive(signal);
    return { kind: "skipped", reason: "invalid-catalog" };
  }
}

async function prepareBaseDisk(
  images: FileSystemDirectoryHandle,
  manifest: ManagedImageManifest,
  ref: ManagedImageRef,
  signal?: AbortSignal,
  verifyExisting = false,
  bases?: ManagedBases,
): Promise<void> {
  const identity = ref.identity;
  const family = `${manifest.id}-${manifest.version}-`;
  const stem = managedImageStem(ref);
  const pinned = await pinnedStems(images);
  const stale = [];
  for await (const [name] of images.entries()) {
    if (managedBaseCacheEntryIsStale(name, family, stem, pinned)) stale.push(name);
  }
  await Promise.all(stale.map((name) => removeIfPresent(images, name)));
  const imageName = `${stem}.pack`;
  const markerName = `${stem}.complete`;
  const packedBytes = manifest.disk.chunks.reduce(
    (total, chunk) => total + chunk.bytes,
    0,
  );
  const file = await images.getFileHandle(imageName, { create: true });
  const marker = await readOptionalText(images, markerName);
  const wasComplete = managedBaseIsComplete(
      (await file.getFile()).size,
      marker,
      packedBytes,
      identity,
    );
  if (wasComplete && !verifyExisting) {
    return;
  }

  await removeIfPresent(images, markerName);
  try {
    const install = (handle?: FileSystemSyncAccessHandle) => installManagedBase(file, images, `${stem}.installing`, identity, manifest.disk.chunks, chunk => fetchVerifiedChunk(chunk, signal),
      { ...(signal === undefined ? {} : { signal }), ...(handle === undefined ? {} : { handle }), verifyExisting: wasComplete });
    if (bases === undefined) await install(); else await bases.repair(images, stem, install);
    signal?.throwIfAborted();

    const markerFile = await images.getFileHandle(markerName, { create: true });
    const markerWritable = await markerFile.createWritable({
      keepExistingData: false,
    });
    await markerWritable.write(managedBaseMarker(packedBytes, identity));
    await markerWritable.close();
    await removeIfPresent(images, `${stem}.installing`);
  } catch (error) {
    await removeIfPresent(images, markerName).catch(() => undefined);
    throw error;
  }
}

async function readOptionalText(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<string | undefined> {
  try {
    return await (await directory.getFileHandle(name)).getFile().then((file) =>
      file.text(),
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return undefined;
    }
    throw error;
  }
}


function retainedKeyId(manifest:ManagedImageManifest):string {
    if(manifest.provenance===undefined) throw new VMError("PROTOCOL_ERROR","signed retained image has no provenance key");
    return manifest.provenance.keyId;
}
