import { sha256Hex } from "../snapshot-content.js";
import { decodeSnapshotManifest, type ObjectRef, type SystemSnapshotManifest } from "../snapshot-manifest.js";
import type { ShippedSigner } from "./shipped-publish.js";
import { writeBackup } from "./writer.js";

export const MIB = 1024 * 1024;
/** The clock the backup tests read: the day after the fixture was saved. */
export const NOW = Date.parse("2026-10-03T00:00:00.000Z");

/** A distinct content hash per number. */
export function hash(value: number): string {
  return value.toString(16).padStart(64, "0");
}

/**
 * The JSON fields of a managed restore point whose objects are numbered by `hash`: machine record
 * 1, RAM 2 and 3, disk 4, kernel 5 (from the image), agent state 6, page data 7, workspace index 8.
 */
export function backupFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 2,
    id: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-10-02T10:00:00.000Z",
    kind: "named",
    label: "Before upgrading Next",
    capturedAtUnixMs: Date.parse("2026-10-02T10:00:02.000Z"),
    parent: null,
    machine: { record: { sha256: hash(1), bytes: 4096 }, memoryBytes: 16 * MIB, vcpus: 1 },
    ram: [{ index: 0, sha256: hash(2), bytes: MIB }, { index: 3, sha256: hash(3), bytes: MIB }],
    disk: {
      origin: "managed",
      bytes: 4 * MIB,
      baseIdentity: hash(100),
      image: { id: "alpine", version: "2026.10.02" },
      chunks: [{ index: 0, zero: true }, { index: 2, sha256: hash(4), bytes: MIB }],
    },
    assets: { kernel: { sha256: hash(5), bytes: 10 } },
    host: { agent: { sha256: hash(6), bytes: 100 }, appData: { sha256: hash(7), bytes: 5 } },
    workspace: { baseSha256: hash(101), generation: 3, index: { sha256: hash(8), bytes: 50 } },
    ...overrides,
  };
}

/** A managed restore point whose objects have real content, with that content by hash. */
export interface BackupContent {
  readonly snapshot: SystemSnapshotManifest;
  readonly contents: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
  /** The content of the managed image's kernel, which a backup does not carry. */
  readonly kernel: Uint8Array<ArrayBuffer>;
}

/** The restore point of `backupFixture` with real, highly compressible content for every object. */
export async function backupContent(): Promise<BackupContent> {
  const contents = new Map<string, Uint8Array<ArrayBuffer>>();
  const object = async (bytes: number, fill: number): Promise<{ readonly sha256: string; readonly bytes: number }> => {
    const content = new Uint8Array(bytes).fill(fill);
    const sha256 = await sha256Hex(content);
    contents.set(sha256, content);
    return { sha256, bytes };
  };
  const kernel = new Uint8Array(10).fill(5);
  const fields = backupFixture({
    machine: { record: await object(4096, 1), memoryBytes: 16 * MIB, vcpus: 1 },
    ram: [{ index: 0, ...(await object(MIB, 2)) }, { index: 3, ...(await object(MIB, 3)) }],
    disk: {
      origin: "managed",
      bytes: 4 * MIB,
      baseIdentity: hash(100),
      image: { id: "alpine", version: "2026.10.02" },
      chunks: [{ index: 0, zero: true }, { index: 2, ...(await object(MIB, 4)) }],
    },
    assets: { kernel: { sha256: await sha256Hex(kernel), bytes: kernel.byteLength } },
    host: { agent: await object(100, 6), appData: await object(5, 7) },
    workspace: { baseSha256: hash(101), generation: 3, index: await object(50, 8) },
  });
  const snapshot = decodeSnapshotManifest(fields);
  if (snapshot.schema !== 2) throw new Error("expected system fixture");
  return { snapshot, contents, kernel };
}

export function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

/** The bytes `writeBackup` writes for `content`'s restore point. */
export async function exported(content: BackupContent): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  await writeBackup(content.snapshot, (ref) => Promise.resolve(contentOf(content, ref)), (bytes) => {
    parts.push(bytes.slice());
    return Promise.resolve();
  });
  return concat(parts);
}

export function contentOf(content: BackupContent, ref: ObjectRef): Uint8Array<ArrayBuffer> {
  const bytes = content.contents.get(ref.sha256);
  if (bytes === undefined) throw new Error(`no content for ${ref.sha256}`);
  return bytes;
}

/** An Ed25519 key that signs shipped restore points as the build does, made with WebCrypto. */
export async function testSigner(keyId: string): Promise<ShippedSigner> {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  return {
    keyId,
    publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
    sign: async (bytes) => base64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, bytes))),
  };
}

export function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
