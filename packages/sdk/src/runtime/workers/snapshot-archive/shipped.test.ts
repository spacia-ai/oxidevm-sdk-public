import { describe, expect, it } from "vitest";

import { decodeSnapshotManifest, type SnapshotManifest } from "../snapshot-manifest.js";
import { backupFixture, hash, NOW, testSigner } from "./backup.test-support.js";
import { encodeShippedManifest, shippedSigningBytes, verifyShippedManifest } from "./shipped.js";
import { chunkStream, findImageRanges, withoutRanges, type ShippedTransport } from "./shipped-transport.js";
import { chunked, filled, loadedMachine, sha } from "./shipped-transport.test-support.js";
import type { ShippedSigner } from "./shipped-publish.js";

const IMAGE = { id: "alpine", version: "2026.10.02", identity: hash(100) };
const KEY_ID = "boundary-development-2026";

function shippedSnapshot(overrides: Record<string, unknown> = {}): SnapshotManifest {
  return decodeSnapshotManifest(backupFixture({ kind: "shipped", label: "Boundary · container ready", ...overrides }));
}

/** The published manifest of `snapshot`, signed by `key` as the build signs it. */
async function published(key: ShippedSigner, snapshot = shippedSnapshot(), name = "container-ready", keyId = KEY_ID): Promise<Uint8Array<ArrayBuffer>> {
  const signature = await key.sign(shippedSigningBytes(name, snapshot, keyId));
  return encodeShippedManifest(name, snapshot, { keyId, signature });
}

