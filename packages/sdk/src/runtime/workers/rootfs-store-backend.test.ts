import { expect, it, vi } from "vitest";
import { SpaceReserve } from "./managed-disk-reserve.js";
import { MemoryDirectory, MemoryFile, MemoryQuota } from "./opfs-double.test-support.js";
import { openVerifiedReader, sha256, write } from "./rootfs-store-backend.js";

it("resolves a verification directory once while checking every fresh file body", async () => {
  const root = new MemoryDirectory(), backend = { kind: "opfs", root } as const;
  const bytes = new Uint8Array([1, 2, 3]), digest = await sha256(bytes);
  await write(backend, "blobs", "first", bytes); await write(backend, "blobs", "second", bytes);
  const directories = vi.spyOn(root, "getDirectoryHandle");
  const read = await openVerifiedReader(backend, "blobs");
  expect(await read("first", 3, digest)).toEqual(bytes);
  expect(await read("second", 3, digest)).toEqual(bytes);
  expect(directories).toHaveBeenCalledOnce();
  const file = root.find("userspace-rootfs/blobs/first");
  if (!(file instanceof MemoryFile)) throw new Error("missing fixture body");
  file.setBytes(new Uint8Array([9, 9, 9]));
  expect(await read("first", 3, digest)).toBeUndefined();
  expect(await read("second", 4, digest)).toBeUndefined();
  expect(await read("missing", 3, digest)).toBeUndefined();
});

it("does not create a missing verification directory", async () => {
  const root = new MemoryDirectory();
  const read = await openVerifiedReader({ kind: "opfs", root }, "blobs");
  expect(await read("missing", 1, "a".repeat(64))).toBeUndefined();
  expect(root.find("userspace-rootfs")).toBeUndefined();
});

// A small origin quota (Chromium's in-memory profiles get a fraction of RAM) used to leave the
// 256 MiB disk reserve holding the space the last image packs needed, and a guest read failed with EIO.
it("releases the disk reserve once for an image write the origin refuses for space", async () => {
  const quota = new MemoryQuota(2 * 1024 * 1024), root = new MemoryDirectory("", undefined, quota);
  const reserve = await SpaceReserve.open(root, 1024 * 1024);
  if (reserve === undefined) throw new Error("missing reserve");
  try {
    quota.limit = quota.used + 64 * 1024;
    const bytes = new Uint8Array(128 * 1024).fill(5), digest = await sha256(bytes);
    await expect(write({ kind: "opfs", root }, "packs", "unreserved", bytes)).rejects.toMatchObject({ name: "QuotaExceededError" });
    await write({ kind: "opfs", root, reserve }, "packs", "chunk", bytes);
    expect(await (await openVerifiedReader({ kind: "opfs", root }, "packs"))("chunk", bytes.length, digest)).toEqual(bytes);
    expect(quota.used).toBeLessThan(1024 * 1024);
    // Once released, the reserve is not released again: a second refusal is the origin's real limit.
    quota.limit = quota.used;
    await expect(write({ kind: "opfs", root, reserve }, "packs", "another", bytes)).rejects.toMatchObject({ name: "QuotaExceededError" });
  } finally { reserve.close(); }
});

// Chromium also ends a writable stream's write with AbortError ("Failed to write data to data pipe") at the
// origin's limit; hosted captures saw it at the same usage as QuotaExceededError.
it("treats a write the browser aborts as refused, releasing the reserve once and writing again", async () => {
  const quota = new MemoryQuota(4 * 1024 * 1024), root = new MemoryDirectory("", undefined, quota);
  const reserve = await SpaceReserve.open(root, 1024 * 1024);
  if (reserve === undefined) throw new Error("missing reserve");
  const aborted = Object.assign(await new MemoryFile("aborted").createWritable(), { write: () => Promise.reject(new DOMException("Failed to write data to data pipe", "AbortError")) });
  const opened = vi.spyOn(MemoryFile.prototype, "createWritable").mockResolvedValueOnce(aborted);
  try {
    const bytes = new Uint8Array(4096).fill(9), digest = await sha256(bytes), releasing = vi.spyOn(reserve, "release");
    await write({ kind: "opfs", root, reserve }, "packs", "chunk", bytes);
    expect(releasing).toHaveReturnedWith(true);
    expect(await (await openVerifiedReader({ kind: "opfs", root }, "packs"))("chunk", bytes.length, digest)).toEqual(bytes);
    opened.mockImplementationOnce(() => Promise.reject(new DOMException("Invalid state", "InvalidStateError")));
    await expect(write({ kind: "opfs", root, reserve }, "packs", "other", bytes)).rejects.toMatchObject({ name: "InvalidStateError" });
    expect(releasing).toHaveBeenCalledOnce();
  } finally { opened.mockRestore(); reserve.close(); }
});
