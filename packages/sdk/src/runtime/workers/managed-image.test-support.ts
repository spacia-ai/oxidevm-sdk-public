import {
  decodeManagedImageManifest,
  managedImageIdentityBytes,
  type ManagedImageManifest,
} from "../managed-image.js";
import { managedBaseMarker } from "../managed-disk-state.js";
import type { ManagedBases } from "./managed-base.js";
import { ManagedDisk } from "./managed-disk.js";
import { managedImageStem, type ManagedImageRef } from "./managed-disk-head.js";
import { pinManagedImage } from "./managed-image-pins.js";
import type { MemoryDirectory } from "./opfs-double.test-support.js";
import { sha256Hex } from "./snapshot-content.js";

const MIB = 1024 * 1024;

export interface TestImage {
  readonly ref: ManagedImageRef;
  readonly manifest: ManagedImageManifest;
  readonly stem: string;
}

/**
 * Caches and pins a managed image whose base holds one fill byte per MiB chunk; a zero fill is a
 * chunk the image does not store.
 */
export async function cachedTestImage(
  images: MemoryDirectory,
  fills: readonly number[],
  version = "2026.10.02",
): Promise<TestImage> {
  const kernel = new Uint8Array([0x4b, 0x45, 0x52]);
  const stored = fills.flatMap((fill, index) => (fill === 0 ? [] : [{ index, data: new Uint8Array(MIB).fill(fill) }]));
  const chunks = await Promise.all(stored.map(async ({ index, data }) => ({
    index,
    url: `./disk/${String(index)}.bin`,
    bytes: MIB,
    sha256: await sha256Hex(data),
    encoding: "gzip",
    encodedBytes: 1,
    encodedSha256: "0".repeat(64),
  })));
  const value = {
    schemaVersion: 2,
    id: "test-image",
    version,
    architecture: "x86_64",
    sourceDateEpoch: 1_790_000_000,
    memoryMiB: 1024,
    vcpus: 1,
    cpuProfile: "x86-64-v3",
    commandLine: "console=hvc0",
    kernel: { url: "./bzImage", bytes: kernel.byteLength, sha256: await sha256Hex(kernel) },
    disk: { bytes: fills.length * MIB, blockBytes: 4096, chunkBytes: MIB, chunks },
    runtimes: { alpine: "3.24.1", node: "24.18.1", bun: "1.3.14", next: "16.2.12" },
  };
  const text = JSON.stringify(value);
  const url = new URL("https://example.test/profiles/test-image/manifest.json");
  const manifest = decodeManagedImageManifest(value, url);
  const ref = { id: value.id, version, identity: await sha256Hex(managedImageIdentityBytes(value, text, manifest)) };
  const stem = managedImageStem(ref);
  const pack = new Uint8Array(stored.length * MIB);
  stored.forEach(({ data }, position) => pack.set(data, position * MIB));
  images.file(`${stem}.pack`, true).setBytes(pack);
  images.file(`${stem}.complete`, true).setBytes(new TextEncoder().encode(managedBaseMarker(pack.byteLength, ref.identity)));
  await pinManagedImage(images, "test", { ref, url, manifestText: text, kernel });
  return { ref, manifest, stem };
}

/** Opens generation `generation` of a cached test image on a fresh base lease. */
/** Opens a test disk; it keeps no space reserve unless `reserveBytes` asks for one. */
export async function openTestDisk(
  disks: MemoryDirectory,
  images: MemoryDirectory,
  bases: ManagedBases,
  image: TestImage,
  generation: string,
  { reserveBytes = 0 }: { readonly reserveBytes?: number } = {},
): Promise<ManagedDisk> {
  return ManagedDisk.open(
    disks,
    generation,
    { ref: image.ref, manifest: image.manifest },
    await bases.acquire(images, image.stem),
    { reserveBytes },
  );
}

/** A compact view of a chunk, so a mismatch reports its fill instead of a megabyte diff. */
export function chunkFill(bytes: Uint8Array): { readonly length: number; readonly fill: number | "mixed" } {
  const first = bytes[0] ?? 0;
  return { length: bytes.byteLength, fill: bytes.every((byte) => byte === first) ? first : "mixed" };
}

export function readChunk(disk: ManagedDisk, index: number): Uint8Array {
  const output = new Uint8Array(MIB);
  disk.read(index * MIB, output);
  return output;
}
