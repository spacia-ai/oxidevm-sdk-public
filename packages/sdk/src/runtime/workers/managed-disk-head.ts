import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import type { ManagedBoot } from "../protocol.js";
import { isNotFound, readOpfsFile, writeOpfsFile } from "./snapshot-objects.js";
import { isManagedImageName, managedImageStem } from "../managed-image-ref.js";
import type { ManagedImageRef } from "../managed-image-ref.js";
import {decodeShippedInstallIdentity,type ShippedInstallIdentity} from "../protocol/shipped-source.js";
export { isManagedImageName, managedImageStem } from "../managed-image-ref.js";
export type { ManagedImageRef } from "../managed-image-ref.js";

const HEAD = "head.json";
const GENERATION = "generation.json";
const MAX_RECORD_BYTES = 64 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;


/**
 * `managed-disks/head.json`, the only authority for which disk generation is live. `previous` is
 * the generation a resume replaced; it stays through automatic and safety saves until a named
 * save, a restart, a reset or an update releases it, so "Restart instead" can boot it.
 */
export interface DiskHead {
  readonly schema: 1 | 2;
  readonly initialStart?: ShippedInstallIdentity;
  readonly generation: string;
  readonly previous: string | null;
  /**
   * The restore point the running VM last matched: set when a save commits or a restore
   * completes, and cleared when the image boots cold, so resuming never brings back a state the
   * user restarted or reset away from.
   */
  readonly resume: string | null;
}

/** `managed-disks/<generation>/generation.json`: the image and the snapshot its changes follow. */
export interface GenerationRecord {
  readonly schema: 1;
  readonly image: ManagedImageRef;
  readonly bytes: number;
  /** The snapshot this generation's change bitmap is relative to; null means the image base. */
  readonly changeBase: string | null;
}


/** A new generation's directory name. */
export function newGenerationName(): string {
  return `g-${crypto.randomUUID()}`;
}

/**
 * The generation to boot for `image`, the image the workspace runs: the head's. Without a head,
 * or with one whose generation records no image, this image's own generation (named after its
 * stem, the pre-head per-image overlay) becomes the head. A head running another image is
 * refused: only an update or a reset moves the workspace to another image (ADR 0014), so an
 * ordinary boot never leaves the files on its disk behind.
 */
export async function liveGenerationFor(
  disks: FileSystemDirectoryHandle,
  image: ManagedImageRef,
  signal?: AbortSignal,
): Promise<string> {
  const head = await readDiskHead(disks);
  const running = head === undefined ? undefined : await readGenerationNamed(disks, head.generation);
  if (head !== undefined && running?.image.identity === image.identity) {
    // The live disk boots again (a restart, or the next page's start), so the work since the
    // last resume is on it: the generation that resume replaced is no longer kept.
    activeGeneration(signal);
    if (head.previous !== null) await writeDiskHead(disks, { ...head, previous: null });
    return head.generation;
  }
  if (running !== undefined) {
    throw new VMError("STORAGE_ERROR", "this workspace's disk runs another image; boot that one or update", {
      reason: "disk-runs-another-image",
    });
  }
  return ownGenerationFor(disks, image, signal);
}

/** "Update Linux": the workspace moves to `image`'s own generation unless it already runs it. */
export async function updateGenerationFor(
  disks: FileSystemDirectoryHandle,
  image: ManagedImageRef,
  signal?: AbortSignal,
): Promise<string> {
  const head = await readDiskHead(disks);
  if (head !== undefined && (await readGenerationNamed(disks, head.generation))?.image.identity === image.identity) {
    return head.generation;
  }
  return ownGenerationFor(disks, image, signal);
}

async function ownGenerationFor(disks: FileSystemDirectoryHandle, image: ManagedImageRef, signal?: AbortSignal): Promise<string> {
  const generation = managedImageStem(image);
  activeGeneration(signal);
  await writeDiskHead(disks, { schema: 1, generation, previous: null, resume: null });
  return generation;
}

/** The generation a managed image boots for `boot`. */
export function generationFor(
  disks: FileSystemDirectoryHandle,
  image: ManagedImageRef,
  boot: ManagedBoot,
  signal?: AbortSignal,
): Promise<string> {
  switch (boot) {
    case "live":
      return liveGenerationFor(disks, image, signal);
    case "pre-resume":
      return preResumeGenerationFor(disks, image, signal);
    case "fresh-image":
      return freshGenerationFor(disks, signal);
    case "update-image":
      return updateGenerationFor(disks, image, signal);
  }
}

/**
 * "Restart instead": the generation the last resume replaced, which can hold files newer than the
 * restore point (the live one without a resume), becomes the only one the head keeps, without a
 * resume point.
 */
