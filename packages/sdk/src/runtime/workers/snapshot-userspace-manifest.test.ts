import { describe, expect, it } from "vitest";
import { VMError } from "../errors.js";
import { decodeSnapshotManifest, encodeSnapshotManifest, manifestObjects } from "./snapshot-manifest.js";
import { decodeUserspaceManifest } from "./snapshot-userspace-manifest.js";
import { backupObjectsOf, decodeBackupManifest, encodeBackupManifest } from "./snapshot-archive/manifest.js";
import { compatibility, describeSnapshots } from "./snapshot-listing.js";
import { decodeSnapshotInfo } from "../protocol/snapshots.js";
import { SnapshotCatalog } from "./snapshot-catalog.js";
import { SnapshotObjects, writeOpfsFile } from "./snapshot-objects.js";
import { sha256Hex } from "./snapshot-content.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { retainedSnapshots, type RetentionCandidate } from "./snapshot-retention.js";
import { NATIVE_LOGICAL_CHECKPOINT_VERSION } from "../protocol/native-capture.js";
const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const MIB = 1024 * 1024;
function manifest(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    schema: 4, mode: "userspace", id: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-10-13T10:00:00.000Z", kind: "named", label: "Running shell",
    capturedAtUnixMs: Date.parse("2026-10-13T10:00:00.000Z"), parent: null,
    compatibility: { format: "OXUC", version: 1, abiVersion: 36, memoryBytes: 256 * MIB },
    graph: { bytes: 10, chunks: [{ index: 0, sha256: HASH, bytes: 10 }] },
    payloads: { bytes: MIB + 1, chunks: [{ index: 0, sha256: HASH, bytes: MIB }, { index: 1, sha256: OTHER, bytes: 1 }] },
    rootfs: { origin: "managed", image: { id: "alpine-rootfs", version: "2026.10.13" }, rootTreeSha256: HASH, manifest: { sha256: OTHER, bytes: 99 } },
    ...overrides,
  };
}
describe("Userspace snapshot schema4", () => {
  it("catalog rename and collection retain the complete native closure", async () => {
    const root = new MemoryDirectory("snapshots-v2");
    const objects = await SnapshotObjects.open(root);
    const catalog = new SnapshotCatalog(root, objects);
    const graph = await objects.put(new Uint8Array([1, 2]));
    const payload = await objects.put(new Uint8Array([3, 4, 5]));
    const rootfs = await objects.put(new Uint8Array([6]));
    const abandoned = await objects.put(new Uint8Array([7]));
    const saved = decodeSnapshotManifest(manifest({
      graph: { bytes: graph.bytes, chunks: [{ index: 0, ...graph }] },
      payloads: { bytes: payload.bytes, chunks: [{ index: 0, ...payload }] },
      rootfs: { origin: "managed", image: { id: "alpine-rootfs", version: "2026.10.13" }, rootTreeSha256: HASH, manifest: rootfs },
    }));
    await catalog.commit(saved);
    await catalog.rename(saved.id, "Still running");
    await catalog.collect([]);
    expect(await catalog.load(saved.id)).toEqual({ ...saved, label: "Still running" });
    for (const ref of [graph, payload, rootfs]) expect(await objects.size(ref.sha256)).toBe(ref.bytes);
    expect(await objects.size(abandoned.sha256)).toBeUndefined();
    await catalog.delete(saved.id);
    await catalog.collect([]);
    expect(await objects.names()).toEqual([]);
  });

  it("retains runtime identity through listing and refuses cross-runtime resume", () => {
    const saved = decodeSnapshotManifest(manifest());
    const context = { machine: { mode: "userspace", memoryMiB: 256, vcpus: 1 } as const, image: { id: "alpine-rootfs" }, cachedImages: new Set([HASH]) };
    expect(compatibility(saved, context)).toBe(true);
    expect(compatibility(saved, { ...context, machine: { memoryMiB: 256, vcpus: 1 } })).toBe("runtime-mismatch");
    expect(compatibility(saved, { ...context, cachedImages: new Set() })).toBe("base-missing");
    const listed = describeSnapshots([{ id: saved.id, manifest: saved }], context)[0];
    expect(listed).toMatchObject({ mode: "userspace", resumable: true, bytes: { ram: MIB + 1 } });
    expect(decodeSnapshotInfo(listed)).toEqual(listed);
    expect(decodeSnapshotInfo({ ...listed, mode: undefined })).toMatchObject({ mode: "system" });
  });
  it("retains automatic and safety history independently for each runtime", () => {
    const points: RetentionCandidate[] = [];
    for (const mode of ["system", "userspace"] as const) {
      points.push({ id: `${mode}-auto`, mode, kind: "automatic", capturedAtUnixMs: 10 });
      for (let index = 0; index < 4; index++) points.push({ id: `${mode}-${String(index)}`, mode, kind: "safety", capturedAtUnixMs: 20 + index });
    }
    const kept = retainedSnapshots(points, 100, () => 0);
    expect([...kept].sort()).toEqual(["system-1", "system-2", "system-3", "system-auto", "userspace-1", "userspace-2", "userspace-3", "userspace-auto"]);
  });

  it("round-trips opaque native graph/payload streams without a second page identity table", () => {
    const decoded = decodeSnapshotManifest(manifest());
    expect(decoded).toEqual(manifest());
    const bytes = encodeSnapshotManifest(decoded);
    const reparsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    expect(decodeSnapshotManifest(reparsed)).toEqual(decoded);
    expect(bytes.byteLength).toBeLessThan(2048);
    expect(manifestObjects(decoded)).toContainEqual({ sha256: OTHER, bytes: 99 });
  });
  it("requires complete ordered streams, bounded shape and the correct runtime discriminator", () => {
    for (const invalid of [
      { mode: "system" }, { ram: [] }, { compatibility: { format: "OXUC", version: 1, abiVersion: 36, memoryBytes: 3 * 1024 ** 3 + MIB } },
      { payloads: { bytes: MIB + 1, chunks: [{ index: 1, sha256: OTHER, bytes: 1 }] } },
      { payloads: { bytes: MIB + 1, chunks: [{ index: 0, sha256: HASH, bytes: MIB }, { index: 0, sha256: OTHER, bytes: 1 }] } },
      { graph: { bytes: 0, chunks: [] } },
      { rootfs: { origin: "managed", image: { id: "alpine", version: "v1" }, rootTreeSha256: "bad", manifest: { sha256: OTHER, bytes: 99 } } },
    ]) expect(() => decodeSnapshotManifest(manifest(invalid))).toThrow();
    expect(decodeSnapshotManifest(manifest({ payloads: { bytes: 0, chunks: [] } }))).toMatchObject({ schema: 4 });
  });
  it("keeps host attachments and portable native durable streams in the same object closure", () => {
    const attachment = { sha256: "c".repeat(64), bytes: 200 };
    const appData = { sha256: "d".repeat(64), bytes: 20 };
    const root = { bytes: 30, chunks: [{ index: 0, sha256: "e".repeat(64), bytes: 30 }] };
    const decoded = decodeSnapshotManifest(manifest({ host: { attachment, appData }, durable: { root } }));
    expect(manifestObjects(decoded)).toEqual(expect.arrayContaining([attachment, appData, root.chunks[0]]));
    expect(() => decodeSnapshotManifest(manifest({ host: { appData: { ...appData, bytes: MIB + 1 } } }))).toThrow();
  });
  it("retains workspace base and dependency inputs for portable durable-file admission", () => {
    const stream = { bytes: 30, chunks: [{ index: 0, sha256: "e".repeat(64), bytes: 30 }] };
    const workspace = { baseSha256: HASH, snapshot: stream, delta: { bytes: 0, chunks: [] },
      dependencies: { inputsSha256: OTHER, tree: stream } };
    const decoded = decodeSnapshotManifest(manifest({ durable: { workspace } }));
    expect(decoded).toMatchObject({ durable: { workspace } });
    expect(() => decodeSnapshotManifest(manifest({ durable: { workspace: { ...workspace, baseSha256: undefined } } }))).toThrow();
  });
  it("archives the pinned managed manifest while the immutable rootfs base remains external", () => {
    // Distinct digests must describe exactly one object size.
    const decoded = decodeSnapshotManifest(manifest({
      graph: { bytes: 10, chunks: [{ index: 0, sha256: "1".repeat(64), bytes: 10 }] },
      payloads: { bytes: 0, chunks: [] },
    }));
    expect(backupObjectsOf(decoded)).toContainEqual({ sha256: OTHER, bytes: 99 });
    const bytes = encodeBackupManifest(decoded);
    expect(decodeBackupManifest(bytes, Date.parse("2026-10-13T12:00:00.000Z")).snapshot).toEqual(decoded);
  });
});


