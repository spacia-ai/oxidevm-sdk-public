import { describe, expect, it, vi } from "vitest";

import { ManagedBases } from "./managed-base.js";
import type { ManagedDisk } from "./managed-disk.js";
import { liveGenerationFor, readDiskHead } from "./managed-disk-head.js";
import { pinnedStems } from "./managed-image-pins.js";
import { cachedTestImage, chunkFill, openTestDisk, readChunk, type TestImage } from "./managed-image.test-support.js";
import { MemoryDirectory, MemoryFile } from "./opfs-double.test-support.js";
import { sha256Hex } from "./snapshot-content.js";
import { type SnapshotEnvironment, SnapshotStore, type WorkspaceSource } from "./snapshot-store.js";
import { workspaceSnapshot } from "./workspace-snapshot.test-support.js";

const MIB = 1024 * 1024;
const KERNEL = new Uint8Array([0x4b]);
const CLOCK = {
  now: () => Date.parse("2026-10-02T15:00:00.000Z"),
  startOfDay: (unixMs: number) => unixMs - (unixMs % 86_400_000),
};

function chunk(fill: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(MIB).fill(fill);
}

function id(sequence: number): string {
  return `123e4567-e89b-42d3-a456-42661417400${String(sequence)}`;
}

interface Fixture {
  readonly workspace: MemoryDirectory;
  readonly images: MemoryDirectory;
  readonly disks: MemoryDirectory;
  readonly bases: ManagedBases;
  readonly image: TestImage;
  readonly store: SnapshotStore;
  readonly disk: ManagedDisk;
}

async function fixture(
  fills: readonly number[],
  workspace?: WorkspaceSource,
  environment: Partial<Pick<SnapshotEnvironment, "machine" | "quota">> = {},
): Promise<Fixture> {
  const root = new MemoryDirectory("workspace");
  const images = new MemoryDirectory("managed-images");
  const bases = new ManagedBases();
  const image = await cachedTestImage(images, fills);
  // cachedTestImage pins its image for workspace "test".
  const store = await SnapshotStore.open(root, {
    images,
    bases,
    workspaceId: "test",
    clock: CLOCK,
    machine: { memoryMiB: 16, vcpus: 1 },
    image: () => ({ id: image.ref.id, version: image.ref.version }),
    ...(workspace === undefined ? {} : { workspace }),
    ...environment,
  });
  const disks = root.directory("managed-disks", true);
  // Boots as production does: the head names the live generation.
  const disk = await openTestDisk(disks, images, bases, image, await liveGenerationFor(disks, image.ref));
  await store.rememberBoot({ type: "remember-boot", kernel: KERNEL, managedDisk: true }, disk);
  return { workspace: root, images, disks, bases, image, store, disk };
}

async function capture(store: SnapshotStore, disk: ManagedDisk, sequence: number, label?: string) {
  await store.openCapture({
    type: "open-capture",
    snapshot: { id: id(sequence), createdAt: "2026-10-02T10:00:00.000Z" },
    kind: label === undefined ? "automatic" : "named",
    ...(label === undefined ? {} : { label }),
    memoryBytes: 16 * MIB,
    vcpus: 1,
  }, disk);
  await store.sealCapture({
    type: "seal-capture",
    capturedAtUnixMs: 1_790_000_000_000 + sequence,
    machineRecord: new Uint8Array([0x4f, 0x58, 0x4d, 0x53, 0, 0, 0, 0, 0, 0, 0, 0]),
    ramChunks: [0],
    disk: { kind: "managed", bytes: disk.length, chunks: [] },
  }, disk);
  await store.putCaptureChunk("ram", 0, chunk(5));
  return store.commitCapture();
}

async function restore(
  store: SnapshotStore,
  snapshot: { readonly id: string; readonly createdAt: string },
  live?: ManagedDisk,
): Promise<ManagedDisk> {
  const prepared = await store.prepareRestore(snapshot, true, live);
  expect(prepared.disk.mode).toBe("host");
  const restored = await store.commitRestoreDisk();
  store.completeRestore();
  if (restored === undefined) throw new Error("restore produced no managed disk");
  return restored;
}

