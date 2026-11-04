import type { FileDescriptor, LinuxAtFiles, LinuxDirent, LinuxFileStat, LinuxNanoTime, LinuxPath, LinuxPollReady, LinuxPollRequest } from "../../js-process-types.js";
import { VMError } from "../errors.js";
import { JS_MAX_IO_BYTES, type LinuxOperation, type LinuxResult, descriptor, noValue, operation, protocol, value, Writer } from "./codec.js";
import { decodeDirents, decodeStat } from "./file-operations.js";
import type { LinuxClient } from "./transport.js";

const BigInt = globalThis.BigInt, DataView = globalThis.DataView, Number = globalThis.Number;

/** AT_FDCWD, as Linux defines it, and as it travels: -100 as an unsigned 64-bit word. */
const AT_FDCWD = -100, AT_FDCWD_WIRE = 0xffff_ffff_ffff_ff9cn;
function isWorkingDirectory(value: number): value is FileDescriptor { return value === AT_FDCWD; }
/** The working directory as a directory descriptor (`host.at.cwd`). */
export const CWD: FileDescriptor = isWorkingDirectory(AT_FDCWD) ? AT_FDCWD : protocol("AT_FDCWD is unavailable");

const UTIME_NOW = 0x3fff_ffffn, UTIME_OMIT = 0x3fff_fffen, NS_PER_SECOND = 1_000_000_000n;
const I64_MIN = -(2n ** 63n), I64_MAX = 2n ** 63n - 1n;
const MAX_POLL_TIMEOUT_MS = 86_400_000;

