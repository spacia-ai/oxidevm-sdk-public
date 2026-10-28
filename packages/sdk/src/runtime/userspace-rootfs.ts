import { decodeRootfsEntries, decodeRootfsRuntimes } from "./userspace-rootfs-tree.js";
import { compareWorkspacePaths, withWorkspaceMetadataTimes, type FileOwnership, type FileTimes } from "./workspace-record.js";
import { decodeFilesystemRecord, encodeFilesystemRecord, type RootfsMetadataEntry } from "./userspace-rootfs-record.js";
import {
  exactKeys,
  integer,
  protocolError,
  record,
  string,
} from "./decode.js";
import { decodeEd25519Signature, verifyEd25519 } from "./ed25519.js";
import { VMError } from "./errors.js";
import { decodeManagedImageSnapshots,type ManagedImageSnapshot,managedImageUrl } from "./managed-image.js";
import { canonicalImageBytes, rememberArtifactURL } from "./image-provenance.js";
import { decodeUserspaceRootfsPacks, type UserspaceRootfsPacks } from "./userspace-rootfs-packs.js";
export const USERSPACE_ROOTFS_SCHEMA = 8;
export { ROOTFS_PACK_BYTES, decodeRootfsPackIndex } from "./userspace-rootfs-packs.js";
export type { RootfsPackIndex, RootfsPackArtifact, UserspaceRootfsPacks } from "./userspace-rootfs-packs.js";

const SHA256 = /^[0-9a-f]{64}$/u;
export const MAX_ROOTFS_METADATA_BYTES = 128 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_FILES = 262_144;
const MAX_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_DEPTH = 64;

export interface UserspaceRootfsBlob {
  readonly sha256: string;
  readonly bytes: number;
  readonly url: URL;
}

export type UserspaceRootfsEvidence = UserspaceRootfsBlob;

export type UserspaceRootfsEntry = { readonly ownership?: FileOwnership; readonly times?: FileTimes } & (
  | { readonly type: "directory"; readonly path: string; readonly mode: number }
  | { readonly type: "file"; readonly path: string; readonly mode: number; readonly blob: string }
  | { readonly type: "symlink"; readonly path: string; readonly mode: number; readonly target: string }
  | { readonly type: "hardlink"; readonly path: string; readonly mode: number; readonly target: string });

export interface UserspaceRootfsManifest {
  readonly manifestUrl?: URL;
  readonly resources?: { readonly memoryMiB: number; readonly maxProcesses?: number };
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  readonly packs?: UserspaceRootfsPacks;
  readonly snapshots?:readonly ManagedImageSnapshot[];
  readonly kind: "linux-user-rootfs";
  readonly id: string;
  readonly version: string;
  readonly architecture: "x86_64";
  readonly cpuProfile: "x86-64-v2" | "x86-64-v3";
  readonly sourceDateEpoch: number;
  readonly rootTreeSha256: string;
  readonly workspaceBaseSha256?: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly blobs: readonly UserspaceRootfsBlob[];
  readonly entries: readonly UserspaceRootfsEntry[];
  readonly runtimes: {
    readonly muslLoader?: string;
    readonly glibcLoader?: string;
    readonly node?: string;
    readonly bun?: string;
    readonly supportingFiles: readonly string[];
  };
  readonly provenance: {
    readonly keyId: string;
    readonly signature: string;
    readonly sbom: UserspaceRootfsEvidence;
    readonly notices: UserspaceRootfsEvidence;
    readonly correspondingSources: UserspaceRootfsEvidence;
    readonly reproducibility: UserspaceRootfsEvidence;
  };
}

export interface TrustedRootfsKey {
  readonly keyId: string;
  readonly publicKey: Uint8Array<ArrayBuffer>;
}

