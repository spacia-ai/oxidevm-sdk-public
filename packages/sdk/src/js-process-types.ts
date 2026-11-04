import type { ProcessId } from "./values.js";
import type { ProcessExit } from "./contracts.js";

declare const descriptorBrand: unique symbol;
/** A descriptor in this worker's Rust-owned Linux process. */
export type FileDescriptor = number & { readonly [descriptorBrand]: "LinuxDescriptor" };
export interface LinuxOperationOptions { readonly signal?: AbortSignal }
/** A time for `utimes`: an instant (to the millisecond), `"now"` for the current time, or `"omit"` to leave that time unchanged. */
export type LinuxTimestamp = Date | "now" | "omit";
export interface LinuxTimeOptions {
  /** Whether a final symbolic link is followed. Defaults to true; false changes the link itself. */
  readonly followLinks?: boolean;
}
export interface LinuxSyncWriteOptions {
  /** For a socket: answer a closed peer with EPIPE instead of ending this worker with SIGPIPE. Anything else is ENOTSOCK. */
  readonly noSignal?: boolean;
}
export interface LinuxWriteOptions extends LinuxOperationOptions, LinuxSyncWriteOptions {}
export interface LinuxFileStat {
  readonly device: bigint; readonly inode: bigint; readonly links: bigint;
  readonly mode: number; readonly uid: number; readonly gid: number; readonly size: bigint;
  readonly accessedNs: bigint; readonly modifiedNs: bigint; readonly changedNs: bigint;
}
export interface LinuxDirectoryEntry { readonly name: string; readonly nameBytes: Uint8Array; readonly type: number }
export type LinuxPath = string | Uint8Array;
export type SeekOrigin = "start" | "current" | "end";
export interface LinuxSyncFiles {
  open(path: LinuxPath, flags?: number, mode?: number): FileDescriptor;
  read(fd: FileDescriptor, count: number): Uint8Array;
  write(fd: FileDescriptor, bytes: Uint8Array, options?: LinuxSyncWriteOptions): number;
  seek(fd: FileDescriptor, offset: bigint, origin?: SeekOrigin): bigint;
  close(fd: FileDescriptor): void;
  dup(fd: FileDescriptor, target?: FileDescriptor): FileDescriptor;
  pipe(): readonly [FileDescriptor, FileDescriptor];
  stat(path: LinuxPath): LinuxFileStat;
  lstat(path: LinuxPath): LinuxFileStat;
  fstat(fd: FileDescriptor): LinuxFileStat;
  readdir(path: LinuxPath): readonly LinuxDirectoryEntry[];
  realpath(path: LinuxPath): string;
  mkdir(path: LinuxPath, mode?: number): void;
  rename(from: LinuxPath, to: LinuxPath): void;
  unlink(path: LinuxPath, directory?: boolean): void;
  fsync(fd: FileDescriptor): void;
  /** Sets the permission bits (`mode & 0o7777`); the file-type bits of a `stat()` mode are ignored, as in chmod(2). */
  chmod(path: LinuxPath, mode: number): void;
  fchmod(fd: FileDescriptor, mode: number): void;
  /** Sets a file's length, zero-filling when it grows. The length must fit a signed 64-bit offset. */
  truncate(path: LinuxPath, length: bigint | number): void;
  ftruncate(fd: FileDescriptor, length: bigint | number): void;
  /** Sets a file's access and modification times, as utimensat(2): a `Date`, `"now"`, or `"omit"` to leave one unchanged. */
  utimes(path: LinuxPath, access: LinuxTimestamp, modification: LinuxTimestamp, options?: LinuxTimeOptions): void;
  /** Adds the name `to` for the existing file `from` (a hard link). */
  link(from: LinuxPath, to: LinuxPath): void;
  /** Creates `path` as a symbolic link that stores `target` verbatim; a relative target resolves against the link's directory. */
  symlink(target: LinuxPath, path: LinuxPath): void;
  /** Returns the text a symbolic link stores, decoded as UTF-8. */
  readlink(path: LinuxPath): string;
  readFile(path: LinuxPath, maxBytes?: number): Uint8Array;
  writeFile(path: LinuxPath, bytes: Uint8Array): void;
  writeAll(fd: FileDescriptor, bytes: Uint8Array, options?: LinuxSyncWriteOptions): void;
}
export interface LinuxFiles {
  open(path: LinuxPath, flags?: number, mode?: number, options?: LinuxOperationOptions): Promise<FileDescriptor>;
  read(fd: FileDescriptor, count: number, options?: LinuxOperationOptions): Promise<Uint8Array>;
  write(fd: FileDescriptor, bytes: Uint8Array, options?: LinuxWriteOptions): Promise<number>;
  seek(fd: FileDescriptor, offset: bigint, origin?: SeekOrigin): Promise<bigint>;
  close(fd: FileDescriptor): Promise<void>;
  dup(fd: FileDescriptor, target?: FileDescriptor): Promise<FileDescriptor>;
  pipe(): Promise<readonly [FileDescriptor, FileDescriptor]>;
  stat(path: LinuxPath): Promise<LinuxFileStat>;
  lstat(path: LinuxPath): Promise<LinuxFileStat>;
  fstat(fd: FileDescriptor): Promise<LinuxFileStat>;
  readdir(path: LinuxPath): Promise<readonly LinuxDirectoryEntry[]>;
  realpath(path: LinuxPath): Promise<string>;
  mkdir(path: LinuxPath, mode?: number): Promise<void>;
  rename(from: LinuxPath, to: LinuxPath): Promise<void>;
  unlink(path: LinuxPath, directory?: boolean): Promise<void>;
  fsync(fd: FileDescriptor): Promise<void>;
  /** Sets the permission bits (`mode & 0o7777`); the file-type bits of a `stat()` mode are ignored, as in chmod(2). */
  chmod(path: LinuxPath, mode: number): Promise<void>;
  fchmod(fd: FileDescriptor, mode: number): Promise<void>;
  /** Sets a file's length, zero-filling when it grows. The length must fit a signed 64-bit offset. */
  truncate(path: LinuxPath, length: bigint | number): Promise<void>;
  ftruncate(fd: FileDescriptor, length: bigint | number): Promise<void>;
  utimes(path: LinuxPath, access: LinuxTimestamp, modification: LinuxTimestamp, options?: LinuxTimeOptions): Promise<void>;
  /** Adds the name `to` for the existing file `from` (a hard link). */
  link(from: LinuxPath, to: LinuxPath): Promise<void>;
  /** Creates `path` as a symbolic link that stores `target` verbatim; a relative target resolves against the link's directory. */
  symlink(target: LinuxPath, path: LinuxPath): Promise<void>;
  /** Returns the text a symbolic link stores, decoded as UTF-8. */
  readlink(path: LinuxPath): Promise<string>;
  readFile(path: LinuxPath, maxBytes?: number): Promise<Uint8Array>;
  writeFile(path: LinuxPath, bytes: Uint8Array): Promise<void>;
  writeAll(fd: FileDescriptor, bytes: Uint8Array, options?: LinuxWriteOptions): Promise<void>;
}
export type LinuxSocketAddress = { readonly family: "ipv4" | "ipv6"; readonly address: string; readonly port: number } | { readonly family: "unix"; readonly path: string };
export interface LinuxSockets {
  socket(family: LinuxSocketAddress["family"]): Promise<FileDescriptor>;
  connect(fd: FileDescriptor, address: LinuxSocketAddress, options?: LinuxOperationOptions): Promise<void>;
  bind(fd: FileDescriptor, address: LinuxSocketAddress): Promise<void>;
  listen(fd: FileDescriptor, backlog?: number): Promise<void>;
  accept(fd: FileDescriptor, options?: LinuxOperationOptions): Promise<FileDescriptor>;
  address(fd: FileDescriptor, peer?: boolean): Promise<LinuxSocketAddress>;
  read: LinuxFiles["read"]; write: LinuxFiles["write"]; close: LinuxFiles["close"];
  shutdown(fd: FileDescriptor, direction: "read" | "write" | "both"): Promise<void>;
}
export interface LinuxProcessInfo {
  readonly pid: ProcessId; readonly parentPid: ProcessId | null;
  readonly uid: number; readonly gid: number; readonly cwd: string;
  readonly args: readonly string[]; readonly environment: readonly string[];
  readonly terminal: { readonly columns: number; readonly rows: number } | null;
}
export interface NativeChildSpec {
  /** An execve path in the guest; PATH lookup belongs to the native program. */
  readonly command: string; readonly args?: readonly string[];
  readonly cwd?: string; readonly env?: Readonly<Record<string, string>>;
  readonly stdio?: { readonly stdin?: "inherit" | "pipe"; readonly stdout?: "inherit" | "pipe"; readonly stderr?: "inherit" | "pipe" };
}
export interface NativeChild {
  readonly pid: ProcessId;
  readonly stdin: FileDescriptor | null; readonly stdout: FileDescriptor | null; readonly stderr: FileDescriptor | null;
}
export interface LinuxProcesses {
  info(): Promise<LinuxProcessInfo>;
  cwd(): Promise<string>; chdir(path: LinuxPath): Promise<void>;
  spawn(spec: NativeChildSpec, options?: LinuxOperationOptions): Promise<NativeChild>;
  wait(pid: ProcessId, options?: LinuxOperationOptions): Promise<ProcessExit>;
  signal(pid: ProcessId, signal: number): Promise<void>;
}
export interface LinuxProcessContext {
  readonly stdin: FileDescriptor; readonly stdout: FileDescriptor; readonly stderr: FileDescriptor;
  readonly files: LinuxFiles; readonly filesSync: LinuxSyncFiles;
  readonly sockets: LinuxSockets; readonly process: LinuxProcesses;
}
/** Application results are decoded at the worker boundary; named void handlers are valid. */
export type JSProcessHandler = (context: LinuxProcessContext) => unknown;

