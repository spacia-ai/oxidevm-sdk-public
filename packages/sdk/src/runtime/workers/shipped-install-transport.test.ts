import { expect, it } from "vitest";
import type { ManagedImageSnapshot } from "../managed-image.js";
import { gzip } from "./snapshot-archive/gzip.js";
import type { ShippedManifest } from "./snapshot-archive/shipped.js";
import { chunkStream, findImageRanges, withoutRanges } from "./snapshot-archive/shipped-transport.js";
import { chunked, filled, loadedMachine, sha } from "./snapshot-archive/shipped-transport.test-support.js";
import { decodeSnapshotManifest, SNAPSHOT_CHUNK_BYTES, type ObjectRef } from "./snapshot-manifest.js";
import { rebuildShippedPayloads, type ShippedInstallRun } from "./shipped-install.js";

const MANIFEST = new URL("https://boundary.example.test/oxidevm/snapshots/abc/snapshot/manifest.json");

async function transported(): Promise<{ readonly shipped: ShippedManifest; readonly literalFiles: ReadonlyMap<string, Uint8Array<ArrayBuffer>>; readonly machine: ReturnType<typeof loadedMachine> }> {
  const machine = loadedMachine(), graph = filled(5_000, 4);
  const snapshot = decodeSnapshotManifest({
    schema: 4, mode: "userspace", id: "123e4567-e89b-42d3-a456-426614174000", createdAt: "2026-10-02T10:00:00.000Z", kind: "shipped", label: "ready",
    capturedAtUnixMs: Date.parse("2026-10-02T10:00:02.000Z"), parent: null, compatibility: { format: "OXUC", version: 4, abiVersion: 37, memoryBytes: 1536 * 1024 ** 2 },
    graph: { bytes: graph.length, chunks: [{ index: 0, sha256: sha(graph), bytes: graph.length }] }, payloads: chunked(machine.stream).stream,
    rootfs: { origin: "managed", image: { id: "boundary-docker", version: "1" }, rootTreeSha256: "a".repeat(64), manifest: { sha256: "b".repeat(64), bytes: 9 } },
  });
  const images = await findImageRanges(machine.stream, machine.sizes), literal = withoutRanges(machine.stream, images);
  const transport = { kind: "image-files" as const, literal: await chunkStream(literal), images };
  const literalFiles = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const chunk of transport.literal.chunks) {
    literalFiles.set(`chunks/${chunk.sha256}.gz`, await gzip(literal.slice(chunk.index * SNAPSHOT_CHUNK_BYTES, chunk.index * SNAPSHOT_CHUNK_BYTES + chunk.bytes)));
  }
  return { shipped: { name: "b01-act1", snapshot, objects: [], transport }, literalFiles, machine };
}

function listing(): ManagedImageSnapshot {
  return { name: "b01-act1", manifest: { url: MANIFEST, bytes: 1, sha256: "c".repeat(64) }, bytes: 64 * 1024 ** 2 };
}

function run(files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>, fetched: string[], readImageFile?: ShippedInstallRun["readImageFile"]): ShippedInstallRun {
  return {
    enqueue: turn => turn(), signal: new AbortController().signal, now: () => 0,
    fetchBytes: url => {
      const path = url.pathname.slice(url.pathname.indexOf("chunks/")); fetched.push(path);
      const body = files.get(path); return body === undefined ? Promise.reject(new Error("404")) : Promise.resolve(body);
    },
    ...(readImageFile === undefined ? {} : { readImageFile }),
  };
}

class FakeImport {
  readonly stored = new Map<string, Uint8Array>();
  constructor(readonly present: ReadonlySet<string> = new Set()) {}
  needs(ref: ObjectRef): boolean { return !this.stored.has(ref.sha256); }
  adopt(ref: ObjectRef): Promise<boolean> { return Promise.resolve(this.present.has(ref.sha256)); }
  put(ref: ObjectRef, content: Uint8Array): Promise<void> { this.stored.set(ref.sha256, content); return Promise.resolve(); }
}

it("rebuilds every payload chunk from the literal chunks and the image's files", async () => {
  const { shipped, literalFiles, machine } = await transported(), fetched: string[] = [], imports = new FakeImport();
  const read: string[] = [];
  await rebuildShippedPayloads(imports, shipped, listing(), run(literalFiles, fetched, (sha256, bytes) => {
    read.push(sha256); const file = machine.files.get(sha256);
    return file !== undefined && file.length === bytes ? Promise.resolve(file) : Promise.reject(new Error("missing"));
  }));
  if (shipped.snapshot.schema !== 4) throw new Error("expected a Userspace start");
  for (const chunk of shipped.snapshot.payloads.chunks) expect(sha(imports.stored.get(chunk.sha256) ?? new Uint8Array())).toBe(chunk.sha256);
  expect(new Set(fetched)).toEqual(new Set(literalFiles.keys()));
  expect(new Set(read)).toEqual(new Set(machine.files.keys()));
});

it("downloads nothing for chunks the store already holds", async () => {
  const { shipped, literalFiles, machine } = await transported(), fetched: string[] = [];
  if (shipped.snapshot.schema !== 4) throw new Error("expected a Userspace start");
  const imports = new FakeImport(new Set(shipped.snapshot.payloads.chunks.map(chunk => chunk.sha256)));
  await rebuildShippedPayloads(imports, shipped, listing(), run(literalFiles, fetched, sha256 => Promise.resolve(machine.files.get(sha256) ?? new Uint8Array())));
  expect(fetched).toEqual([]);
  expect(imports.stored.size).toBe(0);
});

it("refuses an image file whose bytes differ, and a browser that cannot read the image", async () => {
  const { shipped, literalFiles } = await transported();
  await expect(rebuildShippedPayloads(new FakeImport(), shipped, listing(), run(literalFiles, [], (_sha256, bytes) => Promise.resolve(filled(bytes, 99)))))
    .rejects.toMatchObject({ detail: { reason: "shipped-damaged" } });
  await expect(rebuildShippedPayloads(new FakeImport(), shipped, listing(), run(literalFiles, [])))
    .rejects.toMatchObject({ detail: { reason: "shipped-unavailable" } });
});
