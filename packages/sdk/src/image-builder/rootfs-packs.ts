import { open } from "node:fs/promises";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { decodeUserspaceRootfsManifest, rootfsClosure, type UserspaceRootfsEntry, type UserspaceRootfsManifest } from "../runtime/userspace-rootfs.js";
import { inDigestOrder, packRootfsContents } from "../runtime/userspace-rootfs-packing.js";
import type { RootfsBlobIdentity, RootfsPackIndex } from "../runtime/userspace-rootfs-packs.js";
import { VMError } from "../runtime/errors.js";
import { artifactRelativePath, localBundlePath } from "./bundle-files.js";
import { writeArtifact } from "./files.js";
import { abortIfRequested } from "./tools.js";
import { readImageBundle } from "./bundle.js";
import { decodeRootfsTransport } from "../runtime/userspace-rootfs-transport.js";
import type { TrustedImageKey } from "../image.js";
import type { SHA256 } from "../values.js";

export interface BuiltRootfsPacks {
  readonly index: RootfsPackIndex;
  readonly artifacts: readonly { readonly sha256:string; readonly encoding:"gzip"; readonly url:string; readonly encodedBytes:number; readonly encodedSha256:string }[];
}

/**
 * Which files share a pack. A program's first run downloads every pack that holds a file it reads, so `locality` packs
 * `first` (the files a cold start reads, in order) at the front, then every other file by path and the evidence by
 * digest. `digest` is the layout browsers compact blob-only images into; transport sidecars keep it.
 */
export type RootfsPackLayout = { readonly kind: "digest" } | { readonly kind: "locality"; readonly first: readonly string[] };

/** Symlinks a listed path may cross, as Linux allows (ELOOP). */
const MAX_SYMLINKS = 40;

/** The regular file `path` names in the image, through symlinks and hardlinks; every other outcome names the path. */
function listedFile(entries: ReadonlyMap<string, UserspaceRootfsEntry>, path: string): string {
  const refuse = (why: string) => new VMError("INVALID_ARGUMENT", `packFirst path ${path} ${why}`);
  let pending = path.split("/"), hops = 0;
  const resolved: string[] = [];
  for (let part = pending.shift(); part !== undefined; part = pending.shift()) {
    if (part === "" || part === ".") continue;
    if (part === "..") { resolved.pop(); continue; }
    resolved.push(part);
    const entry = entries.get(resolved.join("/"));
    if (entry?.type !== "symlink") continue;
    if (++hops > MAX_SYMLINKS) throw refuse("crosses too many symlinks");
    resolved.pop();
    if (entry.target.startsWith("/")) resolved.length = 0;
    pending = [...entry.target.split("/"), ...pending];
  }
  const entry = entries.get(resolved.join("/"));
  const file = entry?.type === "hardlink" ? entries.get(entry.target) : entry;
  if (file === undefined) throw refuse("is not in the image");
  if (file.type !== "file") throw refuse(`is a ${file.type}, not a file`);
  return file.blob;
}

/** Every blob the packs must hold, in the order `layout` packs them. */
export function rootfsPackOrder(manifest: UserspaceRootfsManifest, layout: RootfsPackLayout): readonly RootfsBlobIdentity[] {
  const closure = rootfsClosure(manifest);
  if (layout.kind === "digest") return inDigestOrder(closure);
  const entries = new Map(manifest.entries.map(entry => [entry.path, entry]));
  // A decoded manifest lists its entries in guest path order, so files of one directory sit together.
  const files = manifest.entries.flatMap(entry => entry.type === "file" ? [entry] : []);
  const blobs = new Map(closure.map(blob => [blob.sha256, blob]));
  const order = new Map<string, RootfsBlobIdentity>();
  for (const digest of [...layout.first.map(path => listedFile(entries, path)), ...files.map(file => file.blob)]) {
    const blob = blobs.get(digest);
    if (blob === undefined) throw new VMError("PROTOCOL_ERROR", "Image file has no payload in its manifest");
    if (!order.has(digest)) order.set(digest, blob);
  }
  for (const blob of inDigestOrder(closure)) if (!order.has(blob.sha256)) order.set(blob.sha256, blob);
  return [...order.values()];
}

