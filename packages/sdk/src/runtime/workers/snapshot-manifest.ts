import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeSnapshotRef, MAX_APP_DATA_BYTES, SNAPSHOT_KINDS, type SnapshotKind } from "../protocol/snapshots.js";
import { decodeObjectRef, decodeImageName, decodeKind, decodeLabel, decodeParent, decodeHash, invalidManifest, MAX_LABEL_BYTES } from "./snapshot-manifest-fields.js";
import { decodeUserspaceManifest, encodeUserspaceManifest, isUserspaceSnapshotSchema, LEGACY_USERSPACE_SNAPSHOT_SCHEMA, USERSPACE_SNAPSHOT_SCHEMA, userspaceObjects, type UserspaceSnapshotManifest } from "./snapshot-userspace-manifest.js";
export { USERSPACE_SNAPSHOT_SCHEMA } from "./snapshot-userspace-manifest.js";
export type { UserspaceSnapshotManifest, SnapshotStream } from "./snapshot-userspace-manifest.js";

/**
 * Snapshot manifest schema 2 (ADR 0014 R5). RAM chunks list non-zero content; an absent RAM
 * chunk is zero. Disk chunks list the differences from the base: an absent disk chunk is the
 * base's content and `{index, zero: true}` is an explicit zero. A managed disk references its
 * shared base image by identity; a core (raw) disk keeps its own base chunks.
 */
export const SNAPSHOT_SCHEMA = 2;
/** RAM and disk are captured, stored and restored in chunks of this size. */
export const SNAPSHOT_CHUNK_BYTES = 1024 * 1024;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_ASSET_BYTES = 128 * 1024 * 1024;
export const MAX_MACHINE_RECORD_BYTES = 128 * 1024 * 1024;
/** A workspace index lists at most a million paths. */
const MAX_WORKSPACE_INDEX_BYTES = 256 * 1024 * 1024;
/**
 * An OXHA guest-agent session record: transport state, process tails and the console tail; it
 * holds the largest record the control worker writes (about 34 MiB).
 */
export const MAX_AGENT_STATE_BYTES = 40 * 1024 * 1024;
const MIN_MACHINE_RECORD_BYTES = 12;
const MIN_MEMORY_BYTES = 16 * SNAPSHOT_CHUNK_BYTES;
const MAX_MEMORY_BYTES = 3072 * SNAPSHOT_CHUNK_BYTES;
const MAX_MANAGED_DISK_BYTES = 64 * 1024 * 1024 * 1024;

export interface ObjectRef {
  readonly sha256: string;
  readonly bytes: number;
}

export interface ChunkRef extends ObjectRef {
  readonly index: number;
}

export interface ZeroChunk {
  readonly index: number;
  readonly zero: true;
}

export type DiskChunk = ChunkRef | ZeroChunk;

export type SnapshotDisk =
  | {
      readonly origin: "core";
      readonly bytes: number;
      readonly baseIdentity: string;
      /** The raw boot disk's non-zero chunks. */
      readonly base: readonly ChunkRef[];
      readonly chunks: readonly DiskChunk[];
    }
  | {
      readonly origin: "managed";
      readonly bytes: number;
      /** The managed image identity whose shared base the absent chunks read. */
      readonly baseIdentity: string;
      /** That image's profile id and version. */
      readonly image: { readonly id: string; readonly version: string };
      readonly chunks: readonly DiskChunk[];
    };

export type SnapshotManifest = SystemSnapshotManifest | UserspaceSnapshotManifest;
export type SnapshotMode = "system" | "userspace";
export function snapshotMode(manifest: SnapshotManifest): SnapshotMode {
  return manifest.schema === 2 ? "system" : manifest.mode;
}

export interface SystemSnapshotManifest {
  readonly schema: typeof SNAPSHOT_SCHEMA;
  readonly id: string;
  readonly createdAt: string;
  readonly kind: SnapshotKind;
  readonly label?: string;
  readonly capturedAtUnixMs: number;
  /** The capture this one was taken incrementally from, if any. */
  readonly parent: string | null;
  readonly machine: { readonly record: ObjectRef; readonly memoryBytes: number; readonly vcpus: number };
  readonly ram: readonly ChunkRef[];
  readonly disk: SnapshotDisk | null;
  readonly assets: { readonly kernel: ObjectRef; readonly initrd?: ObjectRef };
  /**
   * The host side at the cut: the guest-agent session (OXHA), when an agent was running, and the
   * page data saved with the restore point.
   */
  readonly host?: { readonly agent?: ObjectRef; readonly appData?: ObjectRef };
  /**
   * The workspace store generation the guest's /workspace matched, with that generation's
   * index (workspace-index.ts), so a resume can carry later store changes into the guest.
   */
  readonly workspace?: { readonly baseSha256: string; readonly generation: number; readonly index: ObjectRef };
}

