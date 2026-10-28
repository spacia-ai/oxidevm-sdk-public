import { VMError } from "../errors.js";
import { exactKeys, integer, record } from "../decode.js";
import { decodeSnapshotRef, MAX_APP_DATA_BYTES, type SnapshotKind } from "../protocol/snapshots.js";
import { supportsNativeCheckpointVersion } from "../protocol/native-capture.js";
import { decodeHash, decodeImageName, decodeKind, decodeLabel, decodeObjectRef, decodeParent, invalidManifest } from "./snapshot-manifest-fields.js";
import { MAX_AGENT_STATE_BYTES, MAX_ASSET_BYTES, SNAPSHOT_CHUNK_BYTES, type ChunkRef, type ObjectRef } from "./snapshot-manifest.js";

/** Complete opaque stream. Native OXUC metadata owns page/blob identities and the final live index. */
export interface SnapshotStream {
  readonly bytes: number;
  readonly chunks: readonly ChunkRef[];
}

/** Userspace restore points carry this schema number. */
export const USERSPACE_SNAPSHOT_SCHEMA = 4;
/** The previous Userspace layout: refused with an older-format error by every decoder, never decoded. */
export const LEGACY_USERSPACE_SNAPSHOT_SCHEMA = 3;

/** Whether a manifest with this schema number belongs to the Userspace decoder. */
export function isUserspaceSnapshotSchema(schema: unknown): boolean {
  return schema === USERSPACE_SNAPSHOT_SCHEMA;
}

export interface UserspaceSnapshotManifest {
  readonly schema: typeof USERSPACE_SNAPSHOT_SCHEMA;
  readonly mode: "userspace";
  readonly id: string;
  readonly createdAt: string;
  readonly kind: SnapshotKind;
  readonly label?: string;
  readonly capturedAtUnixMs: number;
  readonly parent: string | null;
  readonly compatibility: { readonly format: "OXUC"; readonly version: number; readonly abiVersion: number; readonly memoryBytes: number };
  readonly graph: SnapshotStream;
  readonly payloads: SnapshotStream;
  /** Managed base blobs are acquired through RootfsStore; the pinned signed manifest is archived. */
  readonly rootfs: {
    readonly origin: "managed";
    readonly image: { readonly id: string; readonly version: string };
    readonly rootTreeSha256: string;
    readonly manifest: ObjectRef;
  };
  readonly host?: { readonly attachment?: ObjectRef; readonly appData?: ObjectRef };
  /** Portable native persistence streams. Local selected-generation pins use the snapshot UUID. */
  readonly durable?: {
    readonly workspace?: { readonly baseSha256: string; readonly snapshot: SnapshotStream; readonly delta: SnapshotStream;
      readonly dependencies?: { readonly inputsSha256: string; readonly tree: SnapshotStream } };
    readonly root?: SnapshotStream;
  };
}

// Fits the existing archive envelope; destination policies still govern native graph admission.
const MAX_STREAM_BYTES = 16 * 1024 ** 3;

export function decodeUserspaceManifest(manifest: Readonly<Record<string, unknown>>): UserspaceSnapshotManifest {
  if (manifest["schema"] === LEGACY_USERSPACE_SNAPSHOT_SCHEMA && manifest["mode"] === "userspace") {
    throw new VMError("SNAPSHOT_VERSION", "snapshot format is unsupported", { reason: "snapshot-older-format" });
  }
  if (manifest["schema"] !== USERSPACE_SNAPSHOT_SCHEMA || manifest["mode"] !== "userspace") invalidManifest();
  const compatibility = record(manifest["compatibility"], "native snapshot compatibility");
  if (compatibility["format"] !== "OXUC") invalidManifest();
  // Classify a different logical format before fields introduced by that format.
  const version = integer(compatibility["version"], "native snapshot version", 0);
  if (!supportsNativeCheckpointVersion(version)) throw new VMError("SNAPSHOT_VERSION", "native snapshot format is unsupported", {
    reason: version < 1 ? "snapshot-older-format" : "snapshot-newer-format",
  });
  exactKeys(manifest, ["schema", "mode", "id", "createdAt", "kind", "capturedAtUnixMs", "parent", "compatibility", "graph", "payloads", "rootfs"], ["label", "host", "durable"]);
  exactKeys(compatibility, ["format", "version", "abiVersion", "memoryBytes"]);
  const memoryBytes = integer(compatibility["memoryBytes"], "native snapshot memory", 16 * SNAPSHOT_CHUNK_BYTES, 3072 * SNAPSHOT_CHUNK_BYTES);
  if (memoryBytes % SNAPSHOT_CHUNK_BYTES !== 0) invalidManifest();
  const rootfs = record(manifest["rootfs"], "snapshot rootfs");
  exactKeys(rootfs, ["origin", "image", "rootTreeSha256", "manifest"]);
  if (rootfs["origin"] !== "managed") invalidManifest();
  const image = record(rootfs["image"], "snapshot rootfs image");
  exactKeys(image, ["id", "version"]);
  return {
    schema: USERSPACE_SNAPSHOT_SCHEMA, mode: "userspace",
    ...decodeSnapshotRef({ id: manifest["id"], createdAt: manifest["createdAt"] }),
    kind: decodeKind(manifest["kind"]),
    ...(manifest["label"] === undefined ? {} : { label: decodeLabel(manifest["label"]) }),
    capturedAtUnixMs: integer(manifest["capturedAtUnixMs"], "snapshot time", 0),
    parent: decodeParent(manifest["parent"]),
    compatibility: {
      format: "OXUC", version,
      abiVersion: integer(compatibility["abiVersion"], "native snapshot ABI", 1), memoryBytes,
    },
    graph: decodeStream(manifest["graph"], 1),
    payloads: decodeStream(manifest["payloads"], 0),
    rootfs: {
      origin: "managed", image: { id: decodeImageName(image["id"]), version: decodeImageName(image["version"]) },
      rootTreeSha256: decodeHash(rootfs["rootTreeSha256"]), manifest: decodeObjectRef(rootfs["manifest"], 1, MAX_ASSET_BYTES),
    },
    ...(manifest["host"] === undefined ? {} : { host: decodeHost(manifest["host"]) }),
    ...(manifest["durable"] === undefined ? {} : { durable: decodeDurable(manifest["durable"]) }),
  };
}

