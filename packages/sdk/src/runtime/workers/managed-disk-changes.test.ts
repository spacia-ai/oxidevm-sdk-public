import { describe, expect, it } from "vitest";

import { ManagedDiskChanges } from "./managed-disk-changes.js";
import { MemoryDirectory, MemoryFile } from "./opfs-double.test-support.js";

const MIB = 1024 * 1024;

function bitmap(directory: MemoryDirectory): MemoryFile {
  const file = directory.find("changes.bitmap");
  if (!(file instanceof MemoryFile)) throw new Error("change bitmap is missing");
  return file;
}

describe("managed disk change tracking", () => {
  it("marks every MiB chunk a write touches and persists the bits before returning", async () => {
    const journal: string[] = [];
    const directory = new MemoryDirectory("generation", journal);
    const changes = await ManagedDiskChanges.open(directory, 16, () => []);
    journal.length = 0;

    changes.mark(MIB - 1, 2);

    expect(changes.changedChunks()).toEqual([0, 1]);
    expect([...bitmap(directory).bytes]).toEqual([0b11, 0]);
    expect(journal).toEqual(["changes.bitmap:write", "changes.bitmap:flush"]);
    changes.close();
  });

  it("does no I/O for a chunk that is already marked", async () => {
    const directory = new MemoryDirectory("generation");
    const changes = await ManagedDiskChanges.open(directory, 16, () => []);
    changes.mark(3 * MIB, 10);
    const writes = bitmap(directory).syncWrites;

    changes.mark(3 * MIB + 100, 4096);

    expect(bitmap(directory).syncWrites).toBe(writes);
    changes.close();
  });

  it("keeps its bits across a reopen and clears them on reset", async () => {
    const directory = new MemoryDirectory("generation");
    const first = await ManagedDiskChanges.open(directory, 16, () => []);
    first.mark(9 * MIB, 1);
    first.close();

    const reopened = await ManagedDiskChanges.open(directory, 16, () => [3]);
    expect(reopened.changedChunks()).toEqual([9]);
    reopened.reset();
    reopened.close();

    const cleared = await ManagedDiskChanges.open(directory, 16, () => []);
    expect(cleared.changedChunks()).toEqual([]);
    cleared.close();
  });

  it("starts a missing bitmap from the chunks an existing overlay already changed", async () => {
    const directory = new MemoryDirectory("generation");

    const changes = await ManagedDiskChanges.open(directory, 16, () => [2, 15]);

    expect(changes.changedChunks()).toEqual([2, 15]);
    expect([...bitmap(directory).bytes]).toEqual([0b100, 0b1000_0000]);
    changes.close();
  });

  it("rejects a bitmap made for another disk size", async () => {
    const directory = new MemoryDirectory("generation");
    directory.file("changes.bitmap", true).setBytes(new Uint8Array(3));

    let failure: unknown;
    try {
      await ManagedDiskChanges.open(directory, 16, () => []);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "STORAGE_ERROR" });
  });
});
