import { VMError } from "../errors.js";
import { managedImageStem } from "./managed-disk-head.js";
import { keptBootAsset, loadPinnedImage } from "./managed-image-pins.js";
import type { SnapshotCatalog } from "./snapshot-catalog.js";
import { manifestObjects, USERSPACE_SNAPSHOT_SCHEMA, type ObjectRef, type SnapshotManifest } from "./snapshot-manifest.js";
import type { SnapshotObjects } from "./snapshot-objects.js";
import { validateBackupRootfs } from "./snapshot-archive/rootfs.js";
import type {ShippedInstallIdentity} from "../protocol/shipped-source.js";

export interface SnapshotImportOptions {readonly preserveId?: true; readonly shippedSource?: ShippedInstallIdentity}

export function importedManifest(source: SnapshotManifest, createdAt: string, kind: "imported" | "shipped", id: string): SnapshotManifest {
  const identity = {id,createdAt,kind,parent:null};
  return source.schema === USERSPACE_SNAPSHOT_SCHEMA ? {...source,...identity} : {
    schema:source.schema,...identity,...(source.label === undefined ? {} : {label:source.label}),
    capturedAtUnixMs:source.capturedAtUnixMs,machine:source.machine,ram:source.ram,disk:source.disk,assets:source.assets,
    ...(source.host === undefined ? {} : {host:source.host}),
  };
}

/**
 * One backup import (ADR 0014 R10): the restore point under a fresh id and kind "imported",
 * stored object by object, and invisible until `commit` writes its manifest and commit marker. A
 * write-ahead capture intent rolls an interrupted import back when the store next opens; until
 * the import ends, the store keeps every object it needs out of collection.
 */
export class SnapshotImport {
  readonly manifest: SnapshotManifest;
  readonly #catalog: SnapshotCatalog;
  readonly #objects: SnapshotObjects;
  readonly #needed: ReadonlyMap<string, ObjectRef>;
  readonly #stored = new Set<string>();
  readonly #ended: () => void;
  readonly #source: ShippedInstallIdentity | undefined;
  #open = true;

  private constructor(catalog: SnapshotCatalog, objects: SnapshotObjects, manifest: SnapshotManifest, ended: () => void, source?: ShippedInstallIdentity) {
    this.#catalog = catalog;
    this.#objects = objects;
    this.manifest = manifest;
    this.#needed = new Map(manifestObjects(manifest).map((ref) => [ref.sha256, ref]));
    this.#ended = ended;
    this.#source = source;
  }

  /**
   * Starts importing `source` as a new restore point of `kind` (an opened backup, or a restore
   * point shipped with a profile) saved at `createdAt`. The workspace record is dropped: it names
   * another browser's workspace store generations. `ended` runs once the import commits or aborts.
   */
  static async begin(
    catalog: SnapshotCatalog,
    objects: SnapshotObjects,
    source: SnapshotManifest,
    createdAt: string,
    ended: () => void,
    kind: "imported" | "shipped" = "imported",
    options: SnapshotImportOptions = {},
  ): Promise<SnapshotImport> {
    if ((options.preserveId !== undefined || options.shippedSource !== undefined) && (kind !== "shipped" || options.preserveId !== true || options.shippedSource === undefined)) {
      throw new VMError("INVALID_ARGUMENT","source identity is restricted to verified shipped imports");
    }
    const id = options.preserveId === true ? source.id : crypto.randomUUID();
    if (await catalog.exists(id)) throw new VMError("STORAGE_ERROR","the shipped source UUID already exists with different content",{reason:"shipped-incompatible"});
    const manifest = importedManifest(source,options.preserveId === true ? source.createdAt : createdAt,kind,id);
    await catalog.beginIntent({ kind: "capture", snapshot: manifest.id });
    return new SnapshotImport(catalog, objects, manifest, ended, options.shippedSource);
  }

  /** The objects the restore point needs, which collection must keep while the import runs. */
  objectRefs(): Iterable<string> {
    return this.#needed.keys();
  }

