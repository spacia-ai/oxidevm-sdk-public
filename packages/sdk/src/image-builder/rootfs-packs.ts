import { open } from "node:fs/promises";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { decodeUserspaceRootfsManifest, rootfsClosure } from "../runtime/userspace-rootfs.js";
import { packRootfsContents } from "../runtime/userspace-rootfs-packing.js";
import type { RootfsPackIndex } from "../runtime/userspace-rootfs-packs.js";
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
  const packs = await buildRootfsPacks(source.bundle, source.manifestValue, source.base, options.signal);
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
export async function buildRootfsPacks(bundle: string, manifestValue: unknown, manifestUrl: URL, signal?: AbortSignal): Promise<BuiltRootfsPacks> {
  const directory = join(await realpath(bundle), "packs");
  await mkdir(directory).catch((error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  });
  if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new VMError("PROTOCOL_ERROR", "Pack output directory must remain inside its bundle");
  const manifest = decodeUserspaceRootfsManifest(manifestValue, manifestUrl), closure = rootfsClosure(manifest);
  const references = new Map(closure.map(blob => [blob.sha256,blob]));
  const artifacts: BuiltRootfsPacks["artifacts"][number][] = [];
  const index = await packRootfsContents(closure, async function*(blob) {
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
