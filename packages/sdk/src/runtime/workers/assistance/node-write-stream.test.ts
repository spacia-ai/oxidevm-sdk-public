import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createNodeWriteStream } from "./node-write-stream.js";
import { createAsyncContext } from "./async-context.js";

it("streams short writes, append and positional writes through one real file handle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-fs-stream-")), path = join(directory, "trace");
  let closed = 0, synced = 0;
  const create = createNodeWriteStream(async (path, flags, mode) => {
    if (typeof path !== "string" || typeof flags !== "string" || typeof mode !== "number") throw new Error("Invalid open");
    const handle = await open(path, flags, mode);
    return { fd: handle.fd, write: (bytes, offset, length, position) => handle.write(bytes, offset, Math.min(length, 2), position),
      sync: async () => { synced++; await handle.sync(); }, close: async () => { closed++; await handle.close(); } };
  }, createAsyncContext());
  try {
    for (const options of [{ flags: "a", highWaterMark: 2, flush: true }, { flags: "a" }, { flags: "r+", start: 1 }]) {
      const stream = create(path, options), done = new Promise<void>((resolve, reject) => { stream.on("close", () => resolve()); stream.on("error", reject); });
      expect(stream.pending).toBe(true); stream.write("abc"); stream.end("def"); await done;
      expect(stream.bytesWritten).toBe(6); expect(stream.pending).toBe(false); expect(stream.fd).toBeNull();
    }
    expect(await readFile(path, "utf8")).toBe("aabcdefbcdef");
    expect(closed).toBe(3); expect(synced).toBe(1);
    const missing = create(join(directory, "missing", "file"));
    await expect(new Promise<void>((resolve, reject) => { missing.on("close", () => resolve()); missing.on("error", reject); missing.end("data"); })).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(directory, { force: true, recursive: true }); }
});

it("explicitly closes a finished descriptor when automatic closure is disabled", async () => {
  let closed = 0, closeEvents = 0;
  const create = createNodeWriteStream(() => Promise.resolve({ fd: 10, write: (_bytes, _offset, length) => Promise.resolve({ bytesWritten: length }),
    sync: () => Promise.resolve(), close: () => { closed++; return Promise.resolve(); } }), createAsyncContext());
  const stream = create("output", { autoClose: false });
  stream.on("close", () => { closeEvents++; });
  await new Promise<void>((resolve, reject) => { stream.on("error", reject); stream.end("data", () => resolve()); });
  expect(stream.fd).toBe(10); expect(closed).toBe(0);
  stream.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(closed).toBe(1); expect(stream.fd).toBeNull(); expect(closeEvents).toBe(1);
});
