import { exactKeys, record, string } from "../decode.js";
import { managedBaseMarker } from "../managed-disk-state.js";
import { VMError } from "../errors.js";
import {
  decodeManagedImageManifest,
  managedImageIdentityBytes,
  managedImageUrl,
  type ManagedImageManifest,
} from "../managed-image.js";
import { decodeImageRef, managedImageStem, type ManagedImageRef } from "./managed-disk-head.js";
import { sha256Hex } from "./snapshot-content.js";
import { isNotFound, readOpfsFile, writeOpfsFile } from "./snapshot-objects.js";

const MAX_IMAGE_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_PINS_BYTES = 1024 * 1024;
const MAX_MARKER_BYTES = 1024;
const IMAGE_RECORD_SUFFIX = ".image.json";

/** A cached managed image whose manifest copy matched its identity. */
export interface PinnedImage {
  readonly ref: ManagedImageRef;
  readonly url: URL;
  readonly manifest: ManagedImageManifest;
  readonly manifestText: string;
}

export interface ImageToPin {
  readonly ref: ManagedImageRef;
  readonly url: URL;
  readonly manifestText: string;
  readonly kernel: Uint8Array<ArrayBuffer>;
  readonly initrd?: Uint8Array<ArrayBuffer>;
}

/**
 * Keeps an image for a workspace: a copy of its manifest and boot assets beside its base pack in
 * `managed-images/`, and its stem in `managed-images/pins/<workspace>.json`. Stale-pack cleanup
 * skips pinned stems, so restore points and disk generations keep their base image.
 */
export async function pinManagedImage(
  images: FileSystemDirectoryHandle,
  workspaceId: string,
  image: ImageToPin,
): Promise<void> {
  const stem = managedImageStem(image.ref);
  await writeIfAbsent(images, `${stem}${IMAGE_RECORD_SUFFIX}`, encode({
    schema: 1,
    image: { id: image.ref.id, version: image.ref.version, identity: image.ref.identity },
    url: image.url.href,
    manifest: image.manifestText,
  }));
  await writeIfAbsent(images, `${stem}.kernel`, image.kernel);
  if (image.initrd !== undefined) await writeIfAbsent(images, `${stem}.initrd`, image.initrd);
  const pins = await images.getDirectoryHandle("pins", { create: true });
  const current = await readPins(pins, `${workspaceId}.json`);
  if (!current.includes(stem)) {
    await writeOpfsFile(pins, `${workspaceId}.json`, encode({ schema: 1, images: [...current, stem].sort() }));
  }
}

/** The cached image with `identity`, verified against that identity, if it is cached. */
export async function loadPinnedImage(
  images: FileSystemDirectoryHandle,
  identity: string,
): Promise<PinnedImage | undefined> {
  for await (const name of images.keys()) {
    if (!name.endsWith(`-${identity}${IMAGE_RECORD_SUFFIX}`)) continue;
    const entry = record(parse(await readOpfsFile(images, name, MAX_IMAGE_RECORD_BYTES)), "pinned managed image");
    exactKeys(entry, ["schema", "image", "url", "manifest"]);
    const ref = decodeImageRef(entry["image"]);
    if (entry["schema"] !== 1 || ref.identity !== identity || `${managedImageStem(ref)}${IMAGE_RECORD_SUFFIX}` !== name) {
      return damaged();
    }
    const url = managedImageUrl(string(entry["url"], "pinned image URL"));
    const text = string(entry["manifest"], "pinned image manifest");
    const value = parse(new TextEncoder().encode(text));
    const manifest = decodeManagedImageManifest(value, url);
    if (
      manifest.id !== ref.id ||
      manifest.version !== ref.version ||
      (await sha256Hex(managedImageIdentityBytes(value, text, manifest))) !== identity
    ) {
      return damaged();
    }
    return { ref, url, manifest, manifestText: text };
  }
  return undefined;
}

