import { expect, it } from "vitest";
import type { FileDescriptor, LinuxFileStat } from "../../js-process-types.js";
import { LinuxError, descriptor } from "../../runtime/js-process/codec.js";
import { createDirectoryAtomically, syncPath, type AtomicDirectory } from "./directory.js";

const STAT: LinuxFileStat = { device: 0n, inode: 1n, links: 1n, mode: 0o40700, uid: 0, gid: 0, size: 0n, accessedNs: 0n, modifiedNs: 0n, changedNs: 0n };
const O_DIRECTORY = 0o200000;

/** A flat in-memory tree that records every call that matters for crash safety, in order. */
function memoryFs(existing: readonly string[], options: { readonly fsyncFails?: boolean } = {}) {
  const paths = new Set(existing), log: string[] = [], open = new Map<FileDescriptor, string>();
  let next = 3;
  const fs = {
    lstat(path: string) { if (!paths.has(path)) throw new LinuxError(2); return STAT; },
    mkdir(path: string, mode?: number) { paths.add(path); log.push(`mkdir ${path} ${(mode ?? 0).toString(8)}`); },
    rename(from: string, to: string) { paths.delete(from); paths.add(to); log.push(`rename ${from} ${to}`); },
    open(path: string, flags?: number) { const fd = descriptor(next++); open.set(fd, path); log.push(`open ${path} ${flags === O_DIRECTORY ? "dir" : String(flags)}`); return fd; },
    fsync(fd: FileDescriptor) { log.push(`fsync ${open.get(fd) ?? "?"}`); if (options.fsyncFails === true) throw new LinuxError(5); },
    close(fd: FileDescriptor) { log.push(`close ${open.get(fd) ?? "?"}`); open.delete(fd); },
  };
  return { fs, paths, log, open };
}

const spec = (populate: AtomicDirectory["populate"] = () => undefined): AtomicDirectory => ({ destination: "/workspace/data", staging: "/workspace/_oxidevm/data-staging", populate, unique: () => "attempt-1" });

it("builds the directory beside its destination, flushes it, renames it and flushes both parents", async () => {
  const { fs, paths, log } = memoryFs(["/workspace", "/workspace/_oxidevm"]);
  const result = await createDirectoryAtomically(fs, spec(directory => { log.push(`populate ${directory}`); }));
  expect(result).toBe("created");
  expect(log).toEqual([
    "mkdir /workspace/_oxidevm/data-staging 700",
    "populate /workspace/_oxidevm/data-staging",
    "open /workspace/_oxidevm/data-staging dir", "fsync /workspace/_oxidevm/data-staging", "close /workspace/_oxidevm/data-staging",
    "rename /workspace/_oxidevm/data-staging /workspace/data",
    "open /workspace dir", "fsync /workspace", "close /workspace",
    "open /workspace/_oxidevm dir", "fsync /workspace/_oxidevm", "close /workspace/_oxidevm",
  ]);
  expect(paths.has("/workspace/data")).toBe(true);
  expect(paths.has("/workspace/_oxidevm/data-staging")).toBe(false);
});

it("leaves an existing destination untouched", async () => {
  const { fs, log } = memoryFs(["/workspace/data"]);
  let populated = false;
  await expect(createDirectoryAtomically(fs, spec(() => { populated = true; }))).resolves.toBe("existing");
  expect(populated).toBe(false);
  expect(log).toEqual([]);
});

it("keeps an abandoned attempt under a new name instead of reusing or deleting it", async () => {
  const { fs, paths, log } = memoryFs(["/workspace/_oxidevm/data-staging"]);
  await createDirectoryAtomically(fs, spec());
  expect(log.slice(0, 2)).toEqual(["rename /workspace/_oxidevm/data-staging /workspace/_oxidevm/data-staging-failed-attempt-1", "mkdir /workspace/_oxidevm/data-staging 700"]);
  expect(paths.has("/workspace/_oxidevm/data-staging-failed-attempt-1")).toBe(true);
});

it("publishes nothing when populating fails, and awaits an asynchronous populate", async () => {
  const failing = memoryFs([]);
  await expect(createDirectoryAtomically(failing.fs, spec(() => { throw new Error("disk full"); }))).rejects.toThrow("disk full");
  expect(failing.paths.has("/workspace/data")).toBe(false);
  expect(failing.paths.has("/workspace/_oxidevm/data-staging")).toBe(true);
  expect(failing.log.some(line => line.startsWith("rename"))).toBe(false);

  const slow = memoryFs([]);
  await createDirectoryAtomically(slow.fs, spec(async directory => { await Promise.resolve(); slow.log.push(`late ${directory}`); }));
  expect(slow.log.indexOf("late /workspace/_oxidevm/data-staging")).toBeLessThan(slow.log.findIndex(line => line.startsWith("rename")));
});

it("closes the descriptor even when the flush fails, and reports the failure", () => {
  const { fs, open, log } = memoryFs([], { fsyncFails: true });
  expect(() => { syncPath(fs, "/workspace/file"); }).toThrow(LinuxError);
  expect(open.size).toBe(0);
  expect(log).toEqual(["open /workspace/file 0", "fsync /workspace/file", "close /workspace/file"]);
});