export function decodeUserspaceRootfsManifest(
  value: unknown,
  manifestUrl: URL,
): UserspaceRootfsManifest {
  const source = record(value, "Userspace rootfs manifest");
  const schemaVersion = integer(source["schemaVersion"], "schemaVersion");
  exactKeys(source, [
    "schemaVersion", "kind", "id", "version", "architecture", "cpuProfile",
    "sourceDateEpoch", "rootTreeSha256", "fileCount", "totalBytes", "blobs",
    "entries", "runtimes", "provenance", ...(schemaVersion >= 3 ? ["workspaceBaseSha256"] : []), ...(schemaVersion >= 8 ? ["packs"] : []),
  ], [...(schemaVersion >= 5 ? ["resources"] : []),...(schemaVersion >= 7 ? ["snapshots"] : [])]);
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3 && schemaVersion !== 4 && schemaVersion !== 5 && schemaVersion !== 6 && schemaVersion !== 7 && schemaVersion !== USERSPACE_ROOTFS_SCHEMA) {
    throw protocolError("unsupported Userspace rootfs schema");
  }
  if (string(source["kind"], "kind") !== "linux-user-rootfs") {
    throw protocolError("managed artifact is not a Userspace rootfs");
  }
  if (string(source["architecture"], "architecture") !== "x86_64") {
    throw protocolError("Userspace rootfs architecture must be x86_64");
  }
  const cpuProfile = string(source["cpuProfile"], "cpuProfile");
  if (cpuProfile !== "x86-64-v2" && cpuProfile !== "x86-64-v3") {
    throw protocolError("Userspace rootfs CPU profile is unsupported");
  }

  const blobs = decodeBlobs(source["blobs"], manifestUrl);
  const entries = decodeRootfsEntries(source["entries"], new Set(blobs.map((blob) => blob.sha256)), schemaVersion >= 4, schemaVersion >= 6);
  const fileCount = integer(source["fileCount"], "fileCount", 0, MAX_FILES);
  const totalBytes = integer(source["totalBytes"], "totalBytes", 0, MAX_BYTES);
  const referenced = new Set(entries.flatMap((entry) => entry.type === "file" ? [entry.blob] : []));
  const actualBytes = blobs.reduce((total, blob) => referenced.has(blob.sha256) ? total + blob.bytes : total, 0);
  if (entries.length !== fileCount || actualBytes !== totalBytes || referenced.size !== blobs.length) {
    throw protocolError("Userspace rootfs file or byte totals do not match its tree");
  }

  const runtimes = decodeRootfsRuntimes(source["runtimes"], entries);
  const provenance = decodeProvenance(source["provenance"], manifestUrl);
  const packs = schemaVersion >= 8 ? decodeUserspaceRootfsPacks(source["packs"], rootfsClosure({blobs,provenance}), manifestUrl) : undefined;
  return {
    schemaVersion,
    ...(packs === undefined ? {} : { packs }),
    ...(source["snapshots"]===undefined?{}:{snapshots:decodeManagedImageSnapshots(source["snapshots"],manifestUrl)}),    ...(schemaVersion >= 5 ? { manifestUrl: new URL(manifestUrl.href) } : {}),
    ...(source["resources"] === undefined ? {} : { resources: decodeResources(source["resources"]) }),
    kind: "linux-user-rootfs",
    id: identifier(source["id"], "id"),
    version: identifier(source["version"], "version"),
    architecture: "x86_64",
    cpuProfile,
    sourceDateEpoch: integer(source["sourceDateEpoch"], "sourceDateEpoch", 0),
    rootTreeSha256: digest(source["rootTreeSha256"], "rootTreeSha256"),
    ...(schemaVersion >= 3
      ? { workspaceBaseSha256: digest(source["workspaceBaseSha256"], "workspaceBaseSha256") }
      : {}),
    fileCount,
    totalBytes,
    blobs,
    entries,
    runtimes,
    provenance,
  };
}

export function rootfsClosure(manifest: Pick<UserspaceRootfsManifest, "blobs" | "provenance">): readonly UserspaceRootfsBlob[] {
  const evidence = manifest.provenance;
  const unique = new Map<string, UserspaceRootfsBlob>();
  for (const blob of [...manifest.blobs, evidence.sbom, evidence.notices, evidence.correspondingSources, evidence.reproducibility]) {
    const previous = unique.get(blob.sha256);
    if (previous !== undefined && previous.bytes !== blob.bytes) throw protocolError("rootfs blob digest has contradictory lengths");
    unique.set(blob.sha256, blob);
  }
  return [...unique.values()];
}