function fills(disk: ManagedDisk, count: number): (number | "mixed")[] {
  return Array.from({ length: count }, (_, index) => chunkFill(readChunk(disk, index)).fill);
}

async function failure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("managed disk snapshots", () => {
  it("restores the base by reference, with zero markers and new chunks over it", async () => {
    const { store, disk } = await fixture([1, 2, 0, 0]);
    disk.write(0, chunk(0));
    disk.write(2 * MIB, chunk(3));
    const snapshot = await capture(store, disk, 1);

    const restored = await restore(store, snapshot);

    expect(fills(restored, 4)).toEqual([0, 2, 3, 0]);
    restored.close();
    disk.close();
  });

  it("opens the restored generation when the workspace reopens", async () => {
    const { store, disk, disks, image } = await fixture([1, 1]);
    disk.write(MIB, chunk(4));
    const snapshot = await capture(store, disk, 1);

    const restored = await restore(store, snapshot);

    expect(await readDiskHead(disks)).toMatchObject({ generation: restored.generation, previous: disk.generation });
    expect(await liveGenerationFor(disks, image.ref)).toBe(restored.generation);
    // Booting it again keeps the restored disk and lets the one the restore replaced go.
    expect(await readDiskHead(disks)).toMatchObject({ generation: restored.generation, previous: null });
    restored.close();
    disk.close();
  });

  it("never copies the base into the store or the restored generation", async () => {
    const { store, disk, disks, workspace } = await fixture([1, 2, 2, 2]);
    disk.write(0, chunk(7));
    const snapshot = await capture(store, disk, 1);
    const restored = await restore(store, snapshot);

    const objects = workspace.find("snapshots-v2/objects");
    if (!(objects instanceof MemoryDirectory)) throw new Error("object store is missing");
    for (const fill of [1, 2]) expect(objects.names()).not.toContain(await sha256Hex(chunk(fill)));
    const generation = disks.find(restored.generation);
    if (!(generation instanceof MemoryDirectory)) throw new Error("restored generation is missing");
    // The guest's space reserve (ADR 0014 R13) is storage kept free, not a copy of anything.
    const stored = generation.names().filter((name) => name !== "space.reserve").reduce((total, name) => {
      const file = generation.find(name);
      return total + (file instanceof MemoryFile ? file.size : 0);
    }, 0);
    expect(stored).toBeLessThan(2 * MIB);
    expect(fills(restored, 4)).toEqual([7, 2, 2, 2]);
    restored.close();
    disk.close();
  });

  it("reads only the chunks changed since the last save after a cold restart", async () => {
    const { store, disk, disks, images, bases, image } = await fixture([1, 1, 1, 1]);
    disk.write(2 * MIB, chunk(8));
    await capture(store, disk, 1);
    disk.close();

    const reopened = await openTestDisk(disks, images, bases, image, disk.generation);
    await store.rememberBoot({ type: "remember-boot", kernel: KERNEL, managedDisk: true }, reopened);
    reopened.write(3 * MIB, chunk(9));
    const reads = vi.spyOn(reopened, "readSnapshotChunk");
    const second = await capture(store, reopened, 2);

    expect(reads.mock.calls.map(([index]) => index)).toEqual([3]);
    const restored = await restore(store, second);
    expect(fills(restored, 4)).toEqual([1, 1, 8, 9]);
    restored.close();
    reopened.close();
  });

  it("keeps disk writes made while a save is written out for the next save", async () => {
    const { store, disk } = await fixture([1, 1, 1, 1]);
    disk.write(MIB, chunk(6));
    await store.openCapture({
      type: "open-capture",
      snapshot: { id: id(1), createdAt: "2026-10-02T10:00:00.000Z" },
      kind: "automatic",
      memoryBytes: 16 * MIB,
      vcpus: 1,
    }, disk);
    await store.sealCapture({
      type: "seal-capture",
      capturedAtUnixMs: 1_790_000_000_001,
      machineRecord: new Uint8Array([0x4f, 0x58, 0x4d, 0x53, 0, 0, 0, 0, 0, 0, 0, 0]),
      ramChunks: [0],
      disk: { kind: "managed", bytes: disk.length, chunks: [] },
    }, disk);
    // The guest runs again while the save's RAM is written out, and writes to its disk, also to
    // a chunk the cut already holds.
    disk.write(MIB, chunk(7));
    disk.write(2 * MIB, chunk(8));
    await store.putCaptureChunk("ram", 0, chunk(5));
    const first = await store.commitCapture();

    const second = await capture(store, disk, 2);

    expect(fills(await restore(store, first), 4)).toEqual([1, 6, 1, 1]);
    expect(fills(await restore(store, second), 4)).toEqual([1, 7, 8, 1]);
  });

  it("keeps every change for the next save when a save fails after its cut", async () => {
    const { store, disk } = await fixture([1, 1, 1]);
    disk.write(MIB, chunk(6));
    await store.openCapture({
      type: "open-capture",
      snapshot: { id: id(1), createdAt: "2026-10-02T10:00:00.000Z" },
      kind: "automatic",
      memoryBytes: 16 * MIB,
      vcpus: 1,
    }, disk);
    await store.sealCapture({
      type: "seal-capture",
      capturedAtUnixMs: 1_790_000_000_001,
      machineRecord: new Uint8Array([0x4f, 0x58, 0x4d, 0x53, 0, 0, 0, 0, 0, 0, 0, 0]),
      ramChunks: [0],
      disk: { kind: "managed", bytes: disk.length, chunks: [] },
    }, disk);
    disk.write(2 * MIB, chunk(8));
    await store.abort();

    const second = await capture(store, disk, 2);

    expect(fills(await restore(store, second), 3)).toEqual([1, 6, 8]);
  });

  it("reads the whole overlay when the change base snapshot is gone", async () => {
    const { store, disk, workspace } = await fixture([1, 1, 1]);
    disk.write(MIB, chunk(6));
    const first = await capture(store, disk, 1);
    const commits = workspace.find("snapshots-v2/commits");
    if (!(commits instanceof MemoryDirectory)) throw new Error("commit markers are missing");
    await commits.removeEntry(first.id);
    // A reload boots again, so the store no longer holds the first save in memory.
    await store.rememberBoot({ type: "remember-boot", kernel: KERNEL, managedDisk: true }, disk);
    disk.write(2 * MIB, chunk(7));
    const reads = vi.spyOn(disk, "readSnapshotChunk");

    const second = await capture(store, disk, 2);

    expect(reads.mock.calls.map(([index]) => index)).toEqual([1, 2]);
    const restored = await restore(store, second);
    expect(fills(restored, 3)).toEqual([1, 6, 7]);
    restored.close();
    disk.close();
  });

  it("keeps the pre-resume generation through automatic saves, until a named save releases it", async () => {
    const { store, disk, disks } = await fixture([1, 1]);
    const snapshot = await capture(store, disk, 1);
    const restored = await restore(store, snapshot);
    expect((await readDiskHead(disks))?.previous).toBe(disk.generation);

    await store.rememberBoot({ type: "remember-boot", kernel: KERNEL, managedDisk: true }, restored);
    await capture(store, restored, 2);
    expect(await readDiskHead(disks)).toMatchObject({ generation: restored.generation, previous: disk.generation, resume: id(2) });

    await capture(store, restored, 3, "Before upgrading Next");
    expect(await readDiskHead(disks)).toMatchObject({ generation: restored.generation, previous: null, resume: id(3) });
    restored.close();
    disk.close();
  });

  it("refuses a managed restore whose base image is not cached", async () => {
    const { store, disk, images, image } = await fixture([1, 1]);
    const snapshot = await capture(store, disk, 1);
    await images.removeEntry(`${image.stem}.image.json`);

    expect(await failure(store.prepareRestore(snapshot, true, disk))).toMatchObject({
      code: "STORAGE_NOT_FOUND",
      detail: { reason: "base-missing" },
    });
    disk.close();
  });

  it("refuses a managed restore whose image base never finished downloading", async () => {
    const { store, disk, images, image } = await fixture([1]);
    const snapshot = await capture(store, disk, 1);
    disk.close();
    await images.removeEntry(`${image.stem}.complete`);

    expect(await failure(store.prepareRestore(snapshot, true, undefined))).toMatchObject({
      code: "STORAGE_NOT_FOUND",
      detail: { reason: "base-missing" },
    });
    expect((await store.list()).map((info) => info.resumable)).toEqual(["base-missing"]);
  });

  it("removes the pre-resume generation once a named save releases it, not before", async () => {
    const { store, disk, disks } = await fixture([1, 1]);
    const snapshot = await capture(store, disk, 1);
    const restored = await restore(store, snapshot);
    // The storage worker closes the replaced disk once the restored one commits.
    disk.close();
    await store.rememberBoot({ type: "remember-boot", kernel: KERNEL, managedDisk: true }, restored);
    await capture(store, restored, 2);
    await store.maintain();
    expect(disks.names()).toContain(disk.generation);

    await capture(store, restored, 3, "Named");
    await store.maintain();

    expect(disks.names()).toEqual([restored.generation, "head.json"]);
    expect(fills(restored, 2)).toEqual([1, 1]);
    restored.close();
  });

  it("pins only the images its restore points and disk generations still need", async () => {
    const { store, disk, images, image } = await fixture([1, 1]);
    const older = await cachedTestImage(images, [2, 2], "2026.10.01");
    expect(await pinnedStems(images)).toEqual(new Set([image.stem, older.stem]));
    await capture(store, disk, 1);

    await store.maintain();

    expect(await pinnedStems(images)).toEqual(new Set([image.stem]));
    disk.close();
  });
});