/** What a restore point says about itself, read even from a manifest that cannot be decoded. */
export interface SnapshotIdentity {
  readonly mode?: SnapshotMode;
  readonly createdAt: string;
  readonly kind: SnapshotKind;
  readonly label?: string;
  readonly capturedAtUnixMs: number;
}

/** A damaged restore point whose identity cannot be read: an automatic save of unknown time. */
const UNKNOWN_IDENTITY: SnapshotIdentity = { createdAt: new Date(0).toISOString(), kind: "automatic", capturedAtUnixMs: 0 };

/**
 * Reads the identity fields of a manifest leniently, so a damaged restore point or one in
 * another schema can still be listed (and deleted). Every schema keeps these fields; whatever
 * cannot be read falls back to an automatic save of unknown time.
 */
export function readSnapshotIdentity(value: unknown): SnapshotIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return UNKNOWN_IDENTITY;
  const manifest = record(value, "snapshot manifest");
  const createdAt = manifest["createdAt"];
  const capturedAtUnixMs = manifest["capturedAtUnixMs"];
  const kind = SNAPSHOT_KINDS.find((candidate) => candidate === manifest["kind"]);
  if (
    typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt
    || typeof capturedAtUnixMs !== "number" || !Number.isSafeInteger(capturedAtUnixMs) || capturedAtUnixMs < 0
    || kind === undefined
  ) {
    return UNKNOWN_IDENTITY;
  }
  const label = manifest["label"];
  const readable = typeof label === "string" && new TextEncoder().encode(label).byteLength <= MAX_LABEL_BYTES;
  // A manifest without a mode is a system manifest; any other value must be a runtime this build knows.
  const stored = manifest["mode"];
  const mode = stored === undefined || stored === "system" ? "system" : stored === "userspace" ? "userspace" : undefined;
  if (mode === undefined) return UNKNOWN_IDENTITY;
  return { mode, createdAt, kind, ...(readable ? { label } : {}), capturedAtUnixMs };
}

export type DiskChunkSource =
  | { readonly kind: "base" }
  | { readonly kind: "zero" }
  | { readonly kind: "object"; readonly ref: ObjectRef };

/** Where a restore reads disk chunk `index` from. */
export function diskChunkSource(manifest: SystemSnapshotManifest, index: number): DiskChunkSource {
  const chunk = manifest.disk?.chunks.find((candidate) => candidate.index === index);
  if (chunk === undefined) return { kind: "base" };
  if (isZeroChunk(chunk)) return { kind: "zero" };
  return { kind: "object", ref: objectRef(chunk) };
}

export function isZeroChunk(chunk: DiskChunk): chunk is ZeroChunk {
  return "zero" in chunk;
}

export function objectRef(ref: ObjectRef): ObjectRef {
  return { sha256: ref.sha256, bytes: ref.bytes };
}

/** Every stored object a manifest needs: machine record, boot assets, RAM and disk chunks. */
export function manifestObjects(manifest: SnapshotManifest): ObjectRef[] {
  if (manifest.schema === USERSPACE_SNAPSHOT_SCHEMA) return userspaceObjects(manifest);
  const refs: ObjectRef[] = [manifest.machine.record, manifest.assets.kernel, ...manifest.ram];
  if (manifest.assets.initrd !== undefined) refs.push(manifest.assets.initrd);
  if (manifest.host?.agent !== undefined) refs.push(manifest.host.agent);
  if (manifest.host?.appData !== undefined) refs.push(manifest.host.appData);
  if (manifest.workspace !== undefined) refs.push(manifest.workspace.index);
  if (manifest.disk?.origin === "core") refs.push(...manifest.disk.base);
  for (const chunk of manifest.disk?.chunks ?? []) if (!isZeroChunk(chunk)) refs.push(chunk);
  return refs;
}

/** The byte length of chunk `index` of a `totalBytes` image. */
export function snapshotChunkLength(index: number, totalBytes: number): number {
  const start = index * SNAPSHOT_CHUNK_BYTES;
  if (!Number.isSafeInteger(index) || index < 0 || start >= totalBytes) {
    throw new VMError("STORAGE_ERROR", "snapshot chunk is out of bounds");
  }
  return Math.min(SNAPSHOT_CHUNK_BYTES, totalBytes - start);
}