export async function verifyUserspaceRootfsManifest(
  manifest: UserspaceRootfsManifest,
  trusted: TrustedRootfsKey,
): Promise<void> {
  if (trusted.keyId !== manifest.provenance.keyId) {
    throw new VMError("PROTOCOL_ERROR", "Userspace rootfs signing key is not trusted", { reason: "untrusted-key", keyId: manifest.provenance.keyId });
  }
  if (trusted.publicKey.byteLength !== 32) throw protocolError("Userspace rootfs signing key is not trusted");
  const identities = await userspaceTreeIdentity(manifest.entries, manifest.blobs, manifest.schemaVersion);
  if (identities.rootTreeSha256 !== manifest.rootTreeSha256) {
    throw protocolError("Userspace rootfs tree hash is invalid");
  }
  if (manifest.schemaVersion >= 3) {
    if (identities.workspaceBaseSha256 !== manifest.workspaceBaseSha256) {
      throw protocolError("Userspace workspace base hash is invalid");
    }
  }
  await verifyEd25519(trusted.publicKey, manifest.provenance.signature, canonicalUserspaceRootfsBytes(manifest), "Userspace rootfs");
}

/** Whether a rootfs entry path is `/workspace` or below it, which the runtime mounts separately. */
export function isUserspaceWorkspacePath(path: string): boolean {
  return path === "workspace" || path.startsWith("workspace/");
}

/** Shared authoring/verification identity; the worker and builder use this single owner. */
export async function userspaceTreeIdentity(entries: readonly UserspaceRootfsEntry[], blobs: readonly UserspaceRootfsBlob[], schemaVersion = 5): Promise<{ readonly rootTreeSha256: string; readonly workspaceBaseSha256: string }> {
  const workspace = entries.filter(({ path }) => isUserspaceWorkspacePath(path));
  const referenced = new Set(workspace.flatMap(entry => entry.type === "file" ? [entry.blob] : []));
  return {
    rootTreeSha256: await sha256(canonicalBytes({ blobs: blobs.map(schemaVersion === 1 ? blobRecord : treeBlobRecord), entries })),
    workspaceBaseSha256: await sha256(canonicalBytes({ blobs: blobs.filter(({ sha256 }) => referenced.has(sha256)).map(treeBlobRecord), entries: workspace })),
  };
}

export function encodeUserspaceRootfsMetadata(
  manifest: UserspaceRootfsManifest,
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const blobSizes = new Map(manifest.blobs.map((blob) => [blob.sha256, blob.bytes]));
  const entries = manifest.entries.map((entry): RootfsMetadataEntry => {
    if ((entry.ownership !== undefined) !== (manifest.schemaVersion >= 4)) throw protocolError("Rootfs ownership requires schema 4 or newer");
    if ((entry.times !== undefined) !== (manifest.schemaVersion >= 6)) throw protocolError("Rootfs timestamps require schema 6 or newer");
    const pathText = `/${entry.path}`;
    const metadata = { path: encoder.encode(pathText), pathText, mode: entry.mode,
      ...(entry.ownership === undefined ? {} : { ownership: entry.ownership }),
      ...(entry.times === undefined ? {} : { times: entry.times }) };
    if (entry.type === "directory") return { ...metadata, tag: 0, payload: new Uint8Array() };
    if (entry.type === "symlink") return { ...metadata, tag: 2, payload: encoder.encode(entry.target) };
    if (entry.type === "hardlink") return { ...metadata, tag: 4, payload: encoder.encode(`/${entry.target}`) };
    const size = blobSizes.get(entry.blob);
    if (size === undefined) throw protocolError("rootfs file references an unknown blob");
    const payload = new Uint8Array(40);
    new DataView(payload.buffer).setBigUint64(0, BigInt(size), true);
    payload.set(hexDigest(entry.blob), 8);
    return { ...metadata, tag: 3, payload };
  });
  return encodeFilesystemRecord(entries, "rootfs");
}

