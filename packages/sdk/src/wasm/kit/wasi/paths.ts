import { WASI } from "./errno.js";
import { LINUX } from "./host.js";
import { WasiError, type WasiContext } from "./context.js";
import { linuxStatusFlags, timesOf } from "./fd.js";
import { CONFINED, guestPath, openTarget, withParent } from "./paths-resolve.js";
import { READ_RIGHTS, RIGHT, WRITE_RIGHTS } from "./rights.js";
import { writeFilestat } from "./stat.js";

type ImportFunction = (...args: never[]) => number;
const LOOKUP_SYMLINK_FOLLOW = 1;
const OFLAG = { creat: 1, directory: 2, excl: 4, trunc: 8 } as const;

/** Linux open flags for a WASI path_open: access mode from the rights asked for, as wasmtime decides it. */
export function openFlags(oflags: number, base: bigint, fdflags: number, follow: boolean): number {
  if ((oflags & ~0xf) !== 0 || (fdflags & ~0x1f) !== 0) throw new WasiError(WASI.inval);
  const write = (base & WRITE_RIGHTS) !== 0n, read = (base & READ_RIGHTS) !== 0n || !write;
  if ((oflags & OFLAG.directory) !== 0 && write) throw new WasiError(WASI.isdir);
  const access = read && write ? LINUX.O_RDWR : write ? LINUX.O_WRONLY : LINUX.O_RDONLY;
  return access | LINUX.O_CLOEXEC | linuxStatusFlags(fdflags) | (follow ? 0 : LINUX.O_NOFOLLOW)
    | ((oflags & OFLAG.creat) !== 0 ? LINUX.O_CREAT : 0) | ((oflags & OFLAG.directory) !== 0 ? LINUX.O_DIRECTORY : 0)
    | ((oflags & OFLAG.excl) !== 0 ? LINUX.O_EXCL : 0) | ((oflags & OFLAG.trunc) !== 0 ? LINUX.O_TRUNC : 0);
}