/** Canonical bytes: fixed key order, so the commit marker hash is reproducible. */
export function encodeSnapshotManifest(manifest: SnapshotManifest): Uint8Array<ArrayBuffer> {
  if (manifest.schema === USERSPACE_SNAPSHOT_SCHEMA) return encodeUserspaceManifest(manifest);
  const disk = manifest.disk;
  const canonical = {
    schema: manifest.schema,
    id: manifest.id,
    createdAt: manifest.createdAt,
    kind: manifest.kind,
    ...(manifest.label === undefined ? {} : { label: manifest.label }),
    capturedAtUnixMs: manifest.capturedAtUnixMs,
    parent: manifest.parent,
    machine: {
      record: objectRef(manifest.machine.record),
      memoryBytes: manifest.machine.memoryBytes,
      vcpus: manifest.machine.vcpus,
    },
    ram: manifest.ram.map(chunkRef),
    disk: disk === null
      ? null
      : disk.origin === "core"
        ? {
            origin: disk.origin,
            bytes: disk.bytes,
            baseIdentity: disk.baseIdentity,
            base: disk.base.map(chunkRef),
            chunks: disk.chunks.map(diskChunk),
          }
        : {
            origin: disk.origin,
            bytes: disk.bytes,
            baseIdentity: disk.baseIdentity,
            image: { id: disk.image.id, version: disk.image.version },
            chunks: disk.chunks.map(diskChunk),
          },
    assets: {
      kernel: objectRef(manifest.assets.kernel),
      ...(manifest.assets.initrd === undefined ? {} : { initrd: objectRef(manifest.assets.initrd) }),
    },
    ...(manifest.host === undefined ? {} : { host: encodeHost(manifest.host) }),
    ...(manifest.workspace === undefined ? {} : {
      workspace: {
        baseSha256: manifest.workspace.baseSha256,
        generation: manifest.workspace.generation,
        index: objectRef(manifest.workspace.index),
      },
    }),
  };
  return new TextEncoder().encode(JSON.stringify(canonical));
}

export function decodeSnapshotManifest(value: unknown): SnapshotManifest {
  const manifest = record(value, "snapshot manifest");
  const schema = manifest["schema"];
  if (isUserspaceSnapshotSchema(schema)) return decodeUserspaceManifest(manifest);
  if (schema === LEGACY_USERSPACE_SNAPSHOT_SCHEMA) throw new VMError("SNAPSHOT_VERSION", "snapshot format is unsupported", { reason: "snapshot-older-format" });
  if (schema !== SNAPSHOT_SCHEMA) {
    if (typeof schema === "number" && Number.isSafeInteger(schema) && schema >= 1) {
      throw new VMError("SNAPSHOT_VERSION", "snapshot format is unsupported", {
        reason: schema < SNAPSHOT_SCHEMA ? "snapshot-older-format" : "snapshot-newer-format",
      });
    }
    return invalidManifest();
  }
  exactKeys(
    manifest,
    ["schema", "id", "createdAt", "kind", "capturedAtUnixMs", "parent", "machine", "ram", "disk", "assets"],
    ["label", "host", "workspace"],
  );
  const { id, createdAt } = decodeSnapshotRef({ id: manifest["id"], createdAt: manifest["createdAt"] });
  const kind = decodeKind(manifest["kind"]);
  const label = manifest["label"] === undefined ? undefined : decodeLabel(manifest["label"]);
  const machine = record(manifest["machine"], "snapshot machine");
  exactKeys(machine, ["record", "memoryBytes", "vcpus"]);
  const memoryBytes = integer(machine["memoryBytes"], "snapshot memory bytes", MIN_MEMORY_BYTES, MAX_MEMORY_BYTES);
  if (memoryBytes % SNAPSHOT_CHUNK_BYTES !== 0) invalidManifest();
  const assets = record(manifest["assets"], "snapshot assets");
  exactKeys(assets, ["kernel"], ["initrd"]);
  const host = manifest["host"] === undefined ? undefined : decodeHost(manifest["host"]);
  const workspace = manifest["workspace"] === undefined ? undefined : decodeWorkspace(manifest["workspace"]);
  return {
    schema: SNAPSHOT_SCHEMA,
    id,
    createdAt,
    kind,
    ...(label === undefined ? {} : { label }),
    capturedAtUnixMs: integer(manifest["capturedAtUnixMs"], "capture time", 0),
    parent: decodeParent(manifest["parent"]),
    machine: {
      record: decodeObjectRef(machine["record"], MIN_MACHINE_RECORD_BYTES, MAX_MACHINE_RECORD_BYTES),
      memoryBytes,
      vcpus: integer(machine["vcpus"], "snapshot vCPUs", 1, 4),
    },
    ram: decodeChunkRefs(manifest["ram"], memoryBytes),
    disk: decodeDisk(manifest["disk"]),
    assets: {
      kernel: decodeObjectRef(assets["kernel"], 1, MAX_ASSET_BYTES),
      ...(assets["initrd"] === undefined ? {} : { initrd: decodeObjectRef(assets["initrd"], 1, MAX_ASSET_BYTES) }),
    },
    ...(host === undefined ? {} : { host }),
    ...(workspace === undefined ? {} : { workspace }),
  };
}

