import { describe, expect, it, vi } from "vitest";

import { ManagedBases } from "./managed-base.js";
import type { ManagedDisk } from "./managed-disk.js";
import { MemoryDirectory, MemoryFile } from "./opfs-double.test-support.js";
import { sha256Hex } from "./snapshot-content.js";
import { SnapshotStore } from "./snapshot-store.js";

const MIB = 1024 * 1024;
const MINUTE = 60_000;
const KERNEL = new Uint8Array([0x4b]);
const NOW = Date.parse("2026-10-02T15:00:00.000Z");
const NO_DISK = { kind: "none", bytes: 0, chunks: [] } as const;

function chunk(fill: number, bytes = MIB): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes).fill(fill);
}

/** A compact view of a chunk, so a mismatch reports its fill instead of a megabyte diff. */
function fill(bytes: Uint8Array): { readonly length: number; readonly fill: number | "mixed" } {
  const first = bytes[0] ?? 0;
  return { length: bytes.byteLength, fill: bytes.every((byte) => byte === first) ? first : "mixed" };
}

function filled(value: number): { readonly length: number; readonly fill: number } {
  return { length: MIB, fill: value };
}

/** Reads one chunk of the prepared restore's stream. */
async function restored(store: SnapshotStore, area: "ram" | "disk-base" | "disk-overlay", index: number): Promise<Uint8Array> {
  const chunk = store.restoreChunks().find((candidate) => candidate.area === area && candidate.index === index);
  if (chunk === undefined) throw new Error(`${area} chunk ${String(index)} is not restored`);
  return chunk.read();
}

function machineRecord(): Uint8Array<ArrayBuffer> {
  const record = new Uint8Array(16);
  record.set([0x4f, 0x58, 0x4d, 0x53]);
  return record;
}

function ref(id: number): { readonly id: string; readonly createdAt: string } {
  return {
    id: `123e4567-e89b-42d3-a456-42661417400${String(id)}`,
    createdAt: "2026-10-02T10:00:00.000Z",
  };
}

type DiskDescriptor = {
  readonly kind: "none" | "core" | "managed";
  readonly bytes: number;
  readonly chunks: readonly number[];
};

/** A whole capture's fields: what opens it before the cut and what seals it at the cut. */
interface CaptureFields {
  readonly snapshot: { readonly id: string; readonly createdAt: string };
  readonly kind: "automatic" | "named";
  readonly label?: string;
  readonly parentId?: string;
  readonly memoryBytes: number;
  readonly capturedAtUnixMs: number;
  readonly machineRecord: Uint8Array;
  readonly agentState?: Uint8Array;
  readonly appData?: Uint8Array;
  readonly ramChunks: readonly number[];
  readonly disk: DiskDescriptor;
}

function capture(id: number, ramChunks: readonly number[], disk: DiskDescriptor, parentId?: string): CaptureFields {
  return {
    snapshot: ref(id),
    kind: "named",
    capturedAtUnixMs: 1_790_000_000_000,
    machineRecord: machineRecord(),
    memoryBytes: 16 * MIB,
    ramChunks,
    disk,
    ...(parentId === undefined ? {} : { parentId }),
  };
}

/** Opens and at once seals a capture: one without a pre-copy. */
async function begin(store: SnapshotStore, fields: CaptureFields, disk: ManagedDisk | undefined): Promise<void> {
  const { snapshot, kind, label, parentId, memoryBytes, capturedAtUnixMs, machineRecord, agentState, appData, ramChunks } = fields;
  await store.openCapture({
    type: "open-capture",
    snapshot,
    kind,
    memoryBytes,
    vcpus: 1,
    ...(label === undefined ? {} : { label }),
    ...(parentId === undefined ? {} : { parentId }),
  }, disk);
  await store.sealCapture({
    type: "seal-capture",
    capturedAtUnixMs,
    machineRecord,
    ramChunks,
    disk: fields.disk,
    ...(agentState === undefined ? {} : { agentState }),
    ...(appData === undefined ? {} : { appData }),
  }, disk);
}

