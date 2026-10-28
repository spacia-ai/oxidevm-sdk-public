import { describe, expect, it } from "vitest";

import { sha256Hex } from "../snapshot-content.js";
import { backupContent, exported, hash, MIB, NOW, testSigner } from "./backup.test-support.js";
import { gunzipExact } from "./gzip.js";
import { verifyShippedManifest } from "./shipped.js";
import { publishShipped, publishShippedTo, type ShippedPublishOptions } from "./shipped-publish.js";
import { chunkName, writeBackup } from "./writer.js";
import { decodeSnapshotManifest } from "../snapshot-manifest.js";
import { concat } from "./backup.test-support.js";
import { rebuildChunk } from "./shipped-transport.js";
import { chunked, filled, loadedMachine, sha } from "./shipped-transport.test-support.js";

const IMAGE = { id: "alpine", version: "2026.10.02", identity: hash(100) };

function stream(bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array> {
  return new Blob([bytes]).stream();
}

async function options(overrides: Partial<ShippedPublishOptions> = {}): Promise<ShippedPublishOptions> {
  return {
    name: "container-ready",
    label: "Example start",
    image: IMAGE,
    signer: await testSigner("boundary-development"),
    nowUnixMs: NOW,
    maxDownloadBytes: 64 * MIB,
    ...overrides,
  };
}

async function refusal(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("shipped restore point publication", () => {
  it("streamed_and_collected_publications_are_identical", async () => {
    const backup = await exported(await backupContent());
    const publishing = await options();
    const collected = await publishShipped(stream(backup), publishing);
    const chunks: {name: string; bytes: Uint8Array<ArrayBuffer>}[] = [];
    const streamed = await publishShippedTo(stream(backup), publishing, (name, bytes) => {
      chunks.push({name, bytes}); return Promise.resolve();
    });
    expect(streamed.manifest).toEqual(collected.manifest);
    expect(chunks).toEqual(collected.chunks);
    expect(streamed.chunkBytes).toBe(collected.chunkBytes);
  });
  it("waits_for_sink_before_next_object", async () => {
    const backup = await exported(await backupContent());
    let outstanding = 0, maximumOutstandingWrites = 0;
    const pending: (() => void)[] = [];
    const operation = publishShippedTo(stream(backup), await options(), async () => {
      outstanding += 1; maximumOutstandingWrites = Math.max(maximumOutstandingWrites, outstanding);
      await new Promise<void>(resolve => pending.push(resolve));
      outstanding -= 1;
    });
    const state = {done:false};
    const supervised = operation.finally(() => {state.done = true;});
    while (!state.done) {
      await new Promise<void>(resolve => setImmediate(resolve));
      pending.shift()?.();
    }
    await supervised;
    expect(maximumOutstandingWrites).toBe(1);
  });
  it("sink_failure_stops_and_cancels_reader", async () => {
    const backup = await exported(await backupContent());
    let cancelled = false, writes = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {controller.enqueue(backup);},
      cancel() {cancelled = true;},
    });
    await expect(publishShippedTo(source, await options(), () => {
      writes += 1; return Promise.reject(new Error("sink failure"));
    })).rejects.toThrow("sink failure");
    expect(writes).toBe(1);
    expect(cancelled).toBe(true);
  });
  it("publishes a backup as the signed restore point installers read, identically each time", async () => {
    const content = await backupContent();
    const backup = await exported(content);
    const publishing = await options();

    const first = await publishShipped(stream(backup), publishing);
    const second = await publishShipped(stream(backup), publishing);

    expect(second.manifest).toEqual(first.manifest);
    expect(second.chunks).toEqual(first.chunks);
    const shipped = await verifyShippedManifest(first.manifest, {
      name: "container-ready",
      trusted: { keyId: publishing.signer.keyId, publicKey: publishing.signer.publicKey },
      image: IMAGE,
      nowUnixMs: NOW,
    });
    expect(shipped.snapshot).toEqual({ ...content.snapshot, kind: "shipped", label: "Example start" });
    expect(first.chunks.map((chunk) => chunk.name)).toEqual(shipped.objects.map((ref) => chunkName(ref.sha256)));
    for (const [index, chunk] of first.chunks.entries()) {
      const ref = shipped.objects[index];
      if (ref === undefined) throw new Error("a chunk the manifest does not name");
      expect(await sha256Hex(await gunzipExact(chunk.bytes, ref.bytes))).toBe(ref.sha256);
    }
    expect(first.chunkBytes).toBe(first.chunks.reduce((total, chunk) => total + chunk.bytes.byteLength, 0));
  });

  it("refuses a backup of another image, or one that downloads more than allowed", async () => {
    const backup = await exported(await backupContent());

    expect(await refusal(publishShipped(stream(backup), await options({ image: { ...IMAGE, identity: hash(200) } }))))
      .toMatchObject({ detail: { reason: "shipped-incompatible" } });
    expect(await refusal(publishShipped(stream(backup), await options({ image: { ...IMAGE, version: "2026.11.01" } }))))
      .toMatchObject({ detail: { reason: "shipped-incompatible" } });
    expect(await refusal(publishShipped(stream(backup), await options({ maxDownloadBytes: 1024 }))))
      .toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "shipped-too-large" } });
  });

  it("counts the manifest in the download limit, and refuses oversized chunks before signing", async () => {
    const backup = await exported(await backupContent());
    const published = await publishShipped(stream(backup), await options());
    const limit = published.chunkBytes + published.manifest.byteLength;
    const signer = await testSigner("boundary-development");
    let signed = 0;
    const counting = { ...signer, sign: (bytes: Uint8Array<ArrayBuffer>) => { signed += 1; return signer.sign(bytes); } };

    await expect(publishShipped(stream(backup), await options({ maxDownloadBytes: limit }))).resolves.toMatchObject({ chunkBytes: published.chunkBytes });
    expect(await refusal(publishShipped(stream(backup), await options({ maxDownloadBytes: limit - 1 }))))
      .toMatchObject({ detail: { reason: "shipped-too-large" } });
    expect(await refusal(publishShipped(stream(backup), await options({ maxDownloadBytes: published.chunkBytes - 1, signer: counting }))))
      .toMatchObject({ detail: { reason: "shipped-too-large" } });
    expect(signed).toBe(0);
  });

  it("refuses a file that is not a backup", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(1024)]);

    expect(await refusal(publishShipped(stream(png), await options()))).toMatchObject({ detail: { reason: "backup-wrong-file" } });
  });
});