/** Replaces the images `workspaceId` pins with `stems`; no stems removes its pin file. */
export async function setWorkspacePins(
  images: FileSystemDirectoryHandle,
  workspaceId: string,
  stems: ReadonlySet<string>,
): Promise<void> {
  const pins = await images.getDirectoryHandle("pins", { create: true });
  if (stems.size !== 0) {
    await writeOpfsFile(pins, `${workspaceId}.json`, encode({ schema: 1, images: [...stems].sort() }));
    return;
  }
  try {
    await pins.removeEntry(`${workspaceId}.json`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/** The stem of every cached image, by identity. */
export async function cachedImageStems(images: FileSystemDirectoryHandle): Promise<Map<string, string>> {
  const stems = new Map<string, string>();
  for await (const name of images.keys()) {
    if (!name.endsWith(IMAGE_RECORD_SUFFIX)) continue;
    const stem = name.slice(0, -IMAGE_RECORD_SUFFIX.length);
    stems.set(stem.slice(stem.lastIndexOf("-") + 1), stem);
  }
  return stems;
}

/** Content identity is shared across workspaces; a URL only locates the authenticated manifest. */
export async function keptImageByManifest(images: FileSystemDirectoryHandle, url: URL, digest?: string): Promise<PinnedImage | undefined> {
  const candidates: PinnedImage[] = [];
  for (const identity of (await cachedImageStems(images)).keys()) {
    const image = await loadPinnedImage(images, identity);
    if (image?.url.href === url.href && (digest === undefined || await sha256Hex(new TextEncoder().encode(image.manifestText)) === digest)) candidates.push(image);
  }
  return candidates.sort((a, b) => b.ref.version.localeCompare(a.ref.version))[0];
}

/** Identities of the cached images whose record and whole base this browser keeps. */
export async function cachedBaseIdentities(images: FileSystemDirectoryHandle): Promise<Set<string>> {
  const identities = new Set<string>();
  for (const [identity, stem] of await cachedImageStems(images)) {
    if (await baseIsKept(images, stem, identity)) identities.add(identity);
  }
  return identities;
}

/**
 * Whether this browser keeps `stem`'s base whole: its pack, and the marker written once its
 * download completed, naming the image and the pack's size.
 */
export async function baseIsKept(images: FileSystemDirectoryHandle, stem: string, identity: string): Promise<boolean> {
  try {
    const marker = new TextDecoder().decode(await readOpfsFile(images, `${stem}.complete`, MAX_MARKER_BYTES));
    const size = (await (await images.getFileHandle(`${stem}.pack`)).getFile()).size;
    return marker === managedBaseMarker(size, identity);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/**
 * The image `workspaceId` keeps for manifest `url`: the one with identity `prefer` (the version
 * the workspace's disk runs) when kept, otherwise the newest kept version.
 */
export async function keptImageFor(
  images: FileSystemDirectoryHandle,
  workspaceId: string,
  url: URL,
  prefer: string | undefined,
): Promise<PinnedImage | undefined> {
  const pins = await images.getDirectoryHandle("pins", { create: true });
  const kept: PinnedImage[] = [];
  for (const stem of await readPins(pins, `${workspaceId}.json`)) {
    const image = await loadPinnedImage(images, stem.slice(stem.lastIndexOf("-") + 1));
    if (image?.url.href === url.href) kept.push(image);
  }
  return kept.find((image) => image.ref.identity === prefer)
    ?? kept.sort((left, right) => right.ref.version.localeCompare(left.ref.version))[0];
}

/** The image `workspaceId` keeps with `identity`, or undefined when it keeps no such image. */
export async function keptImageNamed(
  images: FileSystemDirectoryHandle,
  workspaceId: string,
  identity: string,
): Promise<PinnedImage | undefined> {
  const pins = await images.getDirectoryHandle("pins", { create: true });
  const pinned = (await readPins(pins, `${workspaceId}.json`)).some((stem) => stem.endsWith(`-${identity}`));
  return pinned ? loadPinnedImage(images, identity) : undefined;
}

/** The kernel or initrd kept beside `stem`, when it matches `artifact`'s length and SHA-256. */
export async function keptBootAsset(
  images: FileSystemDirectoryHandle,
  stem: string,
  kind: "kernel" | "initrd",
  artifact: { readonly bytes: number; readonly sha256: string },
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readOpfsFile(images, `${stem}.${kind}`, artifact.bytes);
  } catch (error) {
    if (isNotFound(error) || (error instanceof VMError && error.detail?.["reason"] === "snapshot-damaged")) return undefined;
    throw error;
  }
  return bytes.byteLength === artifact.bytes && (await sha256Hex(bytes)) === artifact.sha256 ? bytes : undefined;
}

/** Every stem any workspace pins. */
export async function pinnedStems(images: FileSystemDirectoryHandle): Promise<Set<string>> {
  let pins: FileSystemDirectoryHandle;
  try {
    pins = await images.getDirectoryHandle("pins");
  } catch (error) {
    if (isNotFound(error)) return new Set();
    throw error;
  }
  const stems = new Set<string>();
  for await (const [name, handle] of pins.entries()) {
    if (handle.kind !== "file" || !name.endsWith(".json")) continue;
    for (const stem of await readPins(pins, name)) stems.add(stem);
  }
  return stems;
}

async function readPins(pins: FileSystemDirectoryHandle, name: string): Promise<string[]> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readOpfsFile(pins, name, MAX_PINS_BYTES);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const value = record(parse(bytes), "managed image pins");
  exactKeys(value, ["schema", "images"]);
  const stems = value["images"];
  if (value["schema"] !== 1 || !Array.isArray(stems)) return damaged();
  return stems.map((stem: unknown) => string(stem, "pinned image stem"));
}

async function writeIfAbsent(
  directory: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  try {
    if ((await (await directory.getFileHandle(name)).getFile()).size === bytes.byteLength) return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await writeOpfsFile(directory, name, bytes);
}

function encode(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

function parse(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return damaged();
  }
}

function damaged(): never {
  throw new VMError("STORAGE_ERROR", "a cached managed image is damaged", { reason: "base-damaged" });
}
