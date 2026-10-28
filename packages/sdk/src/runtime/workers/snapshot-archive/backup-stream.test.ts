import { describe, expect, it } from "vitest";

import { sha256Hex } from "../snapshot-content.js";
import { backupContent, type BackupContent, concat, exported, NOW } from "./backup.test-support.js";
import { gzip } from "./gzip.js";
import { encodeBackupManifest } from "./manifest.js";
import { type BackupEntry, readBackup } from "./reader.js";
import { tarEnd, tarHeader, tarPadding } from "./tar.js";
import { writeBackup } from "./writer.js";

const encoder = new TextEncoder();

/** Each object's hash and the hash of its content, which match when the content is intact. */
async function digests(contents: ReadonlyMap<string, Uint8Array<ArrayBuffer>>): Promise<[string, string][]> {
  const pairs: [string, string][] = [];
  for (const [sha256, bytes] of contents) pairs.push([sha256, await sha256Hex(bytes)]);
  return pairs.sort(([left], [right]) => (left < right ? -1 : 1));
}

/** A tar archive of `files` in order, without validating them. */
function archive(files: readonly { readonly name: string; readonly data: Uint8Array }[], end = true): Uint8Array<ArrayBuffer> {
  return concat([
    ...files.flatMap(({ name, data }) => [tarHeader(name, data.byteLength), data, tarPadding(data.byteLength)]),
    ...(end ? [tarEnd()] : []),
  ]);
}

/** `bytes` as a stream that hands out `pieces` in turn, counting how many were taken. */
function counted(pieces: readonly Uint8Array[]): { readonly stream: ReadableStream<Uint8Array>; readonly taken: () => number } {
  let next = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const piece = pieces[next];
      next += 1;
      if (piece === undefined) controller.close();
      else controller.enqueue(piece);
    },
  }, { highWaterMark: 0 });
  return { stream, taken: () => Math.min(next, pieces.length) };
}

async function readAll(bytes: Uint8Array, maxFileBytes?: number): Promise<BackupEntry[]> {
  const entries: BackupEntry[] = [];
  const source = counted([bytes]).stream;
  for await (const entry of readBackup(source, { nowUnixMs: NOW, ...(maxFileBytes === undefined ? {} : { maxFileBytes }) })) {
    entries.push(entry);
  }
  return entries;
}