function failure(action: () => unknown): VMError {
  try { action(); } catch (error) { if (error instanceof VMError) return error; throw error; }
  throw new Error("Expected a snapshot refusal");
}
it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])("round-trips native manifest and backup logical version %s", version => {
  const snapshot = decodeSnapshotManifest(manifest({ compatibility: { format: "OXUC", version, abiVersion: 37, memoryBytes: 256 * MIB }, graph: { bytes: 10, chunks: [{ index: 0, sha256: "1".repeat(64), bytes: 10 }] }, payloads: { bytes: 0, chunks: [] } }));
  expect(snapshot).toMatchObject({ compatibility: { version } });
  expect(decodeBackupManifest(encodeBackupManifest(snapshot), Date.parse("2026-10-13T12:00:00.000Z")).snapshot).toEqual(snapshot);
});
it.each([[0, "older"], [NATIVE_LOGICAL_CHECKPOINT_VERSION + 1, "newer"]] as const)("classifies native logical version %s before strict future fields", (version, reason) => {
  const raw = manifest({ compatibility: { format: "OXUC", version, abiVersion: 36, memoryBytes: 256 * MIB, futureField: true }, futureField: true });
  expect(failure(() => decodeSnapshotManifest(raw))).toMatchObject({ code: "SNAPSHOT_VERSION", detail: { reason: `snapshot-${reason}-format` } });
  const backup = new TextEncoder().encode(JSON.stringify({ format: "oxidevm-backup", formatVersion: 1, snapshot: raw }));
  expect(failure(() => decodeBackupManifest(backup, Date.parse("2026-10-13T12:00:00.000Z")))).toMatchObject({ code: "SNAPSHOT_VERSION", detail: { reason: `backup-${reason}` } });
});
it("refuses a schema 3 Userspace manifest as an older format in every decoder", () => {
  const legacy = manifest({ schema: 3 });
  expect(failure(() => decodeSnapshotManifest(legacy))).toMatchObject({ code: "SNAPSHOT_VERSION", detail: { reason: "snapshot-older-format" } });
  expect(failure(() => decodeUserspaceManifest(legacy))).toMatchObject({ code: "SNAPSHOT_VERSION", detail: { reason: "snapshot-older-format" } });
  const backup = new TextEncoder().encode(JSON.stringify({ format: "oxidevm-backup", formatVersion: 1, snapshot: legacy }));
  expect(failure(() => decodeBackupManifest(backup, Date.parse("2026-10-13T12:00:00.000Z")))).toMatchObject({ code: "SNAPSHOT_VERSION", detail: { reason: "backup-older" } });
});
it("lists a retained schema 3 Userspace manifest as an older format rather than damaged", async () => {
  const root = new MemoryDirectory(), objects = await SnapshotObjects.open(root), catalog = new SnapshotCatalog(root, objects);
  const current = decodeSnapshotManifest(manifest());
  await catalog.commit(current);
  const bytes = new TextEncoder().encode(JSON.stringify(manifest({ schema: 3 })));
  await writeOpfsFile(await root.getDirectoryHandle("manifests"), `${current.id}.json`, bytes);
  await writeOpfsFile(await root.getDirectoryHandle("commits"), current.id, new TextEncoder().encode(await sha256Hex(bytes)));
  const entries = await catalog.list();
  expect(entries[0]).toMatchObject({ damaged: { code: "SNAPSHOT_VERSION", detail: { reason: "snapshot-older-format" } } });
  const context = { machine: { mode: "userspace", memoryMiB: 256, vcpus: 1 } as const, image: { id: "alpine-rootfs" }, cachedImages: new Set([HASH]) };
  expect(describeSnapshots(entries, context)[0]).toMatchObject({ mode: "userspace", resumable: "older-format" });
});
it("keeps malformed current native versions distinct from unsupported versions and producer ABI", () => {
  for (const version of [undefined, -1, 1.5, "2"]) {
    const raw = manifest({ compatibility: { format: "OXUC", version, abiVersion: 36, memoryBytes: 256 * MIB } });
    expect(failure(() => decodeSnapshotManifest(raw)).code).not.toBe("SNAPSHOT_VERSION");
  }
  expect(decodeSnapshotManifest(manifest({ compatibility: { format: "OXUC", version: 1, abiVersion: 38, memoryBytes: 256 * MIB } }))).toMatchObject({ compatibility: { version: 1, abiVersion: 38 } });
  expect(failure(() => decodeBackupManifest(new Uint8Array([123]), Date.parse("2026-10-13T12:00:00.000Z")))).toMatchObject({ detail: { reason: "backup-wrong-file" } });
});


