import { describe, expect, it } from "vitest";

import { sha256Hex } from "../snapshot-content.js";
import { decodeSnapshotManifest, type SnapshotManifest } from "../snapshot-manifest.js";
import { backupFixture, hash, NOW } from "./backup.test-support.js";
import { isBackupError } from "./errors.js";
import { readBackup } from "./reader.js";
import { tarEnd, tarHeader, tarPadding } from "./tar.js";
import { writeBackup } from "./writer.js";

/** Cases per run: `pnpm fuzz:archive` runs many; every test run runs a few. */
const RUNS = Number(process.env["OXIDEVM_ARCHIVE_FUZZ_RUNS"] ?? "300");
const BLOCK = 512;

/** A deterministic xorshift generator, so a failing case can be replayed from its index. */
function generator(seed: number): (limit: number) => number {
  let state = seed >>> 0 || 1;
  return (limit) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state % Math.max(1, limit);
  };
}

/** A small restore point (no RAM or disk chunks) whose objects have real content. */
async function smallRestorePoint(): Promise<{ snapshot: SnapshotManifest; contents: Map<string, Uint8Array<ArrayBuffer>> }> {
  const contents = new Map<string, Uint8Array<ArrayBuffer>>();
  const object = async (bytes: number, fill: number) => {
    const content = new Uint8Array(bytes).fill(fill);
    const sha256 = await sha256Hex(content);
    contents.set(sha256, content);
    return { sha256, bytes };
  };
  const kernel = new Uint8Array(10).fill(5);
  const snapshot = decodeSnapshotManifest(backupFixture({
    machine: { record: await object(4096, 1), memoryBytes: 16 * 1024 * 1024, vcpus: 1 },
    ram: [],
    disk: { origin: "managed", bytes: 4 * 1024 * 1024, baseIdentity: hash(100), image: { id: "alpine", version: "2026.10.02" }, chunks: [] },
    assets: { kernel: { sha256: await sha256Hex(kernel), bytes: kernel.byteLength } },
    host: { agent: await object(100, 6), appData: await object(5, 7) },
    workspace: { baseSha256: hash(101), generation: 3, index: await object(50, 8) },
  }));
  return { snapshot, contents };
}

async function archiveOf(snapshot: SnapshotManifest, contents: ReadonlyMap<string, Uint8Array<ArrayBuffer>>): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  await writeBackup(snapshot, (ref) => {
    const content = contents.get(ref.sha256);
    return content === undefined ? Promise.reject(new Error("missing content")) : Promise.resolve(content);
  }, (bytes) => {
    parts.push(bytes.slice());
    return Promise.resolve();
  });
  return concat(parts);
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

/** `archive` with its manifest replaced by `manifest`, behind a valid tar header. */
function withManifest(archive: Uint8Array, manifest: Uint8Array): Uint8Array<ArrayBuffer> {
  const size = parseInt(new TextDecoder().decode(archive.subarray(124, 135)), 8);
  const rest = archive.subarray(BLOCK + Math.ceil(size / BLOCK) * BLOCK);
  return concat([tarHeader("manifest.json", manifest.byteLength), manifest, tarPadding(manifest.byteLength), rest]);
}

/** A JSON edit of the manifest: a field removed, a number shifted, a string or kind replaced. */
function editManifest(valid: Uint8Array, random: (limit: number) => number): Uint8Array {
  const text = new TextDecoder().decode(valid);
  const edits: ((source: string) => string)[] = [
    (source) => source.replace(/"(\w+)":/u, (match) => (random(2) === 0 ? match : `"x${match.slice(1)}`)),
    (source) => source.replace(/\d+/gu, (digits) => (random(8) === 0 ? String(Number(digits) + random(4096) - 2048) : digits)),
    (source) => source.replace(/"[0-9a-f]{64}"/gu, (value) => (random(4) === 0 ? `"${"f".repeat(64)}"` : value)),
    (source) => source.replace('"named"', ['"imported"', '"shipped"', '"other"', "null"][random(4)] ?? "null"),
    (source) => source.slice(0, random(source.length)),
  ];
  const edit = edits[random(edits.length)] ?? ((source: string) => source);
  return new TextEncoder().encode(edit(text));
}

/** One random change to `archive`. */
function mutate(archive: Uint8Array, manifest: Uint8Array, random: (limit: number) => number): Uint8Array {
  const copy = archive.slice();
  switch (random(5)) {
    case 0:
      for (let flips = 1 + random(8); flips > 0; flips -= 1) {
        const index = random(copy.byteLength);
        copy[index] = (copy[index] ?? 0) ^ (1 + random(255));
      }
      return copy;
    case 1:
      return copy.slice(0, random(copy.byteLength));
    case 2: {
      const at = random(copy.byteLength);
      const inserted = new Uint8Array(1 + random(1024)).map(() => random(256));
      return concat([copy.subarray(0, at), inserted, copy.subarray(at)]);
    }
    case 3: {
      const block = random(Math.floor(copy.byteLength / BLOCK)) * BLOCK;
      return concat([copy.subarray(0, block + BLOCK), copy.subarray(block, block + BLOCK), copy.subarray(block + BLOCK)]);
    }
    default:
      return withManifest(copy, editManifest(manifest, random));
  }
}

function source(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes.slice()]).stream();
}

describe("backup archive fuzzing", () => {
  it(`refuses ${String(RUNS)} damaged archives only with backup reasons`, async () => {
    const { snapshot, contents } = await smallRestorePoint();
    const archive = await archiveOf(snapshot, contents);
    const size = parseInt(new TextDecoder().decode(archive.subarray(124, 135)), 8);
    const manifest = archive.slice(BLOCK, BLOCK + size);
    const random = generator(0x4f58_564d);
    const reasons = new Map<string, number>();
    let accepted = 0;

    for (let index = 0; index < RUNS; index += 1) {
      const candidate = mutate(archive, manifest, random);
      const entries = readBackup(source(candidate), { nowUnixMs: NOW });
      try {
        while ((await entries.next()).done !== true) {
          // Read every entry, as an import would.
        }
        accepted += 1;
      } catch (error) {
        if (!isBackupError(error)) throw new Error(`case ${String(index)} failed outside the backup reasons`, { cause: error });
        const reason = String(error.detail?.["reason"]);
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }

    expect(accepted + [...reasons.values()].reduce((total, count) => total + count, 0)).toBe(RUNS);
    expect([...reasons.keys()]).toContain("backup-damaged");
    expect([...reasons.keys()]).toContain("backup-wrong-file");
    // The end-of-archive marker is all zero, so a change confined to it can be harmless.
    expect(tarEnd().every((byte) => byte === 0)).toBe(true);
  }, 300_000);
});