function encodeHost(host: NonNullable<SystemSnapshotManifest["host"]>): NonNullable<SystemSnapshotManifest["host"]> {
  return {
    ...(host.agent === undefined ? {} : { agent: objectRef(host.agent) }),
    ...(host.appData === undefined ? {} : { appData: objectRef(host.appData) }),
  };
}

function decodeHost(value: unknown): NonNullable<SystemSnapshotManifest["host"]> {
  const host = record(value, "snapshot host state");
  exactKeys(host, [], ["agent", "appData"]);
  if (host["agent"] === undefined && host["appData"] === undefined) invalidManifest();
  return {
    ...(host["agent"] === undefined ? {} : { agent: decodeObjectRef(host["agent"], 1, MAX_AGENT_STATE_BYTES) }),
    ...(host["appData"] === undefined ? {} : { appData: decodeObjectRef(host["appData"], 1, MAX_APP_DATA_BYTES) }),
  };
}

function decodeWorkspace(value: unknown): NonNullable<SystemSnapshotManifest["workspace"]> {
  const workspace = record(value, "snapshot workspace");
  exactKeys(workspace, ["baseSha256", "generation", "index"]);
  const baseSha256 = string(workspace["baseSha256"], "snapshot workspace base");
  if (!/^[0-9a-f]{64}$/u.test(baseSha256)) invalidManifest();
  return {
    baseSha256,
    generation: integer(workspace["generation"], "snapshot workspace generation", 1),
    index: decodeObjectRef(workspace["index"], 1, MAX_WORKSPACE_INDEX_BYTES),
  };
}

function decodeDisk(value: unknown): SnapshotDisk | null {
  if (value === null) return null;
  const disk = record(value, "snapshot disk");
  const origin = string(disk["origin"], "snapshot disk origin");
  if (origin === "core") {
    exactKeys(disk, ["origin", "bytes", "baseIdentity", "base", "chunks"]);
    const bytes = decodeDiskBytes(disk["bytes"], MAX_ASSET_BYTES);
    return {
      origin,
      bytes,
      baseIdentity: decodeHash(disk["baseIdentity"]),
      base: decodeChunkRefs(disk["base"], bytes),
      chunks: decodeDiskChunks(disk["chunks"], bytes),
    };
  }
  if (origin !== "managed") return invalidManifest();
  exactKeys(disk, ["origin", "bytes", "baseIdentity", "image", "chunks"]);
  const bytes = decodeDiskBytes(disk["bytes"], MAX_MANAGED_DISK_BYTES);
  const image = record(disk["image"], "snapshot disk image");
  exactKeys(image, ["id", "version"]);
  return {
    origin,
    bytes,
    baseIdentity: decodeHash(disk["baseIdentity"]),
    image: { id: decodeImageName(image["id"]), version: decodeImageName(image["version"]) },
    chunks: decodeDiskChunks(disk["chunks"], bytes),
  };
}

function decodeDiskBytes(value: unknown, maximum: number): number {
  const bytes = integer(value, "snapshot disk bytes", 512, maximum);
  if (bytes % 512 !== 0) invalidManifest();
  return bytes;
}

function decodeChunkRefs(value: unknown, totalBytes: number): ChunkRef[] {
  return decodeIndexed(value, totalBytes, (entry, index, length) => {
    exactKeys(entry, ["index", "sha256", "bytes"]);
    return { index, ...decodeObjectRef(entry, length, length) };
  });
}

function decodeDiskChunks(value: unknown, totalBytes: number): DiskChunk[] {
  return decodeIndexed<DiskChunk>(value, totalBytes, (entry, index, length) => {
    if (Object.hasOwn(entry, "zero")) {
      exactKeys(entry, ["index", "zero"]);
      if (entry["zero"] !== true) invalidManifest();
      return { index, zero: true };
    }
    exactKeys(entry, ["index", "sha256", "bytes"]);
    return { index, ...decodeObjectRef(entry, length, length) };
  });
}

function decodeIndexed<T>(
  value: unknown,
  totalBytes: number,
  decode: (entry: Readonly<Record<string, unknown>>, index: number, length: number) => T,
): T[] {
  if (!Array.isArray(value) || value.length > Math.ceil(totalBytes / SNAPSHOT_CHUNK_BYTES)) {
    return invalidManifest();
  }
  let previous = -1;
  return value.map((item: unknown) => {
    const entry = record(item, "snapshot chunk");
    const index = integer(entry["index"], "snapshot chunk index", 0);
    if (index <= previous) invalidManifest();
    previous = index;
    return decode(entry, index, snapshotChunkLength(index, totalBytes));
  });
}

function chunkRef(chunk: ChunkRef): ChunkRef {
  return { index: chunk.index, sha256: chunk.sha256, bytes: chunk.bytes };
}

function diskChunk(chunk: DiskChunk): DiskChunk {
  return isZeroChunk(chunk) ? { index: chunk.index, zero: true } : chunkRef(chunk);
}