describe("shipped Userspace publication without image file bytes", () => {
  const ROOT = hash(300);
  const NATIVE_IMAGE = { mode: "userspace" as const, id: "boundary-docker", version: "2026.10.16-2", identity: ROOT };
  async function nativeBackup(): Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; readonly machine: ReturnType<typeof loadedMachine>; readonly contents: ReadonlyMap<string, Uint8Array<ArrayBuffer>> }> {
    const machine = loadedMachine(), graph = filled(5_000, 4), rootfs = filled(900, 5);
    const payloads = chunked(machine.stream);
    const contents = new Map<string, Uint8Array<ArrayBuffer>>([...payloads.contents, [sha(graph), graph], [sha(rootfs), rootfs]]);
    const snapshot = decodeSnapshotManifest({
      schema: 4, mode: "userspace", id: "123e4567-e89b-42d3-a456-426614174000", createdAt: "2026-10-02T10:00:00.000Z", kind: "named", label: "ready",
      capturedAtUnixMs: NOW - 3_600_000, parent: null, compatibility: { format: "OXUC", version: 4, abiVersion: 37, memoryBytes: 1536 * MIB },
      graph: { bytes: graph.length, chunks: [{ index: 0, sha256: sha(graph), bytes: graph.length }] }, payloads: payloads.stream,
      rootfs: { origin: "managed", image: { id: NATIVE_IMAGE.id, version: NATIVE_IMAGE.version }, rootTreeSha256: ROOT, manifest: { sha256: sha(rootfs), bytes: rootfs.length } },
    });
    const parts: Uint8Array[] = [];
    await writeBackup(snapshot, ref => Promise.resolve(contents.get(ref.sha256) ?? new Uint8Array()), part => { parts.push(part.slice()); return Promise.resolve(); });
    return { bytes: concat(parts), machine, contents };
  }

  it("publishes the payload stream without the image's bytes and rebuilds it exactly", async () => {
    const { bytes, machine } = await nativeBackup();
    const publishing = await options({ name: "b01-act1", image: NATIVE_IMAGE });
    const written = new Map<string, Uint8Array<ArrayBuffer>>();
    const lean = await publishShippedTo(stream(bytes), { ...publishing, imageFiles: machine.sizes }, (name, chunk) => { written.set(name, chunk); return Promise.resolve(); });
    const full = await publishShippedTo(stream(bytes), publishing, () => Promise.resolve());
    expect(lean.chunkBytes).toBeLessThan(full.chunkBytes);
    const shipped = await verifyShippedManifest(lean.manifest, { name: "b01-act1", trusted: { keyId: publishing.signer.keyId, publicKey: publishing.signer.publicKey }, image: NATIVE_IMAGE, nowUnixMs: NOW });
    const transport = shipped.transport;
    if (transport === undefined || shipped.snapshot.schema !== 4) throw new Error("expected a transported start");
    expect([...written.keys()].sort()).toEqual(shipped.objects.map(object => chunkName(object.sha256)).sort());
    const literal = concat(await Promise.all(transport.literal.chunks.map(chunk => gunzipExact(written.get(chunkName(chunk.sha256)) ?? new Uint8Array(), chunk.bytes))));
    for (const chunk of shipped.snapshot.payloads.chunks) {
      const rebuilt = await rebuildChunk(chunk, transport, (offset, length) => Promise.resolve(literal.slice(offset, offset + length)),
        (range, offset, length) => Promise.resolve((machine.files.get(range.sha256) ?? new Uint8Array()).slice(offset, offset + length)));
      expect(await sha256Hex(rebuilt)).toBe(chunk.sha256);
    }
  });

  it("publishes the earlier format when no image file matches", async () => {
    const { bytes } = await nativeBackup();
    const publishing = await options({ name: "b01-act1", image: NATIVE_IMAGE });
    const published = await publishShippedTo(stream(bytes), { ...publishing, imageFiles: new Map([[hash(9), 77]]) }, () => Promise.resolve());
    expect(new TextDecoder().decode(published.manifest)).toContain('"formatVersion":1');
  });
});