export async function preResumeGenerationFor(
  disks: FileSystemDirectoryHandle,
  image: ManagedImageRef,
  signal?: AbortSignal,
): Promise<string> {
  const head = await readDiskHead(disks);
  const previous = head?.previous ?? null;
  const record = previous === null ? undefined : await readGenerationNamed(disks, previous);
  const generation = previous !== null && record?.image.identity === image.identity
    ? previous
    : await liveGenerationFor(disks, image, signal);
  activeGeneration(signal);
  await writeDiskHead(disks, { schema: 1, generation, previous: null, resume: null });
  return generation;
}

/** A reset: a new, empty generation becomes the only one the head keeps. */
export async function freshGenerationFor(disks: FileSystemDirectoryHandle, signal?: AbortSignal): Promise<string> {
  const generation = newGenerationName();
  activeGeneration(signal);
  await writeDiskHead(disks, { schema: 1, generation, previous: null, resume: null });
  return generation;
}

function activeGeneration(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new VMError("ABORTED", "Image selection cancelled before publication");
}

/**
 * Makes the generation restored from snapshot `resume` live. The generation it replaces becomes
 * `previous`: it holds the newest files, including any work since an earlier resume, and the
 * generation an earlier resume replaced is no longer kept.
 */
export async function promoteGeneration(
  disks: FileSystemDirectoryHandle,
  generation: string,
  resume: string,
  initialStart?: ShippedInstallIdentity,
): Promise<DiskHead> {
  const head = await readDiskHead(disks);
  const initialized=initialStart??head?.initialStart;
  const next: DiskHead = {
    schema: initialized===undefined?1:2,
    generation,
    previous: head === undefined ? null : head.generation,
    resume,
    ...(initialized===undefined?{}:{initialStart:initialized}),
  };
  await writeDiskHead(disks, next);
  return next;
}

/** The image the head's generation runs, or undefined before any boot. */
export async function liveImage(disks: FileSystemDirectoryHandle): Promise<ManagedImageRef | undefined> {
  const head = await readDiskHead(disks);
  return head === undefined ? undefined : (await readGenerationNamed(disks, head.generation))?.image;
}

/** The snapshot the live generation's changes follow, or null without one. */
export async function liveChangeBase(disks: FileSystemDirectoryHandle): Promise<string | null> {
  const head = await readDiskHead(disks);
  return head === undefined ? null : (await readGenerationNamed(disks, head.generation))?.changeBase ?? null;
}

/**
 * After save `resume` commits, the VM matches it. A save the user named (`release`) also releases
 * the pre-resume generation, whose name it returns; an automatic or safety save keeps it, so the
 * files a resume left behind stay one "Restart instead" away until the user decides.
 */
export async function settleHead(disks: FileSystemDirectoryHandle, resume: string, release: boolean): Promise<string | null> {
  const head = await readDiskHead(disks);
  if (head === undefined) return null;
  const previous = release ? null : head.previous;
  await writeDiskHead(disks, { ...head, previous, resume });
  return release ? head.previous : null;
}

/** A cold boot: the running VM no longer matches any restore point. */
export async function clearResumePoint(disks: FileSystemDirectoryHandle): Promise<void> {
  const head = await readDiskHead(disks);
  if (head === undefined || head.resume === null) return;
  await writeDiskHead(disks, { ...head, resume: null });
}

/**
 * Removes the generations nothing boots any more: a restore generation (`g-*`) that is neither
 * the head's generation, its pre-resume generation nor in `inUse`, and an image's own generation
 * that a restore of the same image superseded. Another image's own generation stays, because
 * booting that image again resumes it. A generation whose files are still open stays for a
 * later pass. Returns the removed names and the images of the live generations.
 */
export async function collectGenerations(
  disks: FileSystemDirectoryHandle,
  inUse: ReadonlySet<string>,
): Promise<{ readonly removed: string[]; readonly liveImages: ManagedImageRef[] }> {
  const head = await readDiskHead(disks);
  const live = new Set(inUse);
  if (head !== undefined) live.add(head.generation);
  if (head?.previous !== undefined && head.previous !== null) live.add(head.previous);
  const liveImages = new Map<string, ManagedImageRef>();
  for (const name of live) {
    const image = (await readGenerationNamed(disks, name))?.image;
    if (image !== undefined) liveImages.set(image.identity, image);
  }
  const headImage = head === undefined ? undefined : (await readGenerationNamed(disks, head.generation))?.image;
  const candidates: string[] = [];
  for await (const [name, handle] of disks.entries()) {
    if (handle.kind !== "directory" || live.has(name)) continue;
    if (name.startsWith("g-")) {
      candidates.push(name);
      continue;
    }
    // An image's own generation is removed only when its record proves the head superseded it.
    const image = (await readGenerationRecord(handle).catch(() => undefined))?.image;
    if (image !== undefined && image.identity === headImage?.identity && managedImageStem(image) === name) {
      candidates.push(name);
    }
  }
  const removed: string[] = [];
  for (const name of candidates) {
    if (await removeGeneration(disks, name)) removed.push(name);
  }
  return { removed: removed.sort(), liveImages: [...liveImages.values()] };
}