/** A time for `utimensAt`: nanoseconds since the epoch, `"now"` for the current time, or `"omit"` to leave it unchanged. */
export type LinuxNanoTime = bigint | "now" | "omit";
/** One getdents64 record: the raw name bytes, the inode, d_type, and the d_off cookie that resumes after it (seek to it). */
export interface LinuxDirent { readonly name: Uint8Array; readonly inode: bigint; readonly type: number; readonly next: bigint }
/** What `poll` waits for on one descriptor: POLLIN (1), POLLOUT (4) or both. */
export interface LinuxPollRequest { readonly fd: FileDescriptor; readonly events: 1 | 4 | 5 }
/** A descriptor `poll` found ready, with the events Linux reported. */
export interface LinuxPollReady { readonly fd: FileDescriptor; readonly revents: number }
/**
 * Descriptor-relative, positional and readiness operations, all synchronous (capability `files.at`). Rust resolves every
 * path against the descriptor it is given, with the flags the call carries; nothing is resolved here.
 */
export interface LinuxAtFiles {
  /** AT_FDCWD: the process's working directory as a directory descriptor. */
  readonly cwd: FileDescriptor;
  /** openat2(dir, path, { flags, mode, resolve }); `resolve` takes the RESOLVE_* bits (RESOLVE_BENEATH is 8). */
  openat(dir: FileDescriptor, path: LinuxPath, flags: number, mode: number, resolve?: number): FileDescriptor;
  /** newfstatat; `flags` admits AT_SYMLINK_NOFOLLOW (0x100) and AT_EMPTY_PATH (0x1000). */
  statAt(dir: FileDescriptor, path: LinuxPath, flags?: number): LinuxFileStat;
  mkdirAt(dir: FileDescriptor, path: LinuxPath, mode: number): void;
  /** unlinkat; AT_REMOVEDIR (0x200) removes a directory. */
  unlinkAt(dir: FileDescriptor, path: LinuxPath, flags?: number): void;
  /** renameat2; RENAME_NOREPLACE (1) and RENAME_EXCHANGE (2) as Rust admits them. */
  renameAt(fromDir: FileDescriptor, from: LinuxPath, toDir: FileDescriptor, to: LinuxPath, flags?: number): void;
  /** linkat; AT_SYMLINK_FOLLOW (0x400) and AT_EMPTY_PATH (0x1000). */
  linkAt(fromDir: FileDescriptor, from: LinuxPath, toDir: FileDescriptor, to: LinuxPath, flags?: number): void;
  symlinkAt(target: LinuxPath, dir: FileDescriptor, path: LinuxPath): void;
  /** The raw bytes the link stores (at most 4095), never decoded. */
  readlinkAt(dir: FileDescriptor, path: LinuxPath): Uint8Array;
  /** utimensat; an empty path with AT_EMPTY_PATH (0x1000) changes `dir` itself, AT_SYMLINK_NOFOLLOW (0x100) the link. */
  utimensAt(dir: FileDescriptor, path: LinuxPath, access: LinuxNanoTime, modification: LinuxNanoTime, flags?: number): void;
  pread(fd: FileDescriptor, count: number, offset: bigint): Uint8Array;
  pwrite(fd: FileDescriptor, bytes: Uint8Array, offset: bigint): number;
  /** fcntl(F_GETFL). */
  statusFlags(fd: FileDescriptor): number;
  /** fcntl(F_SETFL). */
  setStatusFlags(fd: FileDescriptor, flags: number): void;
  /** One getdents64 batch of at most `maxBytes` bytes, `.` and `..` included; empty at the end of the directory. */
  getdents(fd: FileDescriptor, maxBytes: number): readonly LinuxDirent[];
  fdatasync(fd: FileDescriptor): void;
  /** Readiness of 1 to 16 descriptors, waiting at most `timeoutMs` (-1 waits forever, else 0 to 86,400,000); empty is a timeout. */
  poll(entries: readonly LinuxPollRequest[], timeoutMs: number): readonly LinuxPollReady[];
}