describe("restore point catalogue", () => {
  it("lists what each restore point holds and whether it can resume this VM", async () => {
    const { store, disk, image } = await fixture([1, 1]);
    disk.write(0, chunk(4));
    const automatic = await capture(store, disk, 1);
    const named = await capture(store, disk, 2, "bun dev · 14:32");

    const infos = await store.list();

    expect(infos.map((info) => info.ref)).toEqual([named, automatic]);
    expect(infos[0]).toMatchObject({
      kind: "named",
      label: "bun dev · 14:32",
      capturedAtUnixMs: 1_790_000_000_002,
      profile: { id: image.ref.id, version: image.ref.version },
      bytes: { ram: MIB, disk: MIB },
      resumable: true,
    });
    disk.close();
  });

  it("tells a restore point of another machine shape from one this VM can resume", async () => {
    const { store, disk } = await fixture([1], undefined, { machine: { memoryMiB: 16, vcpus: 2 } });
    await capture(store, disk, 1);

    expect((await store.list()).map((info) => info.resumable)).toEqual(["machine-mismatch"]);
    disk.close();
  });

  it("says a restore point cannot resume once its image's base is gone", async () => {
    const { store, disk, images, image } = await fixture([1]);
    await capture(store, disk, 1);
    disk.close();

    await images.removeEntry(`${image.stem}.pack`);

    expect((await store.list()).map((info) => info.resumable)).toEqual(["base-missing"]);
  });

  it("renames and deletes a restore point named by its reference", async () => {
    const { store, disk } = await fixture([1]);
    const first = await capture(store, disk, 1);
    const second = await capture(store, disk, 2);
    const stale = { ...first, createdAt: "2026-10-01T10:00:00.000Z" };

    await expect(store.rename(first, "Before upgrading Next")).resolves.toMatchObject({ ref: first, label: "Before upgrading Next" });
    await expect(store.rename(stale, "Other")).rejects.toMatchObject({ code: "STORAGE_NOT_FOUND" });
    await expect(store.delete(stale)).rejects.toMatchObject({ code: "STORAGE_NOT_FOUND" });
    await store.delete(first);

    expect((await store.list()).map((info) => info.ref)).toEqual([second]);
    disk.close();
  });

  it("reports what restore points occupy with the browser's estimate", async () => {
    const quota = () => Promise.resolve({ estimate: { usage: 3 * MIB, quota: 100 * MIB }, persisted: false });
    const { store, disk } = await fixture([1], undefined, { quota });
    await capture(store, disk, 1);

    await expect(store.usage()).resolves.toMatchObject({ estimate: { usage: 3 * MIB, quota: 100 * MIB }, persisted: false, reclaimableBytes: 0 });
    const unreported = await fixture([1]);
    await expect(unreported.store.usage()).resolves.toMatchObject({ estimate: null, persisted: null });
    unreported.disk.close();
    disk.close();
  });
});