async function refusal(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("shipped restore point manifests", () => {
  it("accepts a manifest signed by the trusted key for this image", async () => {
    const key = await testSigner(KEY_ID);
    const bytes = await published(key);

    const shipped = await verifyShippedManifest(bytes, {
      name: "container-ready",
      trusted: { keyId: KEY_ID, publicKey: key.publicKey },
      image: IMAGE,
      nowUnixMs: NOW,
    });

    expect(shipped.snapshot).toEqual(shippedSnapshot());
    expect(shipped.objects.map((object) => object.sha256)).toEqual([1, 2, 3, 4, 6, 7, 8].map(hash));
  });

  it("refuses a tampered manifest, an unknown key, or another key", async () => {
    const key = await testSigner(KEY_ID);
    const other = await testSigner(KEY_ID);
    const expected = { name: "container-ready", trusted: { keyId: KEY_ID, publicKey: key.publicKey }, image: IMAGE, nowUnixMs: NOW };
    const bytes = await published(key);
    const tampered = new TextEncoder().encode(new TextDecoder().decode(bytes).replace('"vcpus":1', '"vcpus":2'));

    expect(await refusal(verifyShippedManifest(tampered, expected))).toMatchObject({ code: "PERMISSION_DENIED", detail: { reason: "shipped-signature-invalid" } });
    expect(await refusal(verifyShippedManifest(await published(key, shippedSnapshot(), "container-ready", "someone-else"), expected)))
      .toMatchObject({ code: "PERMISSION_DENIED", detail: { reason: "shipped-untrusted" } });
    expect(await refusal(verifyShippedManifest(await published(other), expected))).toMatchObject({ detail: { reason: "shipped-signature-invalid" } });
  });

  it("refuses versions it does not read and restore points of another image or name", async () => {
    const key = await testSigner(KEY_ID);
    const expected = { name: "container-ready", trusted: { keyId: KEY_ID, publicKey: key.publicKey }, image: IMAGE, nowUnixMs: NOW };
    const text = new TextDecoder().decode(await published(key));
    const edited = (from: string, to: string) => new TextEncoder().encode(text.replace(from, to));

    for (const [label, bytes, reason] of [
      ["a newer format", edited('"formatVersion":1', '"formatVersion":3'), "shipped-newer"],
      ["version 2 without its transport", edited('"formatVersion":1', '"formatVersion":2'), "shipped-damaged"],
      ["an older format", edited('"formatVersion":1', '"formatVersion":0'), "shipped-older"],
      ["a newer restore point schema", edited('"schema":2', '"schema":5'), "shipped-newer"],
      ["another format", edited('"oxidevm-shipped-snapshot"', '"oxidevm-backup"'), "shipped-damaged"],
      ["not JSON", new TextEncoder().encode("{"), "shipped-damaged"],
      ["another image version", await published(key, shippedSnapshot({ disk: { ...diskOf(), image: { id: "alpine", version: "2026.11.01" } } })), "shipped-incompatible"],
      ["another image identity", await published(key, shippedSnapshot({ disk: { ...diskOf(), baseIdentity: hash(200) } })), "shipped-incompatible"],
      ["a raw-kernel machine", await published(key, shippedSnapshot({ disk: null })), "shipped-incompatible"],
      ["another name", await published(key, shippedSnapshot(), "other-example"), "shipped-damaged"],
      ["a personal restore point", await published(key, shippedSnapshot({ kind: "named" })), "shipped-damaged"],
    ] as const) {
      expect(await refusal(verifyShippedManifest(bytes, expected)), label).toMatchObject({ detail: { reason } });
    }
  });

  it("classifies a schema 3 Userspace restore point as older rather than damaged", async () => {
    const key = await testSigner(KEY_ID);
    const legacy = new TextEncoder().encode(JSON.stringify({ format: "oxidevm-shipped-snapshot", formatVersion: 1, name: "container-ready", snapshot: { schema: 3, mode: "userspace" }, signing: { keyId: KEY_ID, signature: "" } }));
    expect(await refusal(verifyShippedManifest(legacy, { name: "container-ready", trusted: { keyId: KEY_ID, publicKey: key.publicKey }, image: IMAGE, nowUnixMs: NOW }))).toMatchObject({ code: "SNAPSHOT_VERSION", detail: { reason: "shipped-older" } });
  });
});

function diskOf(): Record<string, unknown> {
  const disk = backupFixture()["disk"];
  if (typeof disk !== "object" || disk === null) throw new Error("fixture has no disk");
  return { ...disk };
}

describe("shipped Userspace starts that leave out their image files", () => {
  const ROOT = hash(300);
  const NATIVE_IMAGE = { mode: "userspace" as const, id: "boundary-docker", version: "2026.10.16-2", identity: ROOT };
  async function nativeStart(): Promise<{ readonly snapshot: SnapshotManifest; readonly transport: ShippedTransport }> {
    const machine = loadedMachine(), graph = filled(5_000, 4);
    const snapshot = decodeSnapshotManifest({
      schema: 4, mode: "userspace", id: "123e4567-e89b-42d3-a456-426614174000", createdAt: "2026-10-02T10:00:00.000Z", kind: "shipped", label: "B-01 Act 1 ready",
      capturedAtUnixMs: NOW - 3_600_000, parent: null, compatibility: { format: "OXUC", version: 4, abiVersion: 37, memoryBytes: 1536 * 1024 ** 2 },
      graph: { bytes: graph.length, chunks: [{ index: 0, sha256: sha(graph), bytes: graph.length }] }, payloads: chunked(machine.stream).stream,
      rootfs: { origin: "managed", image: { id: NATIVE_IMAGE.id, version: NATIVE_IMAGE.version }, rootTreeSha256: ROOT, manifest: { sha256: hash(301), bytes: 900 } },
    });
    const images = await findImageRanges(machine.stream, machine.sizes);
    return { snapshot, transport: { kind: "image-files", literal: await chunkStream(withoutRanges(machine.stream, images)), images } };
  }
  async function signed(key: ShippedSigner, snapshot: SnapshotManifest, transport: ShippedTransport): Promise<Uint8Array<ArrayBuffer>> {
    const signature = await key.sign(shippedSigningBytes("b01-act1", snapshot, KEY_ID, transport));
    return encodeShippedManifest("b01-act1", snapshot, { keyId: KEY_ID, signature }, transport);
  }

  it("downloads the literal stream and the other areas instead of the image's bytes", async () => {
    const key = await testSigner(KEY_ID), { snapshot, transport } = await nativeStart();
    const shipped = await verifyShippedManifest(await signed(key, snapshot, transport), { name: "b01-act1", trusted: { keyId: KEY_ID, publicKey: key.publicKey }, image: NATIVE_IMAGE, nowUnixMs: NOW });
    expect(shipped.transport).toEqual(transport);
    const objects = new Set(shipped.objects.map(object => object.sha256));
    for (const chunk of transport.literal.chunks) expect(objects.has(chunk.sha256)).toBe(true);
    for (const chunk of snapshot.schema === 4 ? snapshot.payloads.chunks : []) expect(objects.has(chunk.sha256)).toBe(false);
    expect(objects.has(snapshot.schema === 4 ? snapshot.graph.chunks[0]?.sha256 ?? "" : "")).toBe(true);
    expect(shipped.objects.reduce((sum, object) => sum + object.bytes, 0)).toBeLessThan(snapshot.schema === 4 ? snapshot.payloads.bytes : 0);
  });

  it("signs the transport with the restore point", async () => {
    const key = await testSigner(KEY_ID), { snapshot, transport } = await nativeStart();
    const text = new TextDecoder().decode(await signed(key, snapshot, transport));
    const first = transport.literal.chunks[0]?.sha256 ?? "";
    const tampered = new TextEncoder().encode(text.replace(first, hash(999)));
    expect(await refusal(verifyShippedManifest(tampered, { name: "b01-act1", trusted: { keyId: KEY_ID, publicKey: key.publicKey }, image: NATIVE_IMAGE, nowUnixMs: NOW })))
      .toMatchObject({ detail: { reason: "shipped-signature-invalid" } });
  });

  it("refuses a transport whose geometry does not fit the payload stream", async () => {
    const key = await testSigner(KEY_ID), { snapshot, transport } = await nativeStart();
    const broken: ShippedTransport = { ...transport, images: transport.images.slice(1) };
    expect(await refusal(verifyShippedManifest(await signed(key, snapshot, broken), { name: "b01-act1", trusted: { keyId: KEY_ID, publicKey: key.publicKey }, image: NATIVE_IMAGE, nowUnixMs: NOW })))
      .toMatchObject({ detail: { reason: "shipped-damaged" } });
  });
});