it.each([[0, "older"], [NATIVE_LOGICAL_CHECKPOINT_VERSION + 1, "newer"]] as const)("lists and inspects retained native format %s as unsupported", async (version, reason) => {
  const root = new MemoryDirectory(), objects = await SnapshotObjects.open(root), catalog = new SnapshotCatalog(root, objects);
  const current = decodeSnapshotManifest(manifest());
  await catalog.commit(current);
  const bytes = new TextEncoder().encode(JSON.stringify(manifest({ compatibility: { format: "OXUC", version, abiVersion: 36, memoryBytes: 256 * MIB } })));
  await writeOpfsFile(await root.getDirectoryHandle("manifests"), `${current.id}.json`, bytes);
  await writeOpfsFile(await root.getDirectoryHandle("commits"), current.id, new TextEncoder().encode(await sha256Hex(bytes)));
  const entries = await catalog.list();
  expect(entries[0]).toMatchObject({ identity: { mode: "userspace", kind: "named" }, damaged: { code: "SNAPSHOT_VERSION", detail: { reason: `snapshot-${reason}-format` } } });
  const context = { machine: { mode: "userspace", memoryMiB: 256, vcpus: 1 } as const, image: { id: "alpine-rootfs" }, cachedImages: new Set([HASH]) };
  expect(describeSnapshots(entries, context)[0]).toMatchObject({ mode: "userspace", resumable: `${reason}-format` });
  await expect(SnapshotCatalog.inspect(root, current.id)).rejects.toMatchObject({ code: "SNAPSHOT_VERSION", detail: { reason: `snapshot-${reason}-format` } });
});