describe("resuming where the user left off", () => {
  it("offers the save the VM last matched, then the automatic saves before it", async () => {
    const { store, disk } = await fixture([1]);
    const first = await capture(store, disk, 1);
    const named = await capture(store, disk, 2, "Before upgrading Next");
    const latest = await capture(store, disk, 3);

    expect((await store.resumeCandidates()).map((info) => info.ref)).toEqual([latest, first]);
    const restored = await restore(store, named, disk);
    expect((await store.resumeCandidates()).map((info) => info.ref)).toEqual([named, first]);
    restored.close();
  });

  it("resumes nothing once the image boots cold, until the next save", async () => {
    const { store, disk } = await fixture([1]);
    const first = await capture(store, disk, 1);

    await store.rememberBoot({ type: "remember-boot", kernel: KERNEL, managedDisk: true }, disk);
    expect(await store.resumeCandidates()).toEqual([]);
    const second = await capture(store, disk, 2);
    expect((await store.resumeCandidates()).map((info) => info.ref)).toEqual([second, first]);
    disk.close();
  });

  it("tells whether the disk a restore replaces holds files newer than the restore point", async () => {
    const { store, disk } = await fixture([1, 1]);
    const saved = await capture(store, disk, 1);

    expect((await store.prepareRestore(saved, true, disk)).newerFiles).toBe(false);
    await store.abort();
    disk.write(MIB, chunk(9));
    expect((await store.prepareRestore(saved, true, disk)).newerFiles).toBe(true);
    await store.abort();
    disk.close();
  });

  it("finds no newer files on a disk that equals another restore point it keeps", async () => {
    const { store, disk } = await fixture([1, 1]);
    disk.write(MIB, chunk(9));
    const kept = await capture(store, disk, 2);
    disk.write(MIB, chunk(8));
    const later = await capture(store, disk, 3);
    // The disk equals restore point 3, which stays: restoring 2 drops nothing that is not saved.
    expect((await store.prepareRestore(kept, true, disk)).newerFiles).toBe(false);
    await store.abort();
    await store.delete(later);
    expect((await store.prepareRestore(kept, true, disk)).newerFiles).toBe(true);
    await store.abort();
    disk.close();
  });
});