function decodeStream(value: unknown, minimum: number): SnapshotStream {
  const stream = record(value, "snapshot stream");
  exactKeys(stream, ["bytes", "chunks"]);
  const bytes = integer(stream["bytes"], "snapshot stream bytes", minimum, MAX_STREAM_BYTES);
  const chunks = stream["chunks"];
  if (!Array.isArray(chunks) || chunks.length !== Math.ceil(bytes / SNAPSHOT_CHUNK_BYTES)) invalidManifest();
  return { bytes, chunks: chunks.map((value: unknown, index: number) => {
    const chunk = record(value, "snapshot stream chunk");
    exactKeys(chunk, ["index", "sha256", "bytes"]);
    if (chunk["index"] !== index) invalidManifest();
    const length = Math.min(SNAPSHOT_CHUNK_BYTES, bytes - index * SNAPSHOT_CHUNK_BYTES);
    return { index, ...decodeObjectRef(chunk, length, length) };
  }) };
}

function decodeHost(value: unknown): NonNullable<UserspaceSnapshotManifest["host"]> {
  const host = record(value, "native host attachment");
  exactKeys(host, [], ["attachment", "appData"]);
  if (host["attachment"] === undefined && host["appData"] === undefined) invalidManifest();
  return {
    ...(host["attachment"] === undefined ? {} : { attachment: decodeObjectRef(host["attachment"], 1, MAX_AGENT_STATE_BYTES) }),
    ...(host["appData"] === undefined ? {} : { appData: decodeObjectRef(host["appData"], 0, MAX_APP_DATA_BYTES) }),
  };
}

function decodeDurable(value: unknown): NonNullable<UserspaceSnapshotManifest["durable"]> {
  const durable = record(value, "native durable streams");
  exactKeys(durable, [], ["workspace", "root"]);
  if (durable["workspace"] === undefined && durable["root"] === undefined) invalidManifest();
  return {
    ...(durable["workspace"] === undefined ? {} : { workspace: decodeWorkspace(durable["workspace"]) }),
    ...(durable["root"] === undefined ? {} : { root: decodeStream(durable["root"], 0) }),
  };
}
type NativeWorkspaceFiles = NonNullable<NonNullable<UserspaceSnapshotManifest["durable"]>["workspace"]>;
function decodeWorkspace(value: unknown): NativeWorkspaceFiles {
  const workspace = record(value, "native workspace streams");
  exactKeys(workspace, ["baseSha256", "snapshot", "delta"], ["dependencies"]);
  let dependencies: NativeWorkspaceFiles["dependencies"];
  if (workspace["dependencies"] !== undefined) {
    const value = record(workspace["dependencies"], "native workspace dependencies");
    exactKeys(value, ["inputsSha256", "tree"]);
    dependencies = { inputsSha256: decodeHash(value["inputsSha256"]), tree: decodeStream(value["tree"], 1) };
  }
  return {
    baseSha256: decodeHash(workspace["baseSha256"]),
    snapshot: decodeStream(workspace["snapshot"], 1), delta: decodeStream(workspace["delta"], 0),
    ...(dependencies === undefined ? {} : { dependencies }),
  };
}

export function userspaceObjects(manifest: UserspaceSnapshotManifest): ObjectRef[] {
  const refs: ObjectRef[] = [...manifest.graph.chunks, ...manifest.payloads.chunks, manifest.rootfs.manifest];
  if (manifest.host?.attachment !== undefined) refs.push(manifest.host.attachment);
  if (manifest.host?.appData !== undefined) refs.push(manifest.host.appData);
  if (manifest.durable?.root !== undefined) refs.push(...manifest.durable.root.chunks);
  const workspace = manifest.durable?.workspace;
  if (workspace !== undefined) {
    refs.push(...workspace.snapshot.chunks, ...workspace.delta.chunks);
    if (workspace.dependencies !== undefined) refs.push(...workspace.dependencies.tree.chunks);
  }
  return refs;
}

export function encodeUserspaceManifest(manifest: UserspaceSnapshotManifest): Uint8Array<ArrayBuffer> {
  // Decode projects every nested field in canonical order and validates programmatic producers too.
  return new TextEncoder().encode(JSON.stringify(decodeUserspaceManifest({
    schema: manifest.schema, mode: manifest.mode, id: manifest.id, createdAt: manifest.createdAt,
    kind: manifest.kind, ...(manifest.label === undefined ? {} : { label: manifest.label }),
    capturedAtUnixMs: manifest.capturedAtUnixMs, parent: manifest.parent,
    compatibility: manifest.compatibility, graph: manifest.graph, payloads: manifest.payloads,
    rootfs: manifest.rootfs, ...(manifest.host === undefined ? {} : { host: manifest.host }),
    ...(manifest.durable === undefined ? {} : { durable: manifest.durable }),
  })));
}
