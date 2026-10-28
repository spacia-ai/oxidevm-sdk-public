import { describe, expect, it } from "vitest";

import { ManagedBases } from "./managed-base.js";
import type { ManagedDisk } from "./managed-disk.js";
import { cachedTestImage, chunkFill, openTestDisk, readChunk } from "./managed-image.test-support.js";
import { MemoryDirectory, MemoryFile, MemoryQuota } from "./opfs-double.test-support.js";

const MIB = 1024 * 1024;
const SNAPSHOT = "123e4567-e89b-42d3-a456-426614174001";

function generationDirectory(disks: MemoryDirectory, name: string): MemoryDirectory {
  const directory = disks.find(name);
  if (!(directory instanceof MemoryDirectory)) throw new Error("generation is missing");
  return directory;
}

async function failure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("managed disk generations", () => {
  it("reads unchanged chunks from the shared base and zeros where the image stores nothing", async () => {
    const images = new MemoryDirectory("managed-images");
    const image = await cachedTestImage(images, [1, 0, 2]);
    const disk = await openTestDisk(new MemoryDirectory("managed-disks"), images, new ManagedBases(), image, "live");

    expect([0, 1, 2].map((index) => chunkFill(readChunk(disk, index)).fill)).toEqual([1, 0, 2]);
    disk.close();
  });

  it("persists a write's change bit before any of its data reaches the overlay", async () => {
    const journal: string[] = [];
    const images = new MemoryDirectory("managed-images");
    const image = await cachedTestImage(images, [1, 1]);
    const disk = await openTestDisk(new MemoryDirectory("managed-disks", journal), images, new ManagedBases(), image, "live");
    journal.length = 0;

    disk.write(MIB + 4096, new Uint8Array(4096).fill(7));

    expect(journal.slice(0, 2)).toEqual(["changes.bitmap:write", "changes.bitmap:flush"]);
    expect(journal.slice(2).some((entry) => entry.startsWith("overlay"))).toBe(true);
    expect(disk.changedChunks()).toEqual([1]);
    disk.close();
  });

  it("keeps its changes across a cold restart and treats an untracked overlay's chunks as changed", async () => {
    const images = new MemoryDirectory("managed-images");
    const disks = new MemoryDirectory("managed-disks");
    const bases = new ManagedBases();
    const image = await cachedTestImage(images, [1, 1, 1, 1]);
    const disk = await openTestDisk(disks, images, bases, image, "live");
    disk.write(2 * MIB, new Uint8Array(MIB).fill(9));
    disk.close();

    const reopened = await openTestDisk(disks, images, bases, image, "live");
    expect(reopened.changedChunks()).toEqual([2]);
    reopened.close();
    // A generation from before change tracking has no bitmap; everything its overlay holds counts.
    await generationDirectory(disks, "live").removeEntry("changes.bitmap");
    const adopted = await openTestDisk(disks, images, bases, image, "live");
    expect(adopted.changedChunks()).toEqual([2]);
    expect(chunkFill(readChunk(adopted, 2)).fill).toBe(9);
    adopted.close();
  });

  it("records a committed snapshot as its change base and clears its changes", async () => {
    const images = new MemoryDirectory("managed-images");
    const disks = new MemoryDirectory("managed-disks");
    const bases = new ManagedBases();
    const image = await cachedTestImage(images, [1, 1]);
    const disk = await openTestDisk(disks, images, bases, image, "live");
    disk.write(0, new Uint8Array(4096).fill(3));

    await disk.commitSnapshot(SNAPSHOT);

    expect(disk.changeBase).toBe(SNAPSHOT);
    expect(disk.changedChunks()).toEqual([]);
    disk.close();
    const reopened = await openTestDisk(disks, images, bases, image, "live");
    expect(reopened.changeBase).toBe(SNAPSHOT);
    expect(reopened.changedChunks()).toEqual([]);
    reopened.close();
  });

  it("refuses to open a generation recorded for another image and releases its base", async () => {
    const images = new MemoryDirectory("managed-images");
    const disks = new MemoryDirectory("managed-disks");
    const bases = new ManagedBases();
    const first = await cachedTestImage(images, [1, 1], "2026.10.01");
    const second = await cachedTestImage(images, [1, 1], "2026.10.02");
    (await openTestDisk(disks, images, bases, first, "live")).close();

    expect(await failure(openTestDisk(disks, images, bases, second, "live"))).toMatchObject({ code: "STORAGE_ERROR" });
    expect(bases.isOpen(second.stem)).toBe(false);
  });
});

describe("managed disk space reserve", () => {
  /** A disk holding a 2 MiB reserve on an origin with 64 KiB left besides it. */
  async function fullOrigin(): Promise<{ readonly disk: ManagedDisk; readonly quota: MemoryQuota; readonly reserve: () => number }> {
    const quota = new MemoryQuota(Number.MAX_SAFE_INTEGER);
    const images = new MemoryDirectory("managed-images");
    const image = await cachedTestImage(images, [1, 1, 1]);
    const disks = new MemoryDirectory("managed-disks", undefined, quota);
    const disk = await openTestDisk(disks, images, new ManagedBases(), image, "live", { reserveBytes: 2 * MIB });
    quota.limit = quota.used + 64 * 1024;
    const reserve = (): number => {
      const file = generationDirectory(disks, "live").find("space.reserve");
      return file instanceof MemoryFile ? file.size : -1;
    };
    return { disk, quota, reserve };
  }

  function thrown(write: () => void): unknown {
    try {
      write();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it("holds space for the guest's writes and gives it to a write the browser refuses for lack of room", async () => {
    const { disk, reserve } = await fullOrigin();
    expect(reserve()).toBe(2 * MIB);

    disk.write(0, new Uint8Array(MIB).fill(7));

    expect(chunkFill(readChunk(disk, 0)).fill).toBe(7);
    expect(reserve()).toBe(0);
    disk.close();
  });

  it("refuses a write once the reserve is spent", async () => {
    const { disk, quota } = await fullOrigin();
    disk.write(0, new Uint8Array(MIB).fill(7));
    quota.limit = quota.used;

    expect(thrown(() => { disk.write(MIB, new Uint8Array(MIB).fill(8)); })).toMatchObject({ name: "QuotaExceededError" });
    disk.close();
  });

  it("takes the reserve back once there is room again", async () => {
    const { disk, quota, reserve } = await fullOrigin();
    disk.write(0, new Uint8Array(MIB).fill(7));
    expect(await disk.holdReserve()).toBe(false);

    quota.limit = Number.MAX_SAFE_INTEGER;

    expect(await disk.holdReserve()).toBe(true);
    expect(reserve()).toBe(2 * MIB);
    disk.close();
  });

  it("gives the reserve back when the disk closes", async () => {
    const { disk, reserve } = await fullOrigin();

    disk.close();

    expect(reserve()).toBe(0);
  });
});