describe("restore point workspace", () => {
  const BASE = "e".repeat(64);
  const appAt = (content: string) => workspaceSnapshot([[1, 0o644, "/workspace/app.ts", new TextEncoder().encode(content)]]);

  it("records the workspace generation the guest matched and plans the store's later changes", async () => {
    let overlay = { generation: 3, snapshot: appAt("before") };
    const { store, disk } = await fixture([1, 2], {
      base: () => BASE,
      read: (base) => Promise.resolve(base === BASE ? overlay : undefined),
    });
    const snapshot = await capture(store, disk, 1);

    await expect(store.planWorkspace(snapshot)).resolves.toEqual({ kind: "in-sync" });
    overlay = { generation: 4, snapshot: appAt("after") };
    const plan = await store.planWorkspace(snapshot);

    expect(plan.kind === "changed" ? plan.changes.map(({ path, current }) => [path, current?.tag]) : plan).toEqual([["/workspace/app.ts", 1]]);
  });

  it("saves without a workspace record when the workspace store cannot be read", async () => {
    const { store, disk } = await fixture([1, 2], {
      base: () => BASE,
      read: () => Promise.reject(new Error("the overlay is unreadable")),
    });

    const snapshot = await capture(store, disk, 1);

    await expect(store.planWorkspace(snapshot)).resolves.toEqual({ kind: "unrecorded" });
  });
});
