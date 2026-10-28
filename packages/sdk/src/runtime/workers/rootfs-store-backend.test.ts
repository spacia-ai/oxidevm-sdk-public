import { expect, it, vi } from "vitest";
import { MemoryDirectory, MemoryFile } from "./opfs-double.test-support.js";
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