export function decodeUserspaceRootfsMetadataFile(
  record: Uint8Array,
  requestedPath: string,
): { readonly bytes: number; readonly sha256: string } {
  const entries = new Map(decodeFilesystemRecord(record, "rootfs").map(entry => [entry.pathText, entry]));
  return rootfsMetadataFile(entries, requestedPath);
}

type RootfsFileIdentity = { readonly bytes: number; readonly sha256: string };

function rootfsMetadataFile(
  entries: ReadonlyMap<string, RootfsMetadataEntry>,
  requestedPath: string,
): RootfsFileIdentity {
  let entry = entries.get(requestedPath);
  for (let depth = 0; depth < MAX_DEPTH && entry?.tag === 4; depth += 1) {
    entry = entries.get(new TextDecoder("utf-8", { fatal: true }).decode(entry.payload));
  }
  if (entry?.tag !== 3) throw protocolError("managed executable is absent from Userspace rootfs metadata");
  const bytes = new DataView(entry.payload.buffer, entry.payload.byteOffset, entry.payload.byteLength)
    .getBigUint64(0, true);
  if (bytes > BigInt(MAX_BYTES)) throw protocolError("managed executable is too large");
  return { bytes: Number(bytes), sha256: hex(entry.payload.subarray(8)) };
}

export async function materializeUserspaceRootfsMetadata(
  record: Uint8Array,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  return materializeRootfsEntries(decodeFilesystemRecord(record, "rootfs"), files);
}

async function materializeRootfsEntries(
  metadata: readonly RootfsMetadataEntry[],
  files: ReadonlyMap<string, Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  const entries = await Promise.all(metadata.map(async (entry): Promise<RootfsMetadataEntry> => {
    const bytes = files.get(entry.pathText);
    if (bytes === undefined) return entry;
    if (entry.tag !== 3) throw protocolError("supporting file does not reference managed file metadata");
    const expectedBytes = new DataView(entry.payload.buffer, entry.payload.byteOffset, entry.payload.byteLength)
      .getBigUint64(0, true);
    if (expectedBytes !== BigInt(bytes.byteLength)) {
      throw protocolError("supporting file length does not match rootfs metadata");
    }
    if (await sha256(bytes.slice()) !== hex(entry.payload.subarray(8))) {
      throw protocolError("supporting file digest does not match rootfs metadata");
    }
    return { ...entry, tag: 1, payload: bytes.slice() };
  }));
  for (const path of files.keys()) {
    if (!entries.some((entry) => entry.pathText === path && entry.tag === 1)) {
      throw protocolError("supporting file is absent from Userspace rootfs metadata");
    }
  }
  return encodeFilesystemRecord(entries, "rootfs");
}

/** The workspace mount; the runtime creates it and a recorded entry sets its mode, owner and times. */
const WORKSPACE_ROOT = "/workspace";

export function mergeUserspaceWorkspaceSnapshot(
  rootfs: Uint8Array,
  workspace: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const rootEntries = decodeFilesystemRecord(rootfs, "rootfs");
  const workspaceEntries = decodeFilesystemRecord(workspace, "snapshot");
  const available = new Set<string>();
  for (const entry of workspaceEntries) {
    if (!(entry.pathText === "/workspace" && entry.tag === 0) && (!entry.pathText.startsWith("/workspace/") || entry.pathText === "/workspace/")) {
      throw protocolError("workspace overlay contains a path outside /workspace");
    }
    if (entry.tag === 3 && entry.payload.byteLength !== 40) {
      throw protocolError("workspace overlay host file identity is incomplete");
    }
    if (entry.tag === 4) {
      const target = new TextDecoder("utf-8", { fatal: true }).decode(entry.payload);
      if (!available.has(target)) {
        throw protocolError("workspace overlay hardlink target must precede the link");
      }
    }
    available.add(entry.pathText);
  }
  // The runtime installs a recorded /workspace over the directory it mounts there, taking its
  // mode, owner and times. Without that entry /workspace stays world-writable and unowned, so the
  // snapshot's root wins, and the image's stands in for a snapshot that has none.
  const root = mergeRootClaims(rootEntries.find(({ pathText }) => pathText === WORKSPACE_ROOT),
    workspaceEntries.find(({ pathText }) => pathText === WORKSPACE_ROOT));
  return encodeFilesystemRecord([
    ...rootEntries.filter(({ pathText }) => pathText !== WORKSPACE_ROOT && !pathText.startsWith("/workspace/")),
    ...(root === undefined ? [] : [root]),
    ...workspaceEntries.filter(({ pathText }) => pathText !== WORKSPACE_ROOT),
  ], "rootfs");
}

