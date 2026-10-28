import { exactKeys, record, string } from "../decode.js";
import { normalizeStorageError, VMError } from "../errors.js";
import {
  decodeSnapshotManifest,
  encodeSnapshotManifest,
  manifestObjects,
  MAX_MANIFEST_BYTES,
  readSnapshotIdentity,
  type SnapshotIdentity,
  type SnapshotManifest,
} from "./snapshot-manifest.js";
import { sha256Hex } from "./snapshot-content.js";
import { isNotFound, readOpfsFile, type SnapshotObjects, writeOpfsFile } from "./snapshot-objects.js";
import {decodeShippedInstallIdentity, type ShippedInstallIdentity} from "../protocol/shipped-source.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LABEL_BYTES = 256;
const MAX_INTENT_BYTES = 64 * 1024;
const MARKER_BYTES = 64;
const MAX_CATALOG_BYTES=MAX_MANIFEST_BYTES+1024;

/**
 * A write-ahead record of one transaction on one snapshot, kept in `intents/<snapshot>.json`
 * until the transaction ends. Opening the store settles every intent a closed tab left behind.
 */
export type SnapshotIntent =
  | { readonly kind: "capture"; readonly snapshot: string }
  | { readonly kind: "delete"; readonly snapshot: string }
  | { readonly kind: "rename"; readonly snapshot: string; readonly label: string | null };

export type CatalogEntry =
  | { readonly id: string; readonly manifest: SnapshotManifest }
  | { readonly id: string; readonly damaged: VMError; readonly identity: SnapshotIdentity };

export interface ObjectUsage {
  /** Bytes of the objects a restore point or a root needs. */
  readonly referencedBytes: number;
  /** Bytes a collection would free now. */
  readonly reclaimableBytes: number;
}

interface Reachability {
  readonly referenced: ReadonlySet<string>;
  /** A committed manifest could not be read, so no object is known to be unreachable. */
  readonly uncertain: boolean;
}

/**
 * The restore points of one workspace (`snapshots-v2`): canonical manifests, their commit
 * markers, write-ahead intents, and reachability collection of the content objects. A snapshot
 * exists once its marker, the SHA-256 of its manifest, is written after the manifest.
 */
export class SnapshotCatalog {
  readonly #root: FileSystemDirectoryHandle;
  readonly #objects: SnapshotObjects;

  constructor(root: FileSystemDirectoryHandle, objects: SnapshotObjects) {
    this.#root = root;
    this.#objects = objects;
  }

  /** Reads committed immutable metadata without opening or recovering a store. */
  static async inspect(root:FileSystemDirectoryHandle,id:string):Promise<SnapshotManifest|undefined> {
    return (await SnapshotCatalog.inspectEntry(root,id))?.manifest;
  }
  static async inspectEntry(root:FileSystemDirectoryHandle,id:string):Promise<{manifest:SnapshotManifest;source?:ShippedInstallIdentity}|undefined> {
    if(!UUID.test(id)) throw new VMError("INVALID_ARGUMENT","snapshot id is invalid");
    try {
      const commits=await root.getDirectoryHandle("commits");
      const manifests=await root.getDirectoryHandle("manifests");
      const marker=new TextDecoder().decode(await readOpfsFile(commits,id,MARKER_BYTES));
      return await decodeStoredEntry(await readOpfsFile(manifests,`${id}.json`,MAX_CATALOG_BYTES),id,marker);
    } catch(error) {if(isNotFound(error)) return undefined;throw error;}
  }
  static async inspectList(root:FileSystemDirectoryHandle):Promise<SnapshotManifest[]> {
    const manifests:SnapshotManifest[]=[];
    let commits:FileSystemDirectoryHandle;
    try {commits=await root.getDirectoryHandle("commits");} catch(error) {if(isNotFound(error)) return [];throw error;}
    let scanned=0;
    for await(const id of commits.keys()) {
      if(!UUID.test(id)) continue;
      if(++scanned>4096) throw new VMError("STORAGE_ERROR","retained snapshot catalogue exceeds inspection bound");
      try {const manifest=await SnapshotCatalog.inspect(root,id);if(manifest!==undefined) manifests.push(manifest);}
      catch(error) {if(!(error instanceof VMError)||(error.code!=="STORAGE_ERROR"&&error.code!=="SNAPSHOT_VERSION")) throw error;}
    }
    return manifests.sort((left,right)=>right.capturedAtUnixMs-left.capturedAtUnixMs||left.id.localeCompare(right.id));
  }

