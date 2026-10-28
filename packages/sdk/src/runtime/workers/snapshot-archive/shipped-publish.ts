import { VMError } from "../../errors.js";
import { SNAPSHOT_CHUNK_BYTES, USERSPACE_SNAPSHOT_SCHEMA, type SnapshotManifest } from "../snapshot-manifest.js";
import { gzip } from "./gzip.js";
import { readBackup } from "./reader.js";
import { backupObjectsOf } from "./manifest.js";
import { encodeShippedManifest, type ShippedExpectation, shippedSigningBytes, verifyShippedManifest } from "./shipped.js";
import { chunkStream, findImageRanges, type ShippedTransport, withoutRanges } from "./shipped-transport.js";
import { chunkName } from "./writer.js";

/** A larger payload stream is published whole: leaving out image files holds it in memory. */
const MAX_TRANSPORTED_PAYLOAD_BYTES = 2 * 1024 ** 3;

/** The build key that signs shipped restore points. */
export interface ShippedSigner {
  readonly keyId: string;
  /** The raw 32-byte Ed25519 public key whose private half `sign` uses. */
  readonly publicKey: Uint8Array<ArrayBuffer>;
  /** The Ed25519 signature of `bytes`, base64url without padding. */
  sign(bytes: Uint8Array<ArrayBuffer>): Promise<string>;
}

export interface ShippedPublishOptions {
  /** The catalog name the profile lists it under. */
  readonly name: string;
  /** What the Restore points panel calls it. */
  readonly label: string;
  /** The profile image it runs on. */
  readonly image: ShippedExpectation["image"];
  readonly signer: ShippedSigner;
  readonly nowUnixMs: number;
  /** The most a browser may download for it: its manifest and every chunk. */
  readonly maxDownloadBytes: number;
  /**
   * The image's files, SHA-256 to size. A Userspace start then leaves out payload blobs that are
   * byte-identical to one of them; the installer reads those from the image instead.
   */
  readonly imageFiles?: ReadonlyMap<string, number>;
}

/** A shipped restore point ready to publish under `snapshots/<name>/` beside its profile. */
export interface ShippedPublication {
  /** `manifest.json`: canonical, signed. */
  readonly manifest: Uint8Array<ArrayBuffer>;
  /** Each `chunks/<sha256>.gz` file, in the order the manifest names its objects. */
  readonly chunks: readonly { readonly name: string; readonly bytes: Uint8Array<ArrayBuffer> }[];
  /** The chunks' total size: what the profile lists as its download, and what install progress counts. */
  readonly chunkBytes: number;
}

/**
 * Publishes the restore point a backup holds as a shipped one (ADR 0014, Release 2): every chunk
 * is read and checked as an import would, then compressed again on its own, in the order the
 * backup holds them, which is the order installers fetch them; the manifest becomes kind
 * "shipped" under `label`, signed by `signer`, and is verified as an installer would verify it,
 * with the signer's public key and the profile's image, before anything is returned. The same
 * backup, key and options always give the same bytes.
 */
export async function publishShipped(backup: ReadableStream<Uint8Array>, options: ShippedPublishOptions): Promise<ShippedPublication> {
  const chunks: { readonly name: string; readonly bytes: Uint8Array<ArrayBuffer> }[] = [];
  const result = await publishShippedTo(backup, options, (name, bytes) => {
    chunks.push({name, bytes}); return Promise.resolve();
  });
  return {...result, chunks};
}