function mergeRootClaims(base: RootfsMetadataEntry | undefined, incoming: RootfsMetadataEntry | undefined): RootfsMetadataEntry | undefined {
  if (incoming === undefined) return base;
  if (base === undefined) return incoming;
  const ownership = incoming.ownership ?? base.ownership;
  const metadata = incoming.metadata ?? (base.metadata === undefined ? undefined
    : incoming.times === undefined ? base.metadata : withWorkspaceMetadataTimes(base.metadata, incoming.times));
  const times = metadata === undefined ? incoming.times ?? base.times : undefined;
  return { tag: incoming.tag, mode: incoming.mode, path: incoming.path, pathText: incoming.pathText, payload: incoming.payload,
    ...(ownership === undefined ? {} : { ownership }), ...(metadata === undefined ? {} : { metadata }), ...(times === undefined ? {} : { times }) };
}

export function mergeUserspaceWorkspaceDelta(
  rootfs: Uint8Array,
  delta: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const entries = new Map(decodeFilesystemRecord(rootfs, "rootfs").map((entry) => [entry.pathText, entry]));
  for (const entry of decodeFilesystemRecord(delta, "delta")) {
    if (entry.tag === 5) {
      for (const path of entries.keys()) {
        if (path === entry.pathText || path.startsWith(`${entry.pathText}/`)) entries.delete(path);
      }
    } else {
      entries.set(entry.pathText, entry.pathText === WORKSPACE_ROOT ? mergeRootClaims(entries.get(entry.pathText), entry) ?? entry : entry);
    }
  }
  // A delta's /workspace entry replaced the image's above; either way the root keeps its record.
  const ordered = [...entries.values()].sort((left, right) => compareWorkspacePaths(left.path, right.path));
  const available = new Set<string>();
  for (const entry of ordered) {
    if (entry.tag === 4) {
      const target = new TextDecoder("utf-8", { fatal: true }).decode(entry.payload);
      if (!available.has(target)) throw protocolError("workspace delta hardlink target must precede the link");
    }
    available.add(entry.pathText);
  }
  return encodeFilesystemRecord(ordered, "rootfs");
}

