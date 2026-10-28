import { expect, it } from "vitest";
import { chmod, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootfsDisk, diskFileMetadata, workspaceIdentityFromDisk, writeDiskMetadata } from "./system-disk.js";
import { runTool } from "./tools.js";
import { hash, hashFile } from "./files.js";
import { userspaceTreeIdentity } from "../runtime/userspace-rootfs.js";

it("derives the existing workspace identity from actual ext4 content rather than an empty tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-ext4-test-"));
  try {
    const root = join(directory, "root"); await mkdir(join(root, "workspace"), { recursive: true });
    await writeFile(join(root, "workspace/note"), "native", { mode: 0o644 });
    await chmod(join(root, "workspace/note"), 0o644);
    const disk = join(directory, "root.ext4");
    await runTool("mke2fs", ["-q", "-t", "ext4", "-b", "4096", "-d", root, disk, "8192"]);
    const expected = await userspaceTreeIdentity([{ path: "workspace/note", type: "file", mode: 0o644, blob: hash("native") }], [{ bytes: 6, sha256: hash("native"), url: new URL("https://fixture.invalid/native") }], 3);
    expect(await workspaceIdentityFromDisk(disk)).toBe(expected.workspaceBaseSha256);
    await expect(workspaceIdentityFromDisk(join(directory, "missing"))).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it("creates byte-identical ext4 disks from independent staging trees with different host timestamps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-ext4-reproduction-"));
  try {
    const hashes: string[] = [];
    for (const run of [1, 2]) {
      const staging = join(directory, String(run)); const root = join(staging, "root");
      await mkdir(join(root, "workspace"), { recursive: true });
      await writeFile(join(root, "workspace/note"), "reproduced\n");
      await utimes(join(root, "workspace/note"), run, run);
      const diskPath = join(staging, "root.ext4");
      await createRootfsDisk({ root, diskPath, staging, sizeMiB: 32, sourceDateEpoch: 1785369600,
        entries: [{ path: "workspace", type: "directory", mode: 0o755, ownership: { uid: 123, gid: 456 } },
          { path: "workspace/note", type: "file", mode: 0o644, ownership: { uid: 123, gid: 456 }, blob: hash("reproduced\n") }] });
      hashes.push(await hashFile(diskPath));
    }
    expect(hashes[1]).toBe(hashes[0]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it.each([0o640, 0o4640])("round-trips guest UID/GID and permissions %o through unprivileged ext4 packing", async mode => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-ext4-owner-"));
  try {
    const root = join(directory, "root"); await mkdir(join(root, "workspace"), { recursive: true });
    await writeFile(join(root, "workspace/note"), "owned");
    const disk = join(directory, "root.ext4");
    await runTool("mke2fs", ["-q", "-t", "ext4", "-b", "4096", "-d", root, disk, "8192"]);
    await writeDiskMetadata(disk, [{ path: "workspace/note", type: "file", blob: hash("owned"), mode, ownership: { uid: 123, gid: 456 } }], directory);
    expect((await diskFileMetadata(disk, ["/workspace/note"], directory)).get("/workspace/note")).toEqual({ mode, ownership: { uid: 123, gid: 456 } });
    await expect(diskFileMetadata(disk, ["/missing"], directory)).rejects.toThrow();
    await expect(diskFileMetadata(disk, ["/workspace/note"], directory, AbortSignal.abort())).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