  /** Writes the canonical manifest, then its commit marker. */
  async commit(manifest: SnapshotManifest, shippedSource?: ShippedInstallIdentity): Promise<void> {
    const bytes = shippedSource === undefined ? encodeSnapshotManifest(manifest)
      : new TextEncoder().encode(JSON.stringify({format:"oxidevm-snapshot-catalog",version:1,manifest,shippedSource}));
    await writeOpfsFile(await this.#directory("manifests"), `${manifest.id}.json`, bytes);
    await writeOpfsFile(await this.#directory("commits"), manifest.id, new TextEncoder().encode(await sha256Hex(bytes)));
  }

  /** A committed manifest whose commit marker matches its bytes. */
  async load(id: string): Promise<SnapshotManifest> {
    const marker = await this.#marker(id);
    if (marker === undefined) throw new VMError("STORAGE_NOT_FOUND", "snapshot was not found");
    return decodeStored(await this.#manifestBytes(id), id, marker);
  }

  async shippedSource(id: string): Promise<ShippedInstallIdentity | undefined> {
    const marker = await this.#marker(id);
    if (marker === undefined) throw new VMError("STORAGE_NOT_FOUND","snapshot was not found");
    return (await decodeStoredEntry(await this.#manifestBytes(id),id,marker)).source;
  }

  /** Whether a manifest or a commit marker of `id` exists, committed or not. */
  async exists(id: string): Promise<boolean> {
    return (await this.#marker(id)) !== undefined || (await present(await this.#directory("manifests"), `${id}.json`));
  }

  /** Every committed snapshot, newest first; one that cannot be read follows, with its failure. */
  async list(): Promise<CatalogEntry[]> {
    const entries: CatalogEntry[] = [];
    for (const id of await names(await this.#directory("commits"))) {
      if (!UUID.test(id)) continue;
      try {
        entries.push({ id, manifest: await this.load(id) });
      } catch (error) {
        entries.push({ id, damaged: normalizeStorageError(error), identity: await this.#identity(id) });
      }
    }
    return entries.sort(newestFirst);
  }

  async rename(id: string, label: string | null): Promise<SnapshotManifest> {
    if (label !== null && new TextEncoder().encode(label).byteLength > MAX_LABEL_BYTES) {
      throw new VMError("INVALID_ARGUMENT", "a restore point name is limited to 256 bytes");
    }
    const renamed = relabel(await this.load(id), label);
    await this.beginIntent({ kind: "rename", snapshot: id, label });
    await this.commit(renamed, await this.shippedSource(id));
    await this.endIntent(id);
    return renamed;
  }

  /** Removes a committed snapshot: its marker first, so it stops existing, then its manifest. */
  async delete(id: string): Promise<void> {
    if ((await this.#marker(id)) === undefined) throw new VMError("STORAGE_NOT_FOUND", "snapshot was not found");
    await this.beginIntent({ kind: "delete", snapshot: id });
    await this.#remove(id);
    await this.endIntent(id);
  }

  async beginIntent(intent: SnapshotIntent): Promise<void> {
    await writeOpfsFile(await this.#directory("intents"), `${intent.snapshot}.json`, encodeIntent(intent));
  }

  async endIntent(snapshot: string): Promise<void> {
    await removeIfPresent(await this.#directory("intents"), `${snapshot}.json`);
  }

  /**
   * Settles every intent a closed tab left: a capture without its commit marker is rolled back, a
   * delete is finished, and a rename is applied again to the stored manifest. An intent that
   * cannot be read is dropped; a collection still removes whatever it left unreferenced.
   */
  async recover(): Promise<void> {
    const intents = await this.#directory("intents");
    for (const name of await names(intents)) {
      const intent = await readIntent(intents, name);
      if (intent?.kind === "capture") {
        if ((await this.#marker(intent.snapshot)) === undefined) await this.#remove(intent.snapshot);
      } else if (intent?.kind === "delete") {
        await this.#remove(intent.snapshot);
      } else if (intent?.kind === "rename") {
        await this.#reapplyRename(intent.snapshot, intent.label);
      }
      await removeIfPresent(intents, name);
    }
  }

  /**
   * Removes every manifest without its commit marker and every marker without its manifest,
   * then every object that no committed snapshot and no entry of `roots` references. Returns
   * the object bytes freed.
   */
  async collect(roots: Iterable<string>): Promise<number> {
    await this.#removeOrphans();
    const reachability = await this.#reachability(roots);
    if (reachability.uncertain) return 0;
    let freed = 0;
    for (const name of await this.#objects.names()) {
      if (reachability.referenced.has(name)) continue;
      freed += (await this.#objects.size(name)) ?? 0;
      await this.#objects.remove(name);
    }
    return freed;
  }

  async usage(roots: Iterable<string>): Promise<ObjectUsage> {
    const reachability = await this.#reachability(roots);
    let referencedBytes = 0;
    let reclaimableBytes = 0;
    for (const name of await this.#objects.names()) {
      const bytes = (await this.#objects.size(name)) ?? 0;
      if (reachability.referenced.has(name)) referencedBytes += bytes;
      else if (!reachability.uncertain) reclaimableBytes += bytes;
    }
    return { referencedBytes, reclaimableBytes };
  }

  /**
   * The objects committed snapshots and `roots` reference. A snapshot whose commit marker no
   * longer matches still protects the objects its manifest names.
   */
  async #reachability(roots: Iterable<string>): Promise<Reachability> {
    const referenced = new Set(roots);
    let uncertain = false;
    for (const entry of await this.list()) {
      let manifest: SnapshotManifest;
      if ("manifest" in entry) {
        manifest = entry.manifest;
      } else {
        try {
          manifest = await decodeStored(await this.#manifestBytes(entry.id), entry.id, undefined);
        } catch {
          uncertain = true;
          continue;
        }
      }
      for (const ref of manifestObjects(manifest)) referenced.add(ref.sha256);
    }
    return { referenced, uncertain };
  }

  async #removeOrphans(): Promise<void> {
    const manifests = await this.#directory("manifests");
    const commits = await this.#directory("commits");
    const markers = new Set(await names(commits));
    const stored = new Set(await names(manifests));
    for (const name of stored) {
      if (!name.endsWith(".json") || !markers.has(name.slice(0, -".json".length))) await removeIfPresent(manifests, name);
    }
    for (const name of markers) {
      if (!stored.has(`${name}.json`)) await removeIfPresent(commits, name);
    }
  }

  async #reapplyRename(id: string, label: string | null): Promise<void> {
    let entry:{manifest:SnapshotManifest;source?:ShippedInstallIdentity};
    try {
      entry = await decodeStoredEntry(await this.#manifestBytes(id), id, undefined);
    } catch {
      return;
    }
    await this.commit(relabel(entry.manifest, label),entry.source);
  }

  /** What a damaged manifest still says about itself. */
  async #identity(id: string): Promise<SnapshotIdentity> {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(await this.#manifestBytes(id)));
    } catch {
      value = undefined;
    }
    return readSnapshotIdentity(value);
  }

  async #remove(id: string): Promise<void> {
    await removeIfPresent(await this.#directory("commits"), id);
    await removeIfPresent(await this.#directory("manifests"), `${id}.json`);
  }

  async #marker(id: string): Promise<string | undefined> {
    try {
      return new TextDecoder().decode(await readOpfsFile(await this.#directory("commits"), id, MARKER_BYTES));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async #manifestBytes(id: string): Promise<Uint8Array<ArrayBuffer>> {
    try {
      return await readOpfsFile(await this.#directory("manifests"), `${id}.json`, MAX_CATALOG_BYTES);
    } catch (error) {
      if (isNotFound(error)) throw damaged("snapshot manifest is missing");
      throw error;
    }
  }

  #directory(name: "manifests" | "commits" | "intents"): Promise<FileSystemDirectoryHandle> {
    return this.#root.getDirectoryHandle(name, { create: true });
  }
}

/** Decodes stored manifest bytes, checking them against their commit marker when one is given. */
async function decodeStored(
  bytes: Uint8Array<ArrayBuffer>,
  id: string,
  marker: string | undefined,
): Promise<SnapshotManifest> {
  return (await decodeStoredEntry(bytes,id,marker)).manifest;
}

async function decodeStoredEntry(bytes: Uint8Array<ArrayBuffer>, id: string, marker: string | undefined): Promise<{manifest: SnapshotManifest; source?: ShippedInstallIdentity}> {
  if (marker !== undefined && (await sha256Hex(bytes)) !== marker) {
    throw damaged("snapshot commit marker does not match its manifest");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw damaged("snapshot manifest is not valid JSON");
  }
  const envelope = record(parsed,"snapshot catalog record");
  let source: ShippedInstallIdentity | undefined;
  let value: unknown = parsed;
  if (envelope["format"] === "oxidevm-snapshot-catalog") {
    exactKeys(envelope,["format","version","manifest","shippedSource"]);
    if (envelope["version"] !== 1) throw damaged("snapshot catalog version is unsupported");
    source = decodeShippedInstallIdentity(envelope["shippedSource"]);
    value = envelope["manifest"];
  }
  const manifest = decodeSnapshotManifest(value);
  encodeSnapshotManifest(manifest);
  if (manifest.id !== id) throw damaged("snapshot manifest names another snapshot");
  return {manifest,...(source === undefined ? {} : {source})};
}

function relabel(manifest: SnapshotManifest, label: string | null): SnapshotManifest {
  const unlabelled = { ...manifest };
  Reflect.deleteProperty(unlabelled, "label");
  return label === null ? unlabelled : { ...unlabelled, label };
}

function newestFirst(left: CatalogEntry, right: CatalogEntry): number {
  const leftTime = "manifest" in left ? left.manifest.capturedAtUnixMs : -1;
  const rightTime = "manifest" in right ? right.manifest.capturedAtUnixMs : -1;
  return rightTime - leftTime || left.id.localeCompare(right.id);
}

function encodeIntent(intent: SnapshotIntent): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${JSON.stringify({ schema: 1, ...intent })}\n`);
}

/** The intent stored as `name`, or `undefined` when it cannot be read as one. */
async function readIntent(intents: FileSystemDirectoryHandle, name: string): Promise<SnapshotIntent | undefined> {
  try {
    return decodeIntent(JSON.parse(new TextDecoder().decode(await readOpfsFile(intents, name, MAX_INTENT_BYTES))), name);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof VMError) return undefined;
    throw error;
  }
}

function decodeIntent(value: unknown, name: string): SnapshotIntent | undefined {
  const intent = record(value, "snapshot intent");
  const kind = string(intent["kind"], "snapshot intent kind");
  const snapshot = string(intent["snapshot"], "snapshot intent target");
  if (intent["schema"] !== 1 || !UUID.test(snapshot) || name !== `${snapshot}.json`) return undefined;
  if (kind === "capture" || kind === "delete") {
    exactKeys(intent, ["schema", "kind", "snapshot"]);
    return { kind, snapshot };
  }
  if (kind !== "rename") return undefined;
  exactKeys(intent, ["schema", "kind", "snapshot", "label"]);
  const label = intent["label"];
  return { kind, snapshot, label: label === null ? null : string(label, "snapshot intent label") };
}

async function names(directory: FileSystemDirectoryHandle): Promise<string[]> {
  const found: string[] = [];
  for await (const name of directory.keys()) found.push(name);
  return found;
}

async function present(directory: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function removeIfPresent(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function damaged(message: string): VMError {
  return new VMError("STORAGE_ERROR", message, { reason: "snapshot-damaged" });
}
