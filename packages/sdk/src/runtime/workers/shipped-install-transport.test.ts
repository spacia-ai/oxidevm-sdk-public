import { expect, it } from "vitest";
import type { ManagedImageSnapshot } from "../managed-image.js";
import { gzip } from "./snapshot-archive/gzip.js";
import type { ShippedManifest } from "./snapshot-archive/shipped.js";
import { chunkStream, findImageRanges, withoutRanges } from "./snapshot-archive/shipped-transport.js";
import { chunked, filled, loadedMachine, payloadStream, sha } from "./snapshot-archive/shipped-transport.test-support.js";
import { decodeSnapshotManifest, SNAPSHOT_CHUNK_BYTES, type ObjectRef } from "./snapshot-manifest.js";
import { rebuildShippedPayloads, type ShippedInstallRun } from "./shipped-install.js";

const MANIFEST = new URL("https://boundary.example.test/oxidevm/snapshots/abc/snapshot/manifest.json");

type Machine = ReturnType<typeof loadedMachine>;

async function transported(machine: Machine = loadedMachine()): Promise<{ readonly shipped: ShippedManifest; readonly literalFiles: ReadonlyMap<string, Uint8Array<ArrayBuffer>>; readonly machine: Machine }> {
  const graph = filled(5_000, 4);
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

/** Bytes no two 1 MiB chunks of which are alike. */
function noise(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; bytes[index] = state & 0xff; }
  return bytes;
}

/** A machine whose payloads are mostly its own memory: twelve literal chunks around one image file. */
function largeMachine(): Machine {
  const binary = noise(SNAPSHOT_CHUNK_BYTES + 4_097, 7);
  // Blobs of other sizes than the image file stay in the literal stream.
  const stream = payloadStream([{ kind: 0n, bytes: noise(6 * SNAPSHOT_CHUNK_BYTES + 5, 2) }, { kind: 0n, bytes: binary }, { kind: 0n, bytes: noise(5 * SNAPSHOT_CHUNK_BYTES + 77, 5) }]);
  const files = new Map([[sha(binary), binary]]);
  return { stream, files, sizes: new Map([...files].map(([hash, bytes]) => [hash, bytes.length])) };
}

/**
 * A server whose downloads finish only when the test lets them, latest first, so they complete out
 * of order; a download whose signal aborts fails, and a file it does not hold fails at once.
 */
function gated(files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>) {
  const waiting: (() => void)[] = [], fetched: string[] = [], signals: AbortSignal[] = [];
  let peak = 0;
  const fetchBytes: ShippedInstallRun["fetchBytes"] = (url, _maxBytes, signal) => new Promise((resolve, reject) => {
    const path = url.pathname.slice(url.pathname.indexOf("chunks/")), body = files.get(path);
    fetched.push(path); signals.push(signal);
    if (body === undefined) { reject(new Error("404")); return; }
    const finish = () => resolve(body);
    waiting.push(finish); peak = Math.max(peak, waiting.length);
    signal.addEventListener("abort", () => {
      const at = waiting.indexOf(finish); if (at !== -1) waiting.splice(at, 1);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
  return { fetchBytes, waiting, fetched, signals, peak: () => peak };
}

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const readImage = (machine: Machine): NonNullable<ShippedInstallRun["readImageFile"]> => (sha256, bytes) => {
  const file = machine.files.get(sha256);
  return file !== undefined && file.length === bytes ? Promise.resolve(file) : Promise.reject(new Error("missing"));
};

it("downloads the literal chunks eight at a time, each once, with exact progress when they finish out of order", async () => {
  const { shipped, literalFiles, machine } = await transported(largeMachine()), served = gated(literalFiles), imports = new FakeImport();
  const totalBytes = [...literalFiles.values()].reduce((sum, body) => sum + body.length, 0), reports: (readonly [number, number])[] = [];
  expect(literalFiles.size).toBeGreaterThan(8);
  let clock = 0, settled = false;
  const rebuilding = rebuildShippedPayloads(imports, shipped, { ...listing(), bytes: totalBytes }, {
    ...run(literalFiles, [], readImage(machine)), fetchBytes: served.fetchBytes,
    now: () => (clock += 1_000), progress: (completed, total) => reports.push([completed, total]),
  });
  void rebuilding.finally(() => { settled = true; });
  // Read through a call: the rebuild settles while the loop awaits, which narrowing cannot see.
  const finished = (): boolean => settled;
  // Latest first: every download finishes after the ones started after it.
  while (!finished()) { await turn(); served.waiting.pop()?.(); }
  await rebuilding;
  if (shipped.snapshot.schema !== 4) throw new Error("expected a Userspace start");
  for (const chunk of shipped.snapshot.payloads.chunks) expect(sha(imports.stored.get(chunk.sha256) ?? new Uint8Array())).toBe(chunk.sha256);
  expect(served.peak()).toBe(8);
  expect([...served.fetched].sort()).toEqual([...literalFiles.keys()].sort());
  for (let index = 1; index < reports.length; index++) expect(reports[index]?.[0]).toBeGreaterThan(reports[index - 1]?.[0] ?? 0);
  expect(reports.every(([, total]) => total === totalBytes)).toBe(true);
  expect(reports.at(-1)).toEqual([totalBytes, totalBytes]);
});

it("adds its downloads to the install's own byte count", async () => {
  const { shipped, literalFiles, machine } = await transported(largeMachine()), counted: number[] = [];
  await rebuildShippedPayloads(new FakeImport(), shipped, listing(), run(literalFiles, [], readImage(machine)), bytes => counted.push(bytes));
  expect(counted.reduce((sum, bytes) => sum + bytes, 0)).toBe([...literalFiles.values()].reduce((sum, body) => sum + body.length, 0));
});

it("cancels every literal download in flight when the install is cancelled", async () => {
  const { shipped, literalFiles, machine } = await transported(largeMachine()), served = gated(literalFiles), controller = new AbortController(), imports = new FakeImport();
  const rebuilding = rebuildShippedPayloads(imports, shipped, listing(), { ...run(literalFiles, [], readImage(machine)), fetchBytes: served.fetchBytes, signal: controller.signal });
  while (served.waiting.length < 8) await turn();
  controller.abort();
  await expect(rebuilding).rejects.toMatchObject({ code: "ABORTED" });
  expect(served.fetched).toHaveLength(8);
  expect(served.signals.every(signal => signal.aborted)).toBe(true);
  expect(served.waiting).toEqual([]);
  expect(imports.stored.size).toBe(0);
});

it("fails with the unavailable chunk's error, and cancels the downloads still in flight", async () => {
  const { shipped, literalFiles, machine } = await transported(largeMachine()), imports = new FakeImport();
  const lost = [...literalFiles.keys()][3];
  const served = gated(new Map([...literalFiles].filter(([path]) => path !== lost)));
  const error = await rebuildShippedPayloads(imports, shipped, listing(), { ...run(literalFiles, [], readImage(machine)), fetchBytes: served.fetchBytes })
    .then(() => undefined, (failure: unknown) => failure);
  expect(error).toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "shipped-unavailable" } });
  // Three tries of the lost chunk, and no download outlives the failure.
  expect(served.fetched.filter(path => path === lost)).toHaveLength(3);
  expect(served.signals.every(signal => signal.aborted)).toBe(true);
  expect(served.waiting).toEqual([]);
  expect(imports.stored.size).toBe(0);
});