/** A clock of the VM: wall-clock time, or time that only moves forward. */
export type LinuxClock = "realtime" | "monotonic";
/** The VM's clocks (capability `clock`): the clocks native programs in the VM read, in nanoseconds. */
export interface ClockHost {
  now(clock: LinuxClock): bigint;
  resolution(clock: LinuxClock): bigint;
}
/** The VM's entropy (capability `random`), as getrandom(2) gives it to native programs; any length, in bounded chunks. */
export interface RandomHost { fill(bytes: Uint8Array): void }

/** What `spawnSync` starts: a native child, killed with SIGKILL when this process ends for any reason if `owned`. */
export interface NativeSyncChildSpec extends NativeChildSpec { readonly owned?: boolean }
/** What `runSync` runs to completion, with piped standard streams and its own deadline. */
export interface NativeSyncRunSpec {
  /** An absolute execve path; with `args`, 1 to 64 strings without NUL. */
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Standard input, at most 5 MiB; the child then reads end of file. */
  readonly input?: Uint8Array;
  /** 1 to 180,000 ms of the VM's monotonic clock. */
  readonly timeoutMs: number;
  /** The most bytes kept of each output, at most 1 MiB. */
  readonly stdoutLimit: number;
  readonly stderrLimit: number;
}
export interface NativeSyncRunResult { readonly pid: ProcessId; readonly exit: ProcessExit; readonly stdout: Uint8Array; readonly stderr: Uint8Array }
/** Synchronous process calls (capability `process.sync`), for code that cannot await; each blocks only this worker. */
export interface ProcessSync {
  infoSync(): LinuxProcessInfo;
  spawnSync(spec: NativeSyncChildSpec): NativeChild;
  waitSync(pid: ProcessId): ProcessExit;
  signalSync(pid: ProcessId, signal: number): void;
  /**
   * Runs an owned child to completion: feeds `input`, drains both outputs together, and enforces `timeoutMs` itself.
   * A timeout is a `LinuxError` with errno 110 (ETIMEDOUT) and an output past its limit errno 7 (E2BIG), each after the
   * child was killed and reaped; an invalid spec is `INVALID_ARGUMENT` before anything starts.
   */
  runSync(spec: NativeSyncRunSpec): NativeSyncRunResult;
}