function hexDigest(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalUserspaceRootfsBytes(
  manifest: UserspaceRootfsManifest,
): Uint8Array<ArrayBuffer> {
  if (manifest.schemaVersion >= 5) {
    const { manifestUrl, ...signed } = manifest;
    return canonicalImageBytes({ ...signed, provenance: { ...manifest.provenance, signature: "" } }, manifestUrl);
  }
  return canonicalBytes(
    { ...manifest, provenance: { ...manifest.provenance, signature: "" } },
    manifest.schemaVersion === 1 ? blobRecord : portableBlobRecord,
  );
}

function decodeResources(value: unknown): { readonly memoryMiB: number; readonly maxProcesses?: number } {
  const source = record(value, "rootfs resources"); exactKeys(source, ["memoryMiB"], ["maxProcesses"]);
  return { memoryMiB: integer(source["memoryMiB"], "memoryMiB", 64, 3072),
    ...(source["maxProcesses"] === undefined ? {} : { maxProcesses: integer(source["maxProcesses"], "maxProcesses", 1, 64) }) };
}

function decodeBlobs(value: unknown, manifestUrl: URL): UserspaceRootfsBlob[] {
  if (!Array.isArray(value) || value.length > MAX_FILES) throw protocolError("rootfs blobs must be a bounded array");
  let previous = "";
  return value.map((item, index) => {
    const blob = record(item, `blobs[${index}]`);
    exactKeys(blob, ["sha256", "bytes", "url"]);
    const sha256 = digest(blob["sha256"], `blobs[${index}].sha256`);
    if (sha256 <= previous) throw protocolError("rootfs blobs must be unique and sorted by digest");
    previous = sha256;
    return {
      sha256,
      bytes: integer(blob["bytes"], `blobs[${index}].bytes`, 0, MAX_BYTES),
      url: rememberArtifactURL(managedImageUrl(string(blob["url"], `blobs[${index}].url`), manifestUrl), string(blob["url"], `blobs[${index}].url`)),
    };
  });
}

function decodeProvenance(value: unknown, manifestUrl: URL): UserspaceRootfsManifest["provenance"] {
  const provenance = record(value, "provenance");
  exactKeys(provenance, [
    "keyId", "signature", "sbom", "notices", "correspondingSources", "reproducibility",
  ]);
  const signature = string(provenance["signature"], "provenance.signature");
  decodeEd25519Signature(signature, "Userspace rootfs");
  return {
    keyId: identifier(provenance["keyId"], "provenance.keyId"),
    signature,
    sbom: decodeEvidence(provenance["sbom"], manifestUrl, "provenance.sbom"),
    notices: decodeEvidence(provenance["notices"], manifestUrl, "provenance.notices"),
    correspondingSources: decodeEvidence(provenance["correspondingSources"], manifestUrl, "provenance.correspondingSources"),
    reproducibility: decodeEvidence(provenance["reproducibility"], manifestUrl, "provenance.reproducibility"),
  };
}

function decodeEvidence(value: unknown, manifestUrl: URL, label: string): UserspaceRootfsEvidence {
  const evidence = record(value, label);
  exactKeys(evidence, ["url", "bytes", "sha256"]);
  return {
    url: rememberArtifactURL(managedImageUrl(string(evidence["url"], `${label}.url`), manifestUrl), string(evidence["url"], `${label}.url`)),
    bytes: integer(evidence["bytes"], `${label}.bytes`, 1, MAX_BYTES),
    sha256: digest(evidence["sha256"], `${label}.sha256`),
  };
}

function identifier(value: unknown, label: string): string {
  const result = string(value, label);
  if (!ID.test(result)) throw protocolError(`${label} is not a valid identifier`);
  return result;
}

function digest(value: unknown, label: string): string {
  const result = string(value, label);
  if (!SHA256.test(result)) throw protocolError(`${label} must be lowercase SHA-256`);
  return result;
}

function blobRecord(blob: UserspaceRootfsBlob): { readonly bytes: number; readonly sha256: string; readonly url: string } {
  return { bytes: blob.bytes, sha256: blob.sha256, url: blob.url.href };
}

function treeBlobRecord(blob: UserspaceRootfsBlob): { readonly bytes: number; readonly sha256: string } {
  return { bytes: blob.bytes, sha256: blob.sha256 };
}

function portableBlobRecord(blob: UserspaceRootfsBlob): { readonly bytes: number; readonly sha256: string; readonly url: string } {
  return {
    bytes: blob.bytes,
    sha256: blob.sha256,
    url: `${blob.url.pathname}${blob.url.search}`,
  };
}

function canonicalBytes(value: unknown, mapBlob?: (blob: UserspaceRootfsBlob) => unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(canonical(value, mapBlob)));
}

function canonical(value: unknown, mapBlob?: (blob: UserspaceRootfsBlob) => unknown): unknown {
  if (value instanceof URL) return value.href;
  if (Array.isArray(value)) return value.map((item) => canonical(item, mapBlob));
  if (typeof value !== "object" || value === null) return value;
  if (mapBlob !== undefined && isRootfsBlob(value)) return mapBlob(value);
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item, mapBlob)]));
}

function isRootfsBlob(value: object): value is UserspaceRootfsBlob {
  return "url" in value && value.url instanceof URL
    && "bytes" in value && typeof value.bytes === "number"
    && "sha256" in value && typeof value.sha256 === "string";
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