function environment() {
  return {
    images: new MemoryDirectory("managed-images"),
    bases: new ManagedBases(),
    workspaceId: "test",
    clock: { now: () => NOW, startOfDay: (unixMs: number) => unixMs - (unixMs % 86_400_000) },
    machine: { memoryMiB: 16, vcpus: 1 },
  };
}

function objectNames(workspace: MemoryDirectory): string[] {
  const objects = workspace.find("snapshots-v2/objects");
  return objects instanceof MemoryDirectory ? objects.names() : [];
}

async function bootWithoutDisk(store: SnapshotStore): Promise<void> {
  await store.rememberBoot({ type: "remember-boot", kernel: KERNEL, managedDisk: false }, undefined);
}

async function failure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("snapshot store v2", () => {
  it("restores an explicit zero chunk over a non-zero core base disk", async () => {
    const store = await SnapshotStore.open(new MemoryDirectory("workspace"), environment());
    await store.rememberBoot({ type: "remember-boot", kernel: KERNEL, disk: chunk(7, 2 * MIB), managedDisk: false }, undefined);
    await begin(store, capture(1, [0], { kind: "core", bytes: 2 * MIB, chunks: [0, 1] }), undefined);
    await store.putCaptureChunk("ram", 0, chunk(5));
    await store.putCaptureChunk("disk", 0, chunk(0));
    await store.putCaptureChunk("disk", 1, chunk(9));
    expect(await store.commitCapture()).toEqual(ref(1));

    const prepared = await store.prepareRestore(ref(1), false, undefined);

    expect(prepared.disk).toEqual({ mode: "core", bytes: 2 * MIB, baseChunks: [0, 1], overlayChunks: [0, 1] });
    expect(store.restoreChunks().map((chunk) => [chunk.area, chunk.index])).toEqual([
      ["disk-base", 0],
      ["disk-base", 1],
      ["ram", 0],
      ["disk-overlay", 0],
      ["disk-overlay", 1],
    ]);
    expect(fill(await restored(store, "disk-base", 0))).toEqual(filled(7));
    expect(fill(await restored(store, "disk-overlay", 0))).toEqual(filled(0));
    expect(fill(await restored(store, "disk-overlay", 1))).toEqual(filled(9));
    expect(fill(await restored(store, "ram", 0))).toEqual(filled(5));
  });

  it("keeps the parent's RAM for chunks a later capture does not resend and drops zeroed ones", async () => {
    const store = await SnapshotStore.open(new MemoryDirectory("workspace"), environment());
    await store.rememberBoot({ type: "remember-boot", kernel: KERNEL, managedDisk: false }, undefined);
    await begin(store, capture(1, [0, 1, 2], { kind: "none", bytes: 0, chunks: [] }), undefined);
    await store.putCaptureChunk("ram", 0, chunk(5));
    await store.putCaptureChunk("ram", 1, chunk(6));
    await store.putCaptureChunk("ram", 2, chunk(4));
    await store.commitCapture();
    await begin(store, capture(2, [1, 2], { kind: "none", bytes: 0, chunks: [] }, ref(1).id), undefined);
    await store.putCaptureChunk("ram", 1, chunk(8));
    await store.putCaptureChunk("ram", 2, chunk(0));
    await store.commitCapture();

    const prepared = await store.prepareRestore(ref(2), false, undefined);

    expect(prepared.ramChunks).toEqual([0, 1]);
    expect(fill(await restored(store, "ram", 0))).toEqual(filled(5));
    expect(fill(await restored(store, "ram", 1))).toEqual(filled(8));
  });

  it("rejects a manifest that no longer matches its commit marker", async () => {
    const workspace = new MemoryDirectory("workspace");
    const store = await SnapshotStore.open(workspace, environment());
    await store.rememberBoot({ type: "remember-boot", kernel: KERNEL, managedDisk: false }, undefined);
    await begin(store, capture(1, [], { kind: "none", bytes: 0, chunks: [] }), undefined);
    await store.commitCapture();
    const manifest = workspace.find(`snapshots-v2/manifests/${ref(1).id}.json`);
    if (!(manifest instanceof MemoryFile)) throw new Error("manifest is missing");
    manifest.setBytes(new TextEncoder().encode(new TextDecoder().decode(manifest.bytes).replace('"named"', '"safety"')));

    expect(await failure(store.prepareRestore(ref(1), false, undefined))).toMatchObject({ code: "STORAGE_ERROR" });
  });

  it("drops the development v1 store and its restore generations on first open", async () => {
    const workspace = new MemoryDirectory("workspace");
    workspace.directory("snapshots-v1", true).file("manifest", true);
    const disks = workspace.directory("managed-disks", true);
    disks.directory("generations", true).directory("restored", true);
    disks.file("active", true);
    disks.directory("image-overlay", true);

    await SnapshotStore.open(workspace, environment());

    expect(workspace.names()).toEqual(["managed-disks", "snapshots-v2"]);
    expect(disks.names()).toEqual(["image-overlay"]);
  });

  it("reclaims the objects of a capture that never committed once the store reopens", async () => {
    const workspace = new MemoryDirectory("workspace");
    const store = await SnapshotStore.open(workspace, environment());
    await bootWithoutDisk(store);
    await begin(store, capture(1, [0], NO_DISK), undefined);
    await store.putCaptureChunk("ram", 0, chunk(5));
    const written = await sha256Hex(chunk(5));
    await vi.waitFor(() => expect(objectNames(workspace)).toContain(written));

    // The tab closes mid-capture; the next session finds nothing committed and collects.
    const reopened = await SnapshotStore.open(workspace, environment());
    await reopened.maintain();

    expect(objectNames(workspace)).toEqual([]);
    expect(await reopened.list()).toEqual([]);
  });

  it("keeps every object a committed snapshot needs through a collection", async () => {
    const workspace = new MemoryDirectory("workspace");
    const store = await SnapshotStore.open(workspace, environment());
    await store.rememberBoot({ type: "remember-boot", kernel: KERNEL, disk: chunk(7, 2 * MIB), managedDisk: false }, undefined);
    await begin(store, capture(1, [0], { kind: "core", bytes: 2 * MIB, chunks: [1] }), undefined);
    await store.putCaptureChunk("ram", 0, chunk(5));
    await store.putCaptureChunk("disk", 1, chunk(9));
    await store.commitCapture();

    const reopened = await SnapshotStore.open(workspace, environment());
    await reopened.maintain();
    await reopened.prepareRestore(ref(1), false, undefined);

    expect(fill(await restored(reopened, "ram", 0))).toEqual(filled(5));
    expect(fill(await restored(reopened, "disk-base", 0))).toEqual(filled(7));
    expect(fill(await restored(reopened, "disk-overlay", 1))).toEqual(filled(9));
  });

  it("keeps the boot's kernel and base disk before any snapshot references them", async () => {
    const store = await SnapshotStore.open(new MemoryDirectory("workspace"), environment());
    await store.rememberBoot({ type: "remember-boot", kernel: KERNEL, disk: chunk(7, 2 * MIB), managedDisk: false }, undefined);

    await store.maintain();
    await begin(store, capture(1, [], { kind: "core", bytes: 2 * MIB, chunks: [] }), undefined);
    await store.commitCapture();
    await store.prepareRestore(ref(1), false, undefined);

    expect(fill(await restored(store, "disk-base", 1))).toEqual(filled(7));
  });

  it("keeps a running capture's objects when a collection runs mid-capture", async () => {
    const store = await SnapshotStore.open(new MemoryDirectory("workspace"), environment());
    await bootWithoutDisk(store);
    await begin(store, capture(1, [], NO_DISK), undefined);
    await store.commitCapture();
    await begin(store, capture(2, [1], NO_DISK), undefined);
    await store.putCaptureChunk("ram", 1, chunk(6));

    await store.delete(ref(1));
    await store.commitCapture();
    await store.prepareRestore(ref(2), false, undefined);

    expect(fill(await restored(store, "ram", 1))).toEqual(filled(6));
  });

  it("frees only the objects no other snapshot shares when one is deleted", async () => {
    const workspace = new MemoryDirectory("workspace");
    const store = await SnapshotStore.open(workspace, environment());
    await bootWithoutDisk(store);
    await begin(store, capture(1, [0, 1], NO_DISK), undefined);
    await store.putCaptureChunk("ram", 0, chunk(5));
    await store.putCaptureChunk("ram", 1, chunk(6));
    await store.commitCapture();
    await begin(store, capture(2, [1], NO_DISK, ref(1).id), undefined);
    await store.putCaptureChunk("ram", 1, chunk(8));
    await store.commitCapture();

    await store.delete(ref(1));

    const stored = objectNames(workspace);
    expect(stored).toContain(await sha256Hex(chunk(5)));
    expect(stored).not.toContain(await sha256Hex(chunk(6)));
    expect(stored).toContain(await sha256Hex(chunk(8)));
    expect((await store.list()).map((info) => info.ref.id)).toEqual([ref(2).id]);
    expect(await failure(store.prepareRestore(ref(1), false, undefined))).toMatchObject({ code: "STORAGE_NOT_FOUND" });
  });

  it("reports referenced bytes and the bytes a collection would free", async () => {
    const workspace = new MemoryDirectory("workspace");
    const store = await SnapshotStore.open(workspace, environment());
    await bootWithoutDisk(store);
    await begin(store, capture(1, [0], NO_DISK), undefined);
    await store.putCaptureChunk("ram", 0, chunk(5));
    await store.commitCapture();
    await begin(store, capture(2, [1], NO_DISK), undefined);
    await store.putCaptureChunk("ram", 1, chunk(6));
    const written = await sha256Hex(chunk(6));
    await vi.waitFor(() => expect(objectNames(workspace)).toContain(written));

    const reopened = await SnapshotStore.open(workspace, environment());

    expect(await reopened.usage()).toEqual({ referencedBytes: MIB + 16 + 1, reclaimableBytes: MIB, estimate: null, persisted: null });
    await reopened.maintain();
    expect(await reopened.usage()).toEqual({ referencedBytes: MIB + 16 + 1, reclaimableBytes: 0, estimate: null, persisted: null });
  });

  it("thins automatic saves on maintenance and never removes named ones", async () => {
    const store = await SnapshotStore.open(new MemoryDirectory("workspace"), environment());
    await bootWithoutDisk(store);
    const saves = [
      { sequence: 1, kind: "automatic", minutesAgo: 2 },
      { sequence: 2, kind: "automatic", minutesAgo: 3 },
      { sequence: 3, kind: "automatic", minutesAgo: 16 },
      { sequence: 4, kind: "named", minutesAgo: 400 },
      { sequence: 5, kind: "automatic", minutesAgo: 410 },
    ] as const;
    for (const save of saves) {
      await begin(store, {
        ...capture(save.sequence, [], NO_DISK),
        kind: save.kind,
        capturedAtUnixMs: NOW - save.minutesAgo * MINUTE,
      }, undefined);
      await store.commitCapture();
    }

    await store.maintain();

    expect((await store.list()).map((info) => info.ref.id)).toEqual([ref(1).id, ref(3).id, ref(4).id, ref(5).id]);
  });

  it("renames a restore point without breaking its commit marker", async () => {
    const store = await SnapshotStore.open(new MemoryDirectory("workspace"), environment());
    await bootWithoutDisk(store);
    await begin(store, capture(1, [], NO_DISK), undefined);
    await store.commitCapture();

    await store.rename(ref(1), "Before upgrading Next");

    expect(await store.list()).toMatchObject([{ ref: ref(1), label: "Before upgrading Next" }]);
    expect(await store.prepareRestore(ref(1), false, undefined)).toMatchObject({ snapshot: ref(1) });
  });

  it("continues an incremental capture after its parent restore point is deleted", async () => {
    const store = await SnapshotStore.open(new MemoryDirectory("workspace"), environment());
    await bootWithoutDisk(store);
    await begin(store, capture(1, [0, 1], NO_DISK), undefined);
    await store.putCaptureChunk("ram", 0, chunk(5));
    await store.putCaptureChunk("ram", 1, chunk(6));
    await store.commitCapture();

    await store.delete(ref(1));
    await begin(store, capture(2, [1], NO_DISK, ref(1).id), undefined);
    await store.putCaptureChunk("ram", 1, chunk(8));
    await store.commitCapture();
    await store.prepareRestore(ref(2), false, undefined);

    expect(fill(await restored(store, "ram", 0))).toEqual(filled(5));
    expect(fill(await restored(store, "ram", 1))).toEqual(filled(8));
  });

  it("continues incrementally from a restored point deleted after the restore", async () => {
    const store = await SnapshotStore.open(new MemoryDirectory("workspace"), environment());
    await bootWithoutDisk(store);
    await begin(store, capture(1, [0], NO_DISK), undefined);
    await store.putCaptureChunk("ram", 0, chunk(5));
    await store.commitCapture();
    await store.prepareRestore(ref(1), false, undefined);
    await store.commitRestoreDisk();
    store.completeRestore();

    await store.delete(ref(1));
    await begin(store, capture(2, [], NO_DISK, ref(1).id), undefined);
    await store.commitCapture();
    await store.prepareRestore(ref(2), false, undefined);

    expect(fill(await restored(store, "ram", 0))).toEqual(filled(5));
  });

  it("fails a restore chunk whose stored object no longer matches its hash", async () => {
    const workspace = new MemoryDirectory("workspace");
    const store = await SnapshotStore.open(workspace, environment());
    await bootWithoutDisk(store);
    await begin(store, capture(1, [0], NO_DISK), undefined);
    await store.putCaptureChunk("ram", 0, chunk(5));
    await store.commitCapture();
    await store.prepareRestore(ref(1), false, undefined);
    const object = workspace.find(`snapshots-v2/objects/${await sha256Hex(chunk(5))}`);
    if (!(object instanceof MemoryFile)) throw new Error("RAM object is missing");
    object.setBytes(chunk(6));

    expect(await failure(restored(store, "ram", 0))).toMatchObject({
      code: "STORAGE_ERROR",
      detail: { reason: "snapshot-damaged" },
    });
  });

  it("commits every chunk whose write was still in flight when the commit was asked for", async () => {
    const store = await SnapshotStore.open(new MemoryDirectory("workspace"), environment());
    await bootWithoutDisk(store);
    await begin(store, capture(1, [0, 1, 2, 3, 4, 5], NO_DISK), undefined);
    for (const index of [0, 1, 2, 3, 4, 5]) await store.putCaptureChunk("ram", index, chunk(index + 1));

    await store.commitCapture();
    await store.prepareRestore(ref(1), false, undefined);

    for (const index of [0, 1, 2, 3, 4, 5]) {
      expect(fill(await restored(store, "ram", index))).toEqual(filled(index + 1));
    }
  });

  it("keeps a running capture's in-flight writes through a collection", async () => {
    const store = await SnapshotStore.open(new MemoryDirectory("workspace"), environment());
    await bootWithoutDisk(store);
    await begin(store, capture(1, [], NO_DISK), undefined);
    await store.commitCapture();
    await begin(store, capture(2, [0, 1, 2, 3], NO_DISK), undefined);
    for (const index of [0, 1, 2, 3]) await store.putCaptureChunk("ram", index, chunk(index + 1));

    await store.delete(ref(1));
    await store.commitCapture();
    await store.prepareRestore(ref(2), false, undefined);

    for (const index of [0, 1, 2, 3]) {
      expect(fill(await restored(store, "ram", index))).toEqual(filled(index + 1));
    }
  });

  it("keeps RAM sent before the seal unless a chunk is resent after it", async () => {
    const store = await SnapshotStore.open(new MemoryDirectory("workspace"), environment());
    await bootWithoutDisk(store);
    await store.openCapture({ type: "open-capture", snapshot: ref(1), kind: "automatic", memoryBytes: 16 * MIB, vcpus: 1 }, undefined);
    await store.putCaptureChunk("ram", 0, chunk(1));
    await store.putCaptureChunk("ram", 1, chunk(2));
    await store.putCaptureChunk("ram", 2, chunk(3));

    await store.sealCapture({
      type: "seal-capture",
      capturedAtUnixMs: 1_790_000_000_000,
      machineRecord: machineRecord(),
      ramChunks: [1, 2],
      disk: NO_DISK,
    }, undefined);
    await store.putCaptureChunk("ram", 1, chunk(5));
    await store.putCaptureChunk("ram", 2, chunk(0));
    await store.commitCapture();
    const prepared = await store.prepareRestore(ref(1), false, undefined);

    expect(prepared.ramChunks).toEqual([0, 1]);
    expect(fill(await restored(store, "ram", 0))).toEqual(filled(1));
    expect(fill(await restored(store, "ram", 1))).toEqual(filled(5));
  });

  it("keeps the later copy of a RAM chunk resent while the earlier one is still being written", async () => {
    const store = await SnapshotStore.open(new MemoryDirectory("workspace"), environment());
    await bootWithoutDisk(store);
    await store.openCapture({ type: "open-capture", snapshot: ref(1), kind: "automatic", memoryBytes: 16 * MIB, vcpus: 1 }, undefined);

    await store.putCaptureChunk("ram", 1, chunk(2));
    await store.putCaptureChunk("ram", 1, chunk(0));
    await store.putCaptureChunk("ram", 2, chunk(3));
    await store.putCaptureChunk("ram", 2, chunk(4));
    await store.sealCapture({
      type: "seal-capture",
      capturedAtUnixMs: 1_790_000_000_000,
      machineRecord: machineRecord(),
      ramChunks: [],
      disk: NO_DISK,
    }, undefined);
    await store.commitCapture();
    const prepared = await store.prepareRestore(ref(1), false, undefined);

    expect(prepared.ramChunks).toEqual([2]);
    expect(fill(await restored(store, "ram", 2))).toEqual(filled(4));
  });

  it("refuses disk chunks before the seal, unlisted chunks after it, and steps out of order", async () => {
    const store = await SnapshotStore.open(new MemoryDirectory("workspace"), environment());
    await store.rememberBoot({ type: "remember-boot", kernel: KERNEL, disk: chunk(0, 2 * MIB), managedDisk: false }, undefined);
    await store.openCapture({ type: "open-capture", snapshot: ref(1), kind: "named", memoryBytes: 16 * MIB, vcpus: 1 }, undefined);

    expect(await failure(store.putCaptureChunk("disk", 0, chunk(4)))).toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(await failure(store.commitCapture())).toMatchObject({ code: "STORAGE_ERROR" });
    await store.sealCapture({
      type: "seal-capture",
      capturedAtUnixMs: 1_790_000_000_000,
      machineRecord: machineRecord(),
      ramChunks: [3],
      disk: { kind: "core", bytes: 2 * MIB, chunks: [1] },
    }, undefined);
    expect(await failure(store.putCaptureChunk("ram", 4, chunk(4)))).toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(await failure(store.sealCapture({
      type: "seal-capture",
      capturedAtUnixMs: 1_790_000_000_000,
      machineRecord: machineRecord(),
      ramChunks: [],
      disk: NO_DISK,
    }, undefined))).toMatchObject({ code: "PROTOCOL_ERROR" });
    await store.putCaptureChunk("ram", 3, chunk(6));
    await store.putCaptureChunk("disk", 1, chunk(7));
    await store.commitCapture();

    expect((await store.list()).map((info) => info.ref.id)).toEqual([ref(1).id]);
  });

  it("keeps the page data with a snapshot and returns it for the restore", async () => {
    const store = await SnapshotStore.open(new MemoryDirectory("workspace"), environment());
    await bootWithoutDisk(store);
    const appData = new TextEncoder().encode('{"tabs":["src/app.ts"]}');
    await begin(store, { ...capture(1, [], NO_DISK), appData }, undefined);
    await store.commitCapture();

    const prepared = await store.prepareRestore(ref(1), false, undefined);

    expect(prepared.appData).toEqual(appData);
  });

  it("keeps the guest-agent session state with a snapshot and returns it for the restore", async () => {
    const store = await SnapshotStore.open(new MemoryDirectory("workspace"), environment());
    await bootWithoutDisk(store);
    const agentState = new TextEncoder().encode("OXHA session state");
    await begin(store, { ...capture(1, [], NO_DISK), agentState }, undefined);
    await store.commitCapture();

    const prepared = await store.prepareRestore(ref(1), false, undefined);

    expect(prepared.agentState).toEqual(agentState);
  });
});