export function pathFunctions(context: WasiContext): Readonly<Record<string, ImportFunction>> {
  const { table } = context;
  const memory = () => context.memory();
  const path = (pointer: number, length: number) => guestPath(memory(), pointer, length);
  return {
    path_open: (fd: number, lookup: number, pointer: number, length: number, oflags: number, base: bigint, inheriting: bigint, fdflags: number, out: number) => context.guarded(() => {
      const needs = RIGHT.pathOpen | ((oflags & OFLAG.creat) !== 0 ? RIGHT.pathCreateFile : 0n) | ((oflags & OFLAG.trunc) !== 0 ? RIGHT.pathFilestatSetSize : 0n);
      const dir = table.require(fd, needs);
      // A child can hold only rights its directory may hand down.
      if ((base & ~dir.inheriting) !== 0n || (inheriting & ~dir.inheriting) !== 0n) throw new WasiError(WASI.notcapable);
      const name = path(pointer, length);
      memory().check(out, 4);
      const flags = openFlags(oflags, base, fdflags, (lookup & LOOKUP_SYMLINK_FOLLOW) !== 0);
      const opened = context.at.openat(dir.host, name, flags, (oflags & OFLAG.creat) !== 0 ? 0o666 : 0, dir.confined ? CONFINED : 0);
      let kind: "file" | "directory";
      try { kind = (context.host.fs.fstat(opened).mode & 0o170000) === 0o040000 ? "directory" : "file"; }
      catch (error) { context.host.fs.close(opened); throw error; }
      const guestFd = table.insert({ kind, host: opened, base, inheriting, owned: true, confined: dir.confined, readOnly: dir.kind !== "stream" && dir.readOnly });
      memory().setU32(out, guestFd);
    }),
    path_create_directory: (fd: number, pointer: number, length: number) => context.guarded(() => {
      const dir = table.require(fd, RIGHT.pathCreateDirectory);
      withParent(context, dir, path(pointer, length), WASI.exist, parent => { context.at.mkdirAt(parent.dir, parent.leaf, 0o777); });
    }),
    path_remove_directory: (fd: number, pointer: number, length: number) => context.guarded(() => {
      const dir = table.require(fd, RIGHT.pathRemoveDirectory);
      withParent(context, dir, path(pointer, length), WASI.inval, parent => { context.at.unlinkAt(parent.dir, parent.leaf, LINUX.AT_REMOVEDIR); });
    }),
    path_unlink_file: (fd: number, pointer: number, length: number) => context.guarded(() => {
      const dir = table.require(fd, RIGHT.pathUnlinkFile);
      withParent(context, dir, path(pointer, length), WASI.isdir, parent => { context.at.unlinkAt(parent.dir, parent.leaf, 0); });
    }),
    path_filestat_get: (fd: number, lookup: number, pointer: number, length: number, out: number) => context.guarded(() => {
      const dir = table.require(fd, RIGHT.pathFilestatGet), name = path(pointer, length);
      memory().check(out, 64);
      const follow = (lookup & LOOKUP_SYMLINK_FOLLOW) !== 0;
      if (!dir.confined) { writeFilestat(memory(), out, context.at.statAt(dir.host, name, follow ? 0 : LINUX.AT_SYMLINK_NOFOLLOW)); return; }
      const target = openTarget(context, dir, name, follow);
      try { writeFilestat(memory(), out, context.at.statAt(target, new Uint8Array(), LINUX.AT_EMPTY_PATH)); }
      finally { context.host.fs.close(target); }
    }),
    path_filestat_set_times: (fd: number, lookup: number, pointer: number, length: number, atim: bigint, mtim: bigint, flags: number) => context.guarded(() => {
      const dir = table.require(fd, RIGHT.pathFilestatSetTimes), name = path(pointer, length);
      const [access, modification] = timesOf(atim, mtim, flags);
      const follow = (lookup & LOOKUP_SYMLINK_FOLLOW) !== 0;
      // Beneath a confined directory a followed link is first checked to stay inside (opened with RESOLVE_BENEATH).
      if (dir.confined && follow) context.host.fs.close(openTarget(context, dir, name, true));
      withParent(context, dir, name, WASI.inval, parent => { context.at.utimensAt(parent.dir, parent.leaf, access, modification, follow ? 0 : LINUX.AT_SYMLINK_NOFOLLOW); });
    }),
    path_readlink: (fd: number, pointer: number, length: number, buffer: number, capacity: number, out: number) => context.guarded(() => {
      const dir = table.require(fd, RIGHT.pathReadlink), name = path(pointer, length);
      memory().check(buffer, capacity); memory().check(out, 4);
      const target = withParent(context, dir, name, WASI.inval, parent => context.at.readlinkAt(parent.dir, parent.leaf));
      // WASI truncates a target longer than the buffer; the caller retries with a larger one.
      const copied = target.subarray(0, capacity);
      memory().write(buffer, copied); memory().setU32(out, copied.byteLength);
    }),
    path_symlink: (oldPointer: number, oldLength: number, fd: number, pointer: number, length: number) => context.guarded(() => {
      const dir = table.require(fd, RIGHT.pathSymlink), target = path(oldPointer, oldLength);
      withParent(context, dir, path(pointer, length), WASI.exist, parent => { context.at.symlinkAt(target, parent.dir, parent.leaf); });
    }),
    path_rename: (fd: number, oldPointer: number, oldLength: number, newFd: number, newPointer: number, newLength: number) => context.guarded(() => {
      const from = table.require(fd, RIGHT.pathRenameSource), to = table.require(newFd, RIGHT.pathRenameTarget);
      const oldName = path(oldPointer, oldLength), newName = path(newPointer, newLength);
      withParent(context, from, oldName, WASI.inval, source => {
        withParent(context, to, newName, WASI.inval, target => { context.at.renameAt(source.dir, source.leaf, target.dir, target.leaf, 0); });
      });
    }),
    path_link: (fd: number, lookup: number, oldPointer: number, oldLength: number, newFd: number, newPointer: number, newLength: number) => context.guarded(() => {
      const from = table.require(fd, RIGHT.pathLinkSource), to = table.require(newFd, RIGHT.pathLinkTarget);
      const oldName = path(oldPointer, oldLength), newName = path(newPointer, newLength);
      const follow = (lookup & LOOKUP_SYMLINK_FOLLOW) !== 0;
      if (from.confined && follow) context.host.fs.close(openTarget(context, from, oldName, true));
      withParent(context, from, oldName, WASI.inval, source => {
        withParent(context, to, newName, WASI.exist, target => { context.at.linkAt(source.dir, source.leaf, target.dir, target.leaf, follow ? LINUX.AT_SYMLINK_FOLLOW : 0); });
      });
    }),
  };
}