async function refusal(bytes: Uint8Array, maxFileBytes?: number): Promise<unknown> {
  try {
    await readAll(bytes, maxFileBytes);
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The files of a valid backup of `content`: its manifest, then each chunk gzipped. */
async function files(content: BackupContent): Promise<{ name: string; data: Uint8Array<ArrayBuffer> }[]> {
  const chunks = [];
  for (const [sha256, bytes] of [...content.contents].sort(([left], [right]) => (left < right ? -1 : 1))) {
    chunks.push({ name: `chunks/${sha256}.gz`, data: await gzip(bytes) });
  }
  return [{ name: "manifest.json", data: encodeBackupManifest(content.snapshot) }, ...chunks];
}

describe("backup streams", () => {
  it("writes the manifest, then every carried object gzipped in hash order, then the end", async () => {
    const content = await backupContent();

    const bytes = await exported(content);

    expect(await sha256Hex(bytes)).toBe(await sha256Hex(archive(await files(content))));
    expect([...content.contents.keys()]).not.toContain(content.snapshot.assets.kernel.sha256);
  });

  it("reads back the manifest and every object, and writes the same bytes again", async () => {
    const content = await backupContent();
    const bytes = await exported(content);

    const entries = await readAll(bytes);
    const [first, ...objects] = entries;
    if (first?.kind !== "manifest") throw new Error("the manifest did not come first");
    const contents = new Map(objects.flatMap((entry) => (entry.kind === "object" ? [[entry.ref.sha256, entry.content]] : [])));
    if (first.manifest.snapshot.schema !== 2) throw new Error("expected system fixture");
    const again = await exported({ ...content, snapshot: first.manifest.snapshot, contents });

    expect(first.manifest.snapshot).toEqual(content.snapshot);
    expect(await digests(contents)).toEqual(await digests(content.contents));
    expect(await sha256Hex(again)).toBe(await sha256Hex(bytes));
    expect(await sha256Hex(await exported(content))).toBe(await sha256Hex(bytes));
  });

  it("refuses a newer backup before reading any chunk", async () => {
    const newer = encoder.encode('{"format":"oxidevm-backup","formatVersion":2,"somethingNew":true}');
    const manifest = archive([{ name: "manifest.json", data: newer }], false);
    const rest = archive((await files(await backupContent())).slice(1));
    const source = counted([manifest, rest]);

    const reading = readBackup(source.stream, { nowUnixMs: NOW });

    await expect(reading.next()).rejects.toMatchObject({ code: "SNAPSHOT_VERSION", detail: { reason: "backup-newer" } });
    expect(source.taken()).toBe(1);
  });

  it("gives each kind of damage its reason", async () => {
    const content = await backupContent();
    const valid = await files(content);
    const bytes = archive(valid);
    const [manifest, firstChunk, secondChunk] = valid;
    if (manifest === undefined || firstChunk === undefined || secondChunk === undefined) throw new Error("fixture is too small");
    const corrupt = firstChunk.data.slice();
    corrupt[Math.floor(corrupt.byteLength / 2)] = (corrupt[Math.floor(corrupt.byteLength / 2)] ?? 0) ^ 0xff;
    const swapped = { ...firstChunk, data: secondChunk.data };
    const appData = valid.find((file) => file.data.byteLength < 100 && file.name !== "manifest.json");
    if (appData === undefined) throw new Error("fixture has no small object");

    for (const [label, damaged, reason] of [
      ["an image", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "backup-wrong-file"],
      ["another first file", archive([{ name: "readme.txt", data: encoder.encode("hi") }, ...valid.slice(1)]), "backup-wrong-file"],
      ["an empty archive", tarEnd(), "backup-wrong-file"],
      ["a manifest that is not JSON", archive([{ name: "manifest.json", data: encoder.encode("{") }, ...valid.slice(1)]), "backup-wrong-file"],
      ["cut inside a chunk", bytes.slice(0, bytes.byteLength - 2_000), "backup-damaged"],
      ["no end marker", archive(valid, false), "backup-damaged"],
      ["a corrupt chunk", archive([manifest, { ...firstChunk, data: corrupt }, ...valid.slice(2)]), "backup-damaged"],
      ["a chunk with other content", archive([manifest, swapped, ...valid.slice(2)]), "backup-damaged"],
      ["chunks out of order", archive([manifest, secondChunk, firstChunk, ...valid.slice(3)]), "backup-damaged"],
      ["a missing chunk", archive([manifest, ...valid.slice(2)]), "backup-damaged"],
      ["only the manifest", archive([manifest]), "backup-damaged"],
      ["an extra file", archive([...valid, { name: "extra.txt", data: encoder.encode("hi") }]), "backup-damaged"],
      ["a stored chunk far larger than its content", archive(valid.map((file) => (file === appData ? { ...file, data: new Uint8Array(5 + 64 * 1024 + 1) } : file))), "backup-damaged"],
      ["data after the end", concat([bytes, new Uint8Array(1)]), "backup-damaged"],
    ] as const) {
      expect(await refusal(damaged), label).toMatchObject({ detail: { reason } });
    }
    expect(await refusal(bytes, bytes.byteLength - 1), "larger than the file limit").toMatchObject({ detail: { reason: "backup-damaged" } });
    expect(await refusal(bytes, bytes.byteLength)).toBeUndefined();
  });

  it("refuses what only each check would catch: names, bloated gzip, and content of the right size", async () => {
    const content = await backupContent();
    const valid = await files(content);
    const [manifest, first, ...rest] = valid;
    if (manifest === undefined || first === undefined) throw new Error("fixture is too small");
    // The page data: 5 bytes, so 70 KiB of gzip header is far past its 64 KiB allowance.
    const appData = content.snapshot.host?.appData;
    const small = valid.find((file) => file.name === `chunks/${appData?.sha256 ?? ""}.gz` && file !== first);
    if (small === undefined) throw new Error("fixture has no page data after its first chunk");
    const sha256 = small.name.slice("chunks/".length, -".gz".length);
    const original = content.contents.get(sha256);
    if (original === undefined) throw new Error("fixture content is missing");
    const replace = (file: { readonly name: string; readonly data: Uint8Array }, data: Uint8Array) =>
      valid.map((candidate) => (candidate === file ? { ...file, data } : candidate));

    for (const [label, damaged, reason] of [
      ["a manifest under another name", archive([{ name: "backup.json", data: manifest.data }, first, ...rest]), "backup-wrong-file"],
      ["a chunk under another name", archive([manifest, { ...first, name: `chunks/${"f".repeat(64)}.gz` }, ...rest]), "backup-damaged"],
      ["a valid gzip bloated past its content", archive(replace(small, withComment(small.data, 70 * 1024))), "backup-damaged"],
      ["other content of the same size", archive(replace(small, await gzip(new Uint8Array(original.byteLength).fill(99)))), "backup-damaged"],
    ] as const) {
      expect(await refusal(damaged), label).toMatchObject({ detail: { reason } });
    }
  });

  it("refuses to write an object whose content has the wrong size", async () => {
    const content = await backupContent();

    const writing = writeBackup(content.snapshot, (ref) => Promise.resolve(new Uint8Array(ref.bytes + 1)), () => Promise.resolve());

    await expect(writing).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "snapshot-damaged" } });
  });
});

/** `member` with a `bytes`-long comment in its gzip header: still valid gzip of the same content. */
function withComment(member: Uint8Array, bytes: number): Uint8Array<ArrayBuffer> {
  const header = member.slice(0, 10);
  header[3] = (header[3] ?? 0) | 0x10;
  return concat([header, new Uint8Array(bytes).fill(0x61), new Uint8Array(1), member.subarray(10)]);
}
