import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryDirectory, MemoryFile } from "./opfs-double.test-support.js";
import { SnapshotObjects } from "./snapshot-objects.js";

const BYTES = new Uint8Array([1, 2, 3]);
const SHA256 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";

function stored(root: MemoryDirectory, sha256: string): MemoryFile {
  const file = root.find(`objects/${sha256}`);
  if (!(file instanceof MemoryFile)) throw new Error("object file is missing");
  return file;
}

/** An objects directory that counts the file opens in flight, each taking a moment; `hang` never answers. */
class CountingObjects extends MemoryDirectory {
  open = 0;
  most = 0;
  hang: string | undefined;

  override async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle> {
    this.open += 1;
    this.most = Math.max(this.most, this.open);
    try {
      if (name === this.hang) await new Promise<never>(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await super.getFileHandle(name, options);
    } finally {
      this.open -= 1;
    }
  }
}

/** A store root whose objects directory counts its file opens. */
class CountingRoot extends MemoryDirectory {
  readonly objects = new CountingObjects("objects");

  override async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<FileSystemDirectoryHandle> {
    return name === "objects" ? this.objects : super.getDirectoryHandle(name, options);
  }
}

async function failure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("snapshot objects", () => {
  it("retains verified immutable files within one lease and verifies a later transaction afresh", async () => {
    const root = new MemoryDirectory(), objects = await SnapshotObjects.open(root), ref = await objects.put(BYTES);
    const file = stored(root, ref.sha256), snapshots = vi.spyOn(file, "getFile");
    const lease = await objects.openVerifiedReads([ref, ref], new AbortController().signal);
    expect(await lease.read(ref)).toEqual(BYTES);
    expect(await lease.read(ref)).toEqual(BYTES);
    expect(snapshots).toHaveBeenCalledOnce();
    file.setBytes(Uint8Array.of(9, 9, 9));
    expect(await lease.read(ref)).toEqual(BYTES);
    lease.retire();
    await expect(lease.read(ref)).rejects.toMatchObject({ code: "ABORTED" });
    await expect(objects.openVerifiedReads([ref])).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });
  it("does not admit verified lease work after cancellation", async () => {
    const objects = await SnapshotObjects.open(new MemoryDirectory()), ref = await objects.put(BYTES);
    await expect(objects.openVerifiedReads([ref], AbortSignal.abort())).rejects.toMatchObject({ code: "ABORTED" });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preflights each distinct object with at most eight reads in flight and rechecks corruption", async () => {
    const root = new CountingRoot(), objects = await SnapshotObjects.open(root);
    const refs = [];
    for (let index = 0; index < 17; index++) refs.push(await objects.put(new Uint8Array([index])));
    root.objects.most = 0;
    const reads = vi.spyOn(objects, "read");
    await objects.verify([...refs, ...refs], new AbortController().signal);
    expect(reads).toHaveBeenCalledTimes(17);
    expect(root.objects.most).toBe(8);
    const first = refs[0]; if (first === undefined) throw new Error("missing fixture");
    const file = root.objects.find(first.sha256);
    if (!(file instanceof MemoryFile)) throw new Error("missing object");
    file.setBytes(new Uint8Array([99]));
    await expect(objects.verify([first], new AbortController().signal)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
  });

  it("does not begin preflight reads after cancellation", async () => {
    const objects = await SnapshotObjects.open(new MemoryDirectory()), ref = await objects.put(BYTES);
    const reads = vi.spyOn(objects, "read");
    await expect(objects.verify([ref], AbortSignal.abort())).rejects.toMatchObject({ code: "ABORTED" });
    expect(reads).not.toHaveBeenCalled();
  });

  it("stores content under its SHA-256 and reads it back verified", async () => {
    const root = new MemoryDirectory("snapshots-v2");
    const objects = await SnapshotObjects.open(root);

    const ref = await objects.put(BYTES);

    expect(ref).toEqual({ sha256: SHA256, bytes: 3 });
    expect(await objects.read(ref)).toEqual(BYTES);
  });

  it("keeps an existing object of the right size without rewriting it", async () => {
    const root = new MemoryDirectory("snapshots-v2");
    const objects = await SnapshotObjects.open(root);
    await objects.put(BYTES);
    const commits = stored(root, SHA256).commits;

    await objects.put(BYTES);

    expect(stored(root, SHA256).commits).toBe(commits);
  });

  it("rewrites an object whose stored size is wrong", async () => {
    const root = new MemoryDirectory("snapshots-v2");
    const objects = await SnapshotObjects.open(root);
    await objects.put(BYTES);
    stored(root, SHA256).setBytes(new Uint8Array([1, 2]));

    await objects.put(BYTES);

    expect(stored(root, SHA256).bytes).toEqual(BYTES);
  });

  it("rejects an object whose bytes no longer match their hash", async () => {
    const root = new MemoryDirectory("snapshots-v2");
    const objects = await SnapshotObjects.open(root);
    const ref = await objects.put(BYTES);
    stored(root, SHA256).setBytes(new Uint8Array([9, 9, 9]));

    expect(await failure(objects.read(ref))).toMatchObject({ code: "STORAGE_ERROR" });
  });

  it("reports a missing object as not found", async () => {
    const objects = await SnapshotObjects.open(new MemoryDirectory("snapshots-v2"));

    expect(await failure(objects.read({ sha256: SHA256, bytes: 3 }))).toMatchObject({
      code: "STORAGE_NOT_FOUND",
    });
  });

  it("writes a new object in place through a flushed sync access handle", async () => {
    const journal: string[] = [];
    const root = new MemoryDirectory("snapshots-v2", journal);
    const objects = await SnapshotObjects.open(root);

    await objects.put(BYTES);

    expect(stored(root, SHA256).commits).toBe(0);
    expect(journal).toEqual([`${SHA256}:write`, `${SHA256}:flush`]);
  });

  it("continues positive partial writes at their exact offsets and flushes once", async () => {
    const journal: string[] = [];
    const root = new MemoryDirectory("snapshots-v2", journal);
    const file = root.directory("objects", true).file(SHA256, true);
    const open = file.createSyncAccessHandle.bind(file);
    const offsets: number[] = [];
    vi.spyOn(file, "createSyncAccessHandle").mockImplementation(async () => {
      const handle = await open();
      const write = handle.write.bind(handle);
      vi.spyOn(handle, "write").mockImplementation((buffer, options) => {
        if (!(buffer instanceof Uint8Array)) throw new Error("Expected byte view");
        offsets.push(options?.at ?? -1);
        return write(buffer.subarray(0, 1), options);
      });
      return handle;
    });
    const objects = await SnapshotObjects.open(root);

    const ref = await objects.put(BYTES);

    expect(offsets).toEqual([0, 1, 2]);
    expect(await objects.read(ref)).toEqual(BYTES);
    expect(journal.filter(entry => entry.endsWith(":flush"))).toHaveLength(1);
  });

  it("closes an unverified zero-progress object without flushing and repairs it on retry", async () => {
    const journal: string[] = [];
    const root = new MemoryDirectory("snapshots-v2", journal);
    const file = root.directory("objects", true).file(SHA256, true);
    const open = file.createSyncAccessHandle.bind(file);
    const refused = vi.spyOn(file, "createSyncAccessHandle").mockImplementation(async () => {
      const handle = await open();
      const write = handle.write.bind(handle);
      vi.spyOn(handle, "write").mockImplementation((buffer, options) => {
        if (!(buffer instanceof Uint8Array)) throw new Error("Expected byte view");
        return options?.at === 0 ? write(buffer.subarray(0, 1), options) : 0;
      });
      return handle;
    });
    const objects = await SnapshotObjects.open(root);

    expect(await failure(objects.put(BYTES))).toMatchObject({
      code: "STORAGE_ERROR", detail: { reason: "snapshot-write-progress", offset: 1, actual: 0, expected: 2 },
    });
    expect(file.bytes).toEqual(BYTES.subarray(0, 1));
    expect(journal.filter(entry => entry.endsWith(":flush"))).toHaveLength(0);
    refused.mockRestore();

    expect(await objects.read(await objects.put(BYTES))).toEqual(BYTES);
    expect(journal.filter(entry => entry.endsWith(":flush"))).toHaveLength(1);
  });

  it("preserves a thrown quota error after partial progress without flushing", async () => {
    const journal: string[] = [];
    const root = new MemoryDirectory("snapshots-v2", journal);
    const file = root.directory("objects", true).file(SHA256, true);
    const open = file.createSyncAccessHandle.bind(file);
    const quota = new DOMException("No space", "QuotaExceededError");
    vi.spyOn(file, "createSyncAccessHandle").mockImplementation(async () => {
      const handle = await open();
      const write = handle.write.bind(handle);
      vi.spyOn(handle, "write").mockImplementation((buffer, options) => {
        if (!(buffer instanceof Uint8Array)) throw new Error("Expected byte view");
        if (options?.at !== 0) throw quota;
        return write(buffer.subarray(0, 1), options);
      });
      return handle;
    });

    const objects = await SnapshotObjects.open(root);
    expect(await failure(objects.put(BYTES))).toBe(quota);
    expect(journal.filter(entry => entry.endsWith(":flush"))).toHaveLength(0);
    // The failed handle released its exclusive lock.
    const handle = await open();
    handle.close();
  });

  it("rewrites an existing object of the right size whose bytes do not match, as a crashed write leaves", async () => {
    const root = new MemoryDirectory("snapshots-v2");
    root.directory("objects", true).file(SHA256, true).setBytes(new Uint8Array([9, 9, 9]));
    const objects = await SnapshotObjects.open(root);

    await objects.put(BYTES);

    expect(stored(root, SHA256).bytes).toEqual(BYTES);
  });

  it("does not read back an object it wrote this session", async () => {
    const objects = await SnapshotObjects.open(new MemoryDirectory("snapshots-v2"));
    await objects.put(BYTES);
    const reads = vi.spyOn(File.prototype, "arrayBuffer");

    await objects.put(BYTES.slice());

    expect(reads).not.toHaveBeenCalled();
  });

  it("writes concurrent puts of the same content once", async () => {
    const journal: string[] = [];
    const objects = await SnapshotObjects.open(new MemoryDirectory("snapshots-v2", journal));

    const refs = await Promise.all([objects.put(BYTES), objects.put(BYTES.slice()), objects.put(BYTES.slice())]);

    expect(refs).toEqual(Array.from({ length: 3 }, () => ({ sha256: SHA256, bytes: 3 })));
    expect(journal.filter((entry) => entry.endsWith(":write"))).toHaveLength(1);
  });

  it("opens one object file at a time, as Brave can leave one of several never finishing", async () => {
    const root = new CountingRoot("snapshots-v2");
    const objects = await SnapshotObjects.open(root);

    await Promise.all([1, 2, 3, 4].map((fill) => objects.put(new Uint8Array(16).fill(fill))));

    expect(root.objects.most).toBe(1);
  });

  it("fails an object write that does not finish in time, and lets the next one start", async () => {
    const root = new CountingRoot("snapshots-v2");
    const objects = await SnapshotObjects.open(root, { fileTimeLimitMilliseconds: 20 });
    const stuck = new Uint8Array(16).fill(1);
    root.objects.hang = await sha256(stuck);

    const [refused, next] = await Promise.all([failure(objects.put(stuck)), objects.put(new Uint8Array(16).fill(2))]);

    expect(refused).toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "storage-timeout" } });
    expect(next.bytes).toBe(16);
  });
});

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