  /** Whether the restore point needs `ref` (a backup also carries objects an import drops). */
  needs(ref: ObjectRef): boolean {
    return this.#needed.get(ref.sha256)?.bytes === ref.bytes;
  }

  /** Stores the content of `ref`, which must be one of the objects the restore point needs. */
  async put(ref: ObjectRef, content: Uint8Array): Promise<void> {
    this.#assertOpen();
    if (!this.needs(ref)) throw new VMError("STORAGE_ERROR", "an imported object is not part of its restore point");
    const stored = await this.#objects.put(content);
    if (stored.sha256 !== ref.sha256 || stored.bytes !== ref.bytes) {
      throw new VMError("STORAGE_ERROR", "an imported object does not match its reference", { reason: "snapshot-damaged" });
    }
    this.#validateRootfs(ref,content);
    this.#stored.add(ref.sha256);
  }

  /**
   * Takes `ref` from the store when it already holds it intact, as a retried install does, so it
   * need not be fetched again; false when it must be.
   */
  async adopt(ref: ObjectRef): Promise<boolean> {
    this.#assertOpen();
    if (!this.needs(ref)) return false;
    let content:Uint8Array;
    try {
      content=await this.#objects.read(ref);
    } catch {
      return false;
    }
    this.#validateRootfs(ref,content);
    this.#stored.add(ref.sha256);
    return true;
  }

  /** Commits the restore point once every object it needs is stored. */
  async commit(): Promise<SnapshotManifest> {
    this.#assertOpen();
    for (const sha256 of this.#needed.keys()) {
      if (!this.#stored.has(sha256)) throw new VMError("STORAGE_ERROR", "an import is missing objects", { reason: "snapshot-damaged" });
    }
    await this.#catalog.commit(this.manifest,this.#source);
    await this.#catalog.endIntent(this.manifest.id);
    this.#end();
    return this.manifest;
  }

  /** Ends the import without a restore point; the next collection reclaims what it stored. */
  async abort(): Promise<void> {
    if (!this.#open) return;
    this.#end();
    await this.#catalog.endIntent(this.manifest.id).catch(() => undefined);
  }

  #end(): void {
    this.#open = false;
    this.#ended();
  }

  #assertOpen(): void {
    if (!this.#open) throw new VMError("STORAGE_ERROR", "the import has ended");
  }
  #validateRootfs(ref:ObjectRef,content:Uint8Array):void {
    if(this.manifest.schema===USERSPACE_SNAPSHOT_SCHEMA&&ref.sha256===this.manifest.rootfs.manifest.sha256)validateBackupRootfs(content,this.manifest);
  }
}

/**
 * The boot assets an imported managed restore point takes from its image instead of the backup:
 * that image must be kept in this browser with the same kernel and initrd. Others need none.
 */
export async function importBootAssets(
  images: FileSystemDirectoryHandle,
  source: SnapshotManifest,
): Promise<{ readonly ref: ObjectRef; readonly content: Uint8Array }[]> {
  if (source.schema === USERSPACE_SNAPSHOT_SCHEMA) return [];
  const disk = source.disk;
  if (disk?.origin !== "managed") return [];
  const image = await loadPinnedImage(images, disk.baseIdentity);
  const stem = image === undefined ? undefined : managedImageStem(image.ref);
  const wanted = [
    ["kernel", source.assets.kernel, image?.manifest.kernel],
    ...(source.assets.initrd === undefined ? [] : [["initrd", source.assets.initrd, image?.manifest.initrd] as const]),
  ] as const;
  const assets = [];
  for (const [kind, ref, artifact] of wanted) {
    const content = stem === undefined || artifact?.sha256 !== ref.sha256 || artifact.bytes !== ref.bytes
      ? undefined
      : await keptBootAsset(images, stem, kind, artifact);
    if (content === undefined) {
      throw new VMError("STORAGE_NOT_FOUND", "the restore point's image is not kept in this browser", { reason: "base-missing" });
    }
    assets.push({ ref, content });
  }
  return assets;
}