/** Each verified compressed object is released only after the sink accepts it. */
export async function publishShippedTo(
  backup: ReadableStream<Uint8Array>,
  options: ShippedPublishOptions,
  writeChunk: (name: string, bytes: Uint8Array<ArrayBuffer>) => Promise<void>,
): Promise<{readonly manifest: Uint8Array<ArrayBuffer>; readonly chunkBytes: number}> {
  let snapshot: SnapshotManifest | undefined;
  let chunkBytes = 0;
  let held: Set<string> | undefined;
  const payloads = new Map<string, Uint8Array<ArrayBuffer>>(), written = new Set<string>();
  const write = async (sha256: string, content: Uint8Array<ArrayBuffer>): Promise<void> => {
    if (written.has(sha256)) return;
    written.add(sha256);
    const stored = await gzip(content);
    chunkBytes = withinLimit(chunkBytes + stored.byteLength, options.maxDownloadBytes);
    await writeChunk(chunkName(sha256), stored);
  };
  for await (const entry of readBackup(backup, { nowUnixMs: options.nowUnixMs })) {
    if (entry.kind === "manifest") {
      snapshot = { ...entry.manifest.snapshot, kind: "shipped", label: options.label };
      held = payloadOnlyObjects(snapshot, options.imageFiles);
      continue;
    }
    if (held?.has(entry.ref.sha256) === true) { payloads.set(entry.ref.sha256, entry.content); continue; }
    await write(entry.ref.sha256, entry.content);
  }
  // readBackup yields the manifest first or refuses the file.
  if (snapshot === undefined) throw new VMError("INVALID_ARGUMENT", "the backup holds no restore point", { reason: "backup-damaged" });

  let transport: ShippedTransport | undefined;
  if (snapshot.schema === USERSPACE_SNAPSHOT_SCHEMA && held !== undefined && options.imageFiles !== undefined) {
    const stream = new Uint8Array(snapshot.payloads.bytes);
    for (const chunk of snapshot.payloads.chunks) {
      const content = payloads.get(chunk.sha256);
      if (content === undefined) throw new VMError("INVALID_ARGUMENT", "the backup is missing a payload chunk", { reason: "backup-damaged" });
      stream.set(content, chunk.index * SNAPSHOT_CHUNK_BYTES);
    }
    const images = await findImageRanges(stream, options.imageFiles);
    if (images.length > 0) {
      const literal = withoutRanges(stream, images);
      transport = { kind: "image-files", literal: await chunkStream(literal), images };
      for (const chunk of transport.literal.chunks) await write(chunk.sha256, literal.slice(chunk.index * SNAPSHOT_CHUNK_BYTES, chunk.index * SNAPSHOT_CHUNK_BYTES + chunk.bytes));
    } else {
      for (const chunk of snapshot.payloads.chunks) { const content = payloads.get(chunk.sha256); if (content !== undefined) await write(chunk.sha256, content); }
    }
  }

  const { keyId } = options.signer;
  const signature = await options.signer.sign(shippedSigningBytes(options.name, snapshot, keyId, transport));
  const manifest = encodeShippedManifest(options.name, snapshot, { keyId, signature }, transport);
  withinLimit(chunkBytes + manifest.byteLength, options.maxDownloadBytes);
  await verifyShippedManifest(manifest, {
    name: options.name,
    trusted: { keyId, publicKey: options.signer.publicKey },
    image: options.image,
    nowUnixMs: options.nowUnixMs,
  });
  return { manifest, chunkBytes };
}

/** The payload chunks no other part of a Userspace start names, when image files may be left out. */
function payloadOnlyObjects(snapshot: SnapshotManifest, imageFiles: ReadonlyMap<string, number> | undefined): Set<string> | undefined {
  // An empty payload stream (no header at all) has nothing to leave out.
  if (snapshot.schema !== USERSPACE_SNAPSHOT_SCHEMA || imageFiles === undefined || imageFiles.size === 0 || snapshot.payloads.bytes === 0 || snapshot.payloads.bytes > MAX_TRANSPORTED_PAYLOAD_BYTES) return undefined;
  const others = new Set(backupObjectsOf({ ...snapshot, payloads: { bytes: 0, chunks: [] } }).map(object => object.sha256));
  return new Set(snapshot.payloads.chunks.map(chunk => chunk.sha256).filter(sha256 => !others.has(sha256)));
}

function withinLimit(bytes: number, maxBytes: number): number {
  if (bytes > maxBytes) {
    throw new VMError("INVALID_ARGUMENT", `the shipped restore point would download more than ${String(maxBytes)} bytes`, {
      reason: "shipped-too-large",
    });
  }
  return bytes;
}