export interface ImagePackReport {
  readonly manifestSHA256: SHA256;
  readonly transportPath: string;
  readonly packCount: number;
  readonly encodedBytes: number;
  readonly decodedBytes: number;
}

/** Add bulk delivery to an authenticated bundle without changing its signed image or lock. */
export async function packImage(bundle: string, options: { readonly trust: TrustedImageKey; readonly signal?: AbortSignal }): Promise<ImagePackReport> {
  const source = await readImageBundle(bundle, options.trust, options.signal);
  if (!("entries" in source.manifest)) throw new VMError("INVALID_ARGUMENT", "image pack requires a Userspace image");
  const packs = await buildRootfsPacks(source.bundle, source.manifestValue, source.base, options.signal, { kind: "digest" });
  const transport = { version: 1, manifestSHA256: source.image.manifestSHA256, packs };
  decodeRootfsTransport(transport, source.manifest, source.image.manifestSHA256, source.base);
  const root = await realpath(source.bundle);
  for (const directory of [join(root, "transport"), join(root, "transport", source.image.manifestSHA256)]) {
    await mkdir(directory, { recursive: false }).catch((error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    });
    if (await realpath(directory) !== directory) throw new VMError("PROTOCOL_ERROR", "transport directory must not be a symlink");
  }
  const transportPath = join(root, "transport", source.image.manifestSHA256, "packs-v1.json");
  const temporary = `${transportPath}.${randomUUID()}.tmp`;
  try {
    abortIfRequested(options.signal);
    await writeFile(temporary, `${JSON.stringify(transport)}\n`, { flag: "wx" });
    abortIfRequested(options.signal);
    await rename(temporary, transportPath);
  } finally { await rm(temporary, { force: true }); }
  return { manifestSHA256: source.image.manifestSHA256, transportPath, packCount: packs.index.chunks.length,
    encodedBytes: packs.artifacts.reduce((sum, pack) => sum + pack.encodedBytes, 0), decodedBytes: packs.index.chunks.reduce((sum, pack) => sum + pack.bytes, 0) };
}

/** Author compressed delivery without changing any immutable guest file identity. */
export async function buildRootfsPacks(bundle: string, manifestValue: unknown, manifestUrl: URL, signal?: AbortSignal, layout: RootfsPackLayout = { kind: "digest" }): Promise<BuiltRootfsPacks> {
  const directory = join(await realpath(bundle), "packs");
  await mkdir(directory).catch((error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  });
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new VMError("PROTOCOL_ERROR", "Pack output directory must remain inside its bundle");
  const manifest = decodeUserspaceRootfsManifest(manifestValue, manifestUrl), closure = rootfsClosure(manifest);
  const references = new Map(closure.map(blob => [blob.sha256,blob]));
  const artifacts: BuiltRootfsPacks["artifacts"][number][] = [];
  const index = await packRootfsContents(rootfsPackOrder(manifest, layout), async function*(blob) {
    abortIfRequested(signal);
    const reference = references.get(blob.sha256);if(reference===undefined)throw new VMError("PROTOCOL_ERROR","Unknown rootfs packing source");
    const file = await open(await localBundlePath(bundle,artifactRelativePath(manifestUrl,reference.url)),"r");
    try {
      if((await file.stat()).size!==blob.bytes)throw new VMError("PROTOCOL_ERROR","Rootfs packing source length changed");
      const frame=new Uint8Array(65536);let offset=0;
      while(offset<blob.bytes) {
        abortIfRequested(signal);const read=await file.read(frame,0,Math.min(frame.length,blob.bytes-offset),offset);
        if(read.bytesRead===0)throw new VMError("PROTOCOL_ERROR","Rootfs packing source was truncated");
        offset+=read.bytesRead;yield frame.subarray(0,read.bytesRead);
      }
    } finally {await file.close();}
  },async (chunk,bytes)=>{
    abortIfRequested(signal);const artifact=await writeArtifact(bundle,"packs",gzipSync(bytes,{level:9}));
    artifacts.push({sha256:chunk.sha256,encoding:"gzip",url:artifact.url,encodedBytes:artifact.bytes,encodedSha256:artifact.sha256});
  },signal);
  return {index,artifacts};
}