function invalid(message: string): never { throw new VMError("INVALID_ARGUMENT", message); }
/** A descriptor the caller passes: 0 to 2^31-1, or AT_FDCWD where a directory is taken. */
function fdArgument(fd: number, directory: boolean): bigint {
  if (directory && fd === AT_FDCWD) return AT_FDCWD_WIRE;
  if (!Number.isSafeInteger(fd) || fd < 0 || fd > 0x7fff_ffff) invalid(directory ? "A directory descriptor must be AT_FDCWD or an integer from 0 to 2147483647" : "A Linux file descriptor must be an integer from 0 to 2147483647");
  return BigInt(fd);
}
const dir = (fd: number): bigint => fdArgument(fd, true), fdOf = (fd: number): bigint => fdArgument(fd, false);
/** Flags travel as u64; Rust admits the bits each call accepts and answers EINVAL for the rest. */
function flagsArgument(flags: number, label: string): number {
  if (!Number.isSafeInteger(flags) || flags < 0) invalid(`${label} must be a non-negative integer`);
  return flags;
}
/** A positional offset is an `off_t`: 0 to 2^63-1. */
function offsetArgument(offset: bigint): bigint {
  if (typeof offset !== "bigint" || offset < 0n || offset > I64_MAX) invalid("A file offset must be a bigint from 0 to 2^63-1");
  return offset;
}
function countArgument(count: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(count) || count < minimum || count > maximum) invalid(`${label} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  return count;
}
/** A time as utimensat takes it: seconds (floored, two's complement) and nanoseconds 0..999,999,999, or a UTIME_* word. */
function writeNanoTime(writer: Writer, time: LinuxNanoTime): Writer {
  if (time === "now") return writer.u64(0n).u64(UTIME_NOW);
  if (time === "omit") return writer.u64(0n).u64(UTIME_OMIT);
  if (typeof time !== "bigint") invalid("A Linux time must be nanoseconds as a bigint, \"now\" or \"omit\"");
  const remainder = ((time % NS_PER_SECOND) + NS_PER_SECOND) % NS_PER_SECOND, seconds = (time - remainder) / NS_PER_SECOND;
  if (seconds < I64_MIN || seconds > I64_MAX) invalid("A Linux time must fit signed 64-bit seconds");
  return writer.u64(BigInt.asUintN(64, seconds)).u64(remainder);
}
function decodeTarget(result: LinuxResult): Uint8Array {
  if (result.bytes.byteLength === 0 || result.bytes.byteLength > 4095 || result.value !== BigInt(result.bytes.byteLength)) protocol("Invalid Linux readlinkat result");
  return result.bytes.slice();
}
function decodePoll(entries: readonly LinuxPollRequest[], result: LinuxResult): readonly LinuxPollReady[] {
  if (result.bytes.byteLength !== entries.length * 8) protocol("Invalid Linux timed readiness result");
  const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength), ready: LinuxPollReady[] = [];
  entries.forEach((entry, index) => {
    const offset = index * 8;
    if (view.getInt32(offset, true) !== entry.fd || view.getUint16(offset + 4, true) !== entry.events) protocol("Linux timed readiness descriptor mismatch");
    const revents = view.getUint16(offset + 6, true);
    if (revents !== 0) ready.push({ fd: entry.fd, revents });
  });
  if (result.value !== BigInt(ready.length)) protocol("Invalid Linux timed readiness count");
  return ready;
}

/** The wire operations behind `LinuxAtFiles` (Userspace API 147); each validates its reply exactly. */
export const atFileOperations = {
  /** OXJR 437: dirfd, path, flags, mode, resolve; the reply value is the new descriptor. */
  openat: (at: number, path: LinuxPath, flags: number, mode: number, resolve = 0): LinuxOperation<FileDescriptor> =>
    operation(437, new Writer().u64(dir(at)).path(path).u64(flagsArgument(flags, "openat flags")).u64(flagsArgument(mode, "openat mode")).u64(flagsArgument(resolve, "openat resolve")), result => descriptor(value(result))),
  /** OXJR 262: dirfd, path, flags; the 144-byte stat record of ops 4 and 5. */
  statAt: (at: number, path: LinuxPath, flags = 0): LinuxOperation<LinuxFileStat> =>
    operation(262, new Writer().u64(dir(at)).path(path).u64(flagsArgument(flags, "newfstatat flags")), decodeStat),
  mkdirAt: (at: number, path: LinuxPath, mode: number): LinuxOperation<void> =>
    operation(258, new Writer().u64(dir(at)).path(path).u64(flagsArgument(mode, "mkdirat mode")), noValue),
  unlinkAt: (at: number, path: LinuxPath, flags = 0): LinuxOperation<void> =>
    operation(263, new Writer().u64(dir(at)).path(path).u64(flagsArgument(flags, "unlinkat flags")), noValue),
  renameAt: (fromDir: number, from: LinuxPath, toDir: number, to: LinuxPath, flags = 0): LinuxOperation<void> =>
    operation(316, new Writer().u64(dir(fromDir)).path(from).u64(dir(toDir)).path(to).u64(flagsArgument(flags, "renameat2 flags")), noValue),
  linkAt: (fromDir: number, from: LinuxPath, toDir: number, to: LinuxPath, flags = 0): LinuxOperation<void> =>
    operation(265, new Writer().u64(dir(fromDir)).path(from).u64(dir(toDir)).path(to).u64(flagsArgument(flags, "linkat flags")), noValue),
  /** OXJR 266: target, then the directory and path of the new link. */
  symlinkAt: (target: LinuxPath, at: number, path: LinuxPath): LinuxOperation<void> =>
    operation(266, new Writer().path(target).u64(dir(at)).path(path), noValue),
  readlinkAt: (at: number, path: LinuxPath): LinuxOperation<Uint8Array> => operation(267, new Writer().u64(dir(at)).path(path), decodeTarget),
  /** OXJR 65551: dirfd, path (empty with AT_EMPTY_PATH), access and modification as seconds and nanoseconds, flags. */
  utimensAt: (at: number, path: LinuxPath, access: LinuxNanoTime, modification: LinuxNanoTime, flags = 0): LinuxOperation<void> =>
    operation(65551, writeNanoTime(writeNanoTime(new Writer().u64(dir(at)).path(path), access), modification).u64(flagsArgument(flags, "utimensat flags")), noValue),
  /** OXJR 17: fd, count, offset; the bytes read, never more than asked. */
  pread: (fd: number, count: number, offset: bigint): LinuxOperation<Uint8Array> =>
    operation(17, new Writer().u64(fdOf(fd)).u64(countArgument(count, "A pread count", 0, JS_MAX_IO_BYTES)).u64(offsetArgument(offset)), result => {
      if (result.value !== BigInt(result.bytes.byteLength) || result.bytes.byteLength > count) protocol("Invalid Linux pread result");
      return result.bytes.slice();
    }),
  /** OXJR 18: fd, bytes, offset; how many bytes were written. */
  pwrite: (fd: number, bytes: Uint8Array, offset: bigint): LinuxOperation<number> =>
    operation(18, new Writer().u64(fdOf(fd)).blob(bytes).u64(offsetArgument(offset)), result => { const count = value(result); if (count > bytes.byteLength) protocol("Invalid Linux pwrite result"); return count; }),
  /** OXJR 72 F_GETFL (3). */
  statusFlags: (fd: number): LinuxOperation<number> => operation(72, new Writer().u64(fdOf(fd)).u32(3), result => { const flags = value(result); if (flags > 0xffff_ffff) protocol("Invalid Linux status flags"); return flags; }),
  /** OXJR 72 F_SETFL (4). */
  setStatusFlags: (fd: number, flags: number): LinuxOperation<void> => operation(72, new Writer().u64(fdOf(fd)).u32(4).u64(flagsArgument(flags, "Status flags")), noValue),
  /** OXJR 217: one getdents64 batch of at most `maxBytes`, with each record's inode and d_off cookie. */
  getdents: (fd: number, maxBytes: number): LinuxOperation<readonly LinuxDirent[]> => {
    const limit = countArgument(maxBytes, "A getdents buffer", 1, JS_MAX_IO_BYTES);
    return operation(217, new Writer().u64(fdOf(fd)).u64(limit), result => decodeDirents(result, limit).map(record => ({ name: record.nameBytes, inode: record.inode, type: record.type, next: record.next })));
  },
  /** OXJR 75: fdatasync. */
  fdatasync: (fd: number): LinuxOperation<void> => operation(75, new Writer().u64(fdOf(fd)), noValue),
  /** OXJR 65552: 1 to 16 descriptors with POLLIN/POLLOUT, then the timeout in ms (-1 forever); value 0 is a timeout. */
  poll: (entries: readonly LinuxPollRequest[], timeoutMs: number): LinuxOperation<readonly LinuxPollReady[]> => {
    if (entries.length === 0 || entries.length > 16) invalid("poll takes 1 to 16 descriptors");
    if (timeoutMs !== -1) countArgument(timeoutMs, "A poll timeout", 0, MAX_POLL_TIMEOUT_MS);
    const payload = new Writer().u32(entries.length);
    for (const entry of entries) {
      // The type admits only these; a caller that passes another value anyway is refused before anything is sent.
      const events: unknown = entry.events;
      if (events !== 1 && events !== 4 && events !== 5) invalid("poll events are POLLIN (1), POLLOUT (4) or both (5)");
      payload.u64(fdOf(entry.fd)).u32(entry.events);
    }
    const requested = entries.map(entry => ({ fd: entry.fd, events: entry.events }));
    return operation(65552, payload.u64(BigInt.asUintN(64, BigInt(timeoutMs))), result => decodePoll(requested, result));
  },
};

/** `host.at`: every operation travels synchronously on this process's own Linux channel. */
export function atFiles(client: Pick<LinuxClient, "sync">): LinuxAtFiles {
  const call = <T>(request: LinuxOperation<T>): T => client.sync(request);
  const ops = atFileOperations;
  return Object.freeze({
    cwd: CWD,
    openat: (at, path, flags, mode, resolve) => call(ops.openat(at, path, flags, mode, resolve)),
    statAt: (at, path, flags) => call(ops.statAt(at, path, flags)),
    mkdirAt: (at, path, mode) => { call(ops.mkdirAt(at, path, mode)); },
    unlinkAt: (at, path, flags) => { call(ops.unlinkAt(at, path, flags)); },
    renameAt: (fromDir, from, toDir, to, flags) => { call(ops.renameAt(fromDir, from, toDir, to, flags)); },
    linkAt: (fromDir, from, toDir, to, flags) => { call(ops.linkAt(fromDir, from, toDir, to, flags)); },
    symlinkAt: (target, at, path) => { call(ops.symlinkAt(target, at, path)); },
    readlinkAt: (at, path) => call(ops.readlinkAt(at, path)),
    utimensAt: (at, path, access, modification, flags) => { call(ops.utimensAt(at, path, access, modification, flags)); },
    pread: (fd, count, offset) => call(ops.pread(fd, count, offset)),
    pwrite: (fd, bytes, offset) => call(ops.pwrite(fd, bytes, offset)),
    statusFlags: fd => call(ops.statusFlags(fd)),
    setStatusFlags: (fd, flags) => { call(ops.setStatusFlags(fd, flags)); },
    getdents: (fd, maxBytes) => call(ops.getdents(fd, maxBytes)),
    fdatasync: fd => { call(ops.fdatasync(fd)); },
    poll: (entries, timeoutMs) => call(ops.poll(entries, timeoutMs)),
  } satisfies LinuxAtFiles);
}