/** The record of generation `name`, or `undefined` when the generation or its record is absent. */
async function readGenerationNamed(
  disks: FileSystemDirectoryHandle,
  name: string,
): Promise<GenerationRecord | undefined> {
  let directory: FileSystemDirectoryHandle;
  try {
    directory = await disks.getDirectoryHandle(name);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  return readGenerationRecord(directory);
}

async function removeGeneration(disks: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await disks.removeEntry(name, { recursive: true });
    return true;
  } catch (error) {
    if (isNotFound(error) || (error instanceof DOMException && error.name === "NoModificationAllowedError")) {
      return false;
    }
    throw error;
  }
}

export async function readDiskHead(disks: FileSystemDirectoryHandle): Promise<DiskHead | undefined> {
  const value = await readRecord(disks, HEAD);
  if (value === undefined) return undefined;
  const head = record(value, "managed disk head");
  exactKeys(head, ["schema", "generation", "previous"], ["resume",...(head["schema"]===2?["initialStart"]:[])]);
  if (head["schema"] !== 1 && head["schema"] !== 2 || head["schema"]===2&&head["initialStart"]===undefined) return damaged();
  const resume = head["resume"] ?? null;
  if (resume !== null && (typeof resume !== "string" || !UUID.test(resume))) return damaged();
  return {
    schema: head["schema"],
    ...(head["initialStart"]===undefined?{}:{initialStart:decodeShippedInstallIdentity(head["initialStart"])}),
    generation: decodeName(head["generation"]),
    previous: head["previous"] === null ? null : decodeName(head["previous"]),
    resume,
  };
}

export async function writeDiskHead(disks: FileSystemDirectoryHandle, head: DiskHead): Promise<void> {
  const initialStart=head.initialStart??(await readDiskHead(disks))?.initialStart;
  await writeRecord(disks, HEAD, {
    schema: initialStart===undefined?1:2,
    generation: decodeName(head.generation),
    previous: head.previous,
    resume: head.resume,
    ...(initialStart===undefined?{}:{initialStart}),
  });
}

export async function readGenerationRecord(
  directory: FileSystemDirectoryHandle,
): Promise<GenerationRecord | undefined> {
  const value = await readRecord(directory, GENERATION);
  if (value === undefined) return undefined;
  const generation = record(value, "managed disk generation");
  exactKeys(generation, ["schema", "image", "bytes", "changeBase"]);
  if (generation["schema"] !== 1) return damaged();
  const changeBase = generation["changeBase"];
  if (changeBase !== null && (typeof changeBase !== "string" || !UUID.test(changeBase))) return damaged();
  return {
    schema: 1,
    image: decodeImageRef(generation["image"]),
    bytes: integer(generation["bytes"], "managed disk bytes", 512),
    changeBase,
  };
}

export async function writeGenerationRecord(
  directory: FileSystemDirectoryHandle,
  generation: GenerationRecord,
): Promise<void> {
  await writeRecord(directory, GENERATION, {
    schema: 1,
    image: { id: generation.image.id, version: generation.image.version, identity: generation.image.identity },
    bytes: generation.bytes,
    changeBase: generation.changeBase,
  });
}

export function decodeImageRef(value: unknown): ManagedImageRef {
  const image = record(value, "managed image reference");
  exactKeys(image, ["id", "version", "identity"]);
  const identity = string(image["identity"], "managed image identity");
  if (!HASH.test(identity)) return damaged();
  return { id: decodeName(image["id"]), version: decodeName(image["version"]), identity };
}

function decodeName(value: unknown): string {
  const name = string(value, "managed disk name");
  if (!isManagedImageName(name)) return damaged();
  return name;
}

async function readRecord(directory: FileSystemDirectoryHandle, name: string): Promise<unknown> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readOpfsFile(directory, name, MAX_RECORD_BYTES);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return damaged();
  }
}

async function writeRecord(directory: FileSystemDirectoryHandle, name: string, value: unknown): Promise<void> {
  const bytes=new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  try {await writeOpfsFile(directory,name,bytes);}
  catch(error) {
    const stored=await readOpfsFile(directory,name,MAX_RECORD_BYTES).catch(()=>undefined);
    if(stored===undefined||stored.length!==bytes.length||!bytes.every((byte,index)=>stored[index]===byte))throw error;
  }
}

function damaged(): never {
  throw new VMError("STORAGE_ERROR", "a managed disk record is damaged", { reason: "disk-record-damaged" });
}
