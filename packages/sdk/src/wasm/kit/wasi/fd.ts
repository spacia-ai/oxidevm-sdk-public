import { WASI } from "./errno.js";
import { LINUX } from "./host.js";
import { WasiError, type WasiContext } from "./context.js";
import { RIGHT } from "./rights.js";
import { filetypeOf, writeFilestat } from "./stat.js";

type ImportFunction = (...args: never[]) => number;

/** WASI fdflags ↔ Linux status flags. RSYNC has no separate Linux bit (it is O_SYNC's read half). */
const FDFLAG = { append: 1, dsync: 2, nonblock: 4, rsync: 8, sync: 16 } as const;
export function linuxStatusFlags(fdflags: number): number {
  return ((fdflags & FDFLAG.append) !== 0 ? LINUX.O_APPEND : 0) | ((fdflags & FDFLAG.nonblock) !== 0 ? LINUX.O_NONBLOCK : 0)
    | ((fdflags & FDFLAG.dsync) !== 0 ? LINUX.O_DSYNC : 0) | ((fdflags & (FDFLAG.sync | FDFLAG.rsync)) !== 0 ? LINUX.O_SYNC : 0);
}
function wasiFdflags(linux: number): number {
  return ((linux & LINUX.O_APPEND) !== 0 ? FDFLAG.append : 0) | ((linux & LINUX.O_NONBLOCK) !== 0 ? FDFLAG.nonblock : 0)
    | ((linux & LINUX.O_SYNC) === LINUX.O_SYNC ? FDFLAG.sync : (linux & LINUX.O_DSYNC) !== 0 ? FDFLAG.dsync : 0);
}

/** WASI fstflags: which times to set and whether to use "now". */
const FST = { atim: 1, atimNow: 2, mtim: 4, mtimNow: 8 } as const;
/** The access and modification times a set-times call asks for; INVAL for a time given both explicitly and as now. */
export function timesOf(atim: bigint, mtim: bigint, flags: number): readonly [bigint | "now" | "omit", bigint | "now" | "omit"] {
  if ((flags & ~0xf) !== 0 || ((flags & FST.atim) !== 0 && (flags & FST.atimNow) !== 0) || ((flags & FST.mtim) !== 0 && (flags & FST.mtimNow) !== 0)) throw new WasiError(WASI.inval);
  const pick = (value: bigint, set: number, now: number) => (flags & now) !== 0 ? "now" as const : (flags & set) !== 0 ? value : "omit" as const;
  return [pick(atim, FST.atim, FST.atimNow), pick(mtim, FST.mtim, FST.mtimNow)];
}

const WHENCE = ["start", "current", "end"] as const;

export function descriptorFunctions(context: WasiContext): Readonly<Record<string, ImportFunction>> {
  const { host, table } = context;
  const memory = () => context.memory();
  return {
    fd_close: (fd: number) => context.guarded(() => { table.close(fd); }),
    fd_renumber: (from: number, to: number) => context.guarded(() => { table.renumber(from, to); }),
    fd_seek: (fd: number, offset: bigint, whence: number, out: number) => context.guarded(() => {
      const origin = WHENCE[whence];
      if (origin === undefined) throw new WasiError(WASI.inval);
      const entry = table.require(fd, offset === 0n && origin === "current" ? RIGHT.fdTell : RIGHT.fdSeek);
      if (entry.kind === "stream" && entry.terminal) throw new WasiError(WASI.spipe);
      memory().check(out, 8);
      memory().setU64(out, host.fs.seek(entry.host, BigInt.asIntN(64, offset), origin));
    }),
    fd_tell: (fd: number, out: number) => context.guarded(() => {
      const entry = table.require(fd, RIGHT.fdTell);
      memory().check(out, 8);
      memory().setU64(out, host.fs.seek(entry.host, 0n, "current"));
    }),
    fd_fdstat_get: (fd: number, out: number) => context.guarded(() => {
      const entry = table.get(fd), guest = memory();
      guest.check(out, 24);
      const type = entry.kind === "preopen" ? 3 : filetypeOf(host.fs.fstat(entry.host).mode);
      const flags = entry.kind === "preopen" || host.at === undefined ? 0 : wasiFdflags(context.at.statusFlags(entry.host));
      guest.write(out, new Uint8Array(24));
      guest.write(out, Uint8Array.of(type, 0, flags & 0xff, flags >> 8));
      guest.setU64(out + 8, entry.base); guest.setU64(out + 16, entry.inheriting);
    }),
    fd_fdstat_set_flags: (fd: number, fdflags: number) => context.guarded(() => {
      const entry = table.require(fd, RIGHT.fdFdstatSetFlags);
      // Linux fcntl(F_SETFL) changes only O_APPEND and O_NONBLOCK; the sync flags are fixed at open.
      if ((fdflags & ~(FDFLAG.append | FDFLAG.nonblock)) !== 0) throw new WasiError(WASI.notsup);
      const current = context.at.statusFlags(entry.host);
      context.at.setStatusFlags(entry.host, (current & ~(LINUX.O_APPEND | LINUX.O_NONBLOCK)) | linuxStatusFlags(fdflags));
    }),
    fd_fdstat_set_rights: (fd: number, base: bigint, inheriting: bigint) => context.guarded(() => {
      const entry = table.get(fd);
      // Rights only ever shrink.
      if ((base & ~entry.base) !== 0n || (inheriting & ~entry.inheriting) !== 0n) throw new WasiError(WASI.notcapable);
      entry.base = base; entry.inheriting = inheriting;
    }),
    fd_filestat_get: (fd: number, out: number) => context.guarded(() => {
      const entry = table.require(fd, entry_rights(table.get(fd).kind));
      writeFilestat(memory(), out, host.fs.fstat(entry.host));
    }),
    fd_filestat_set_size: (fd: number, size: bigint) => context.guarded(() => {
      const entry = table.require(fd, RIGHT.fdFilestatSetSize);
      if (size > 0x7fff_ffff_ffff_ffffn) throw new WasiError(WASI.fbig);
      host.fs.ftruncate(entry.host, size);
    }),
    fd_filestat_set_times: (fd: number, atim: bigint, mtim: bigint, flags: number) => context.guarded(() => {
      const entry = table.require(fd, RIGHT.fdFilestatSetTimes);
      const [access, modification] = timesOf(atim, mtim, flags);
      context.at.utimensAt(entry.host, new Uint8Array(), access, modification, LINUX.AT_EMPTY_PATH);
    }),
    fd_sync: (fd: number) => context.guarded(() => { host.fs.fsync(table.require(fd, RIGHT.fdSync).host); }),
    fd_datasync: (fd: number) => context.guarded(() => { context.at.fdatasync(table.require(fd, RIGHT.fdDatasync).host); }),
    // Advice is optional on Linux too, but the engine serves no fadvise: report it as unsupported, never as done.
    fd_advise: (fd: number) => context.guarded(() => { table.require(fd, RIGHT.fdAdvise); throw new WasiError(WASI.notsup); }),
    fd_allocate: (fd: number) => context.guarded(() => { table.require(fd, RIGHT.fdAllocate); throw new WasiError(WASI.notsup); }),
    fd_prestat_get: (fd: number, out: number) => context.guarded(() => {
      const entry = table.get(fd);
      if (entry.kind !== "preopen") throw new WasiError(WASI.badf);
      const guest = memory();
      guest.check(out, 8); guest.setU32(out, 0); guest.setU32(out + 4, entry.name.byteLength);
    }),
    fd_prestat_dir_name: (fd: number, buffer: number, length: number) => context.guarded(() => {
      const entry = table.get(fd);
      if (entry.kind !== "preopen") throw new WasiError(WASI.badf);
      if (length < entry.name.byteLength) throw new WasiError(WASI.nametoolong);
      memory().write(buffer, entry.name);
    }),
  };
}

/** A preopen's own metadata is readable without FD_FILESTAT_GET (wasi-libc stats preopens it was given). */
function entry_rights(kind: string): bigint { return kind === "preopen" ? 0n : RIGHT.fdFilestatGet; }
