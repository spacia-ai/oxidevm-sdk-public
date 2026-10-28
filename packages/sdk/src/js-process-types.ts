import type { ProcessId } from "./values.js";
import type { ProcessExit } from "./contracts.js";

declare const descriptorBrand: unique symbol;
/** A descriptor in this worker's Rust-owned Linux process. */
export type FileDescriptor = number & { readonly [descriptorBrand]: "LinuxDescriptor" };
export interface LinuxOperationOptions { readonly signal?: AbortSignal }
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
  write(fd: FileDescriptor, bytes: Uint8Array): number;
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
  readFile(path: LinuxPath, maxBytes?: number): Uint8Array;
  writeFile(path: LinuxPath, bytes: Uint8Array): void;
  writeAll(fd: FileDescriptor, bytes: Uint8Array): void;
}
export interface LinuxFiles {
  open(path: LinuxPath, flags?: number, mode?: number, options?: LinuxOperationOptions): Promise<FileDescriptor>;
  read(fd: FileDescriptor, count: number, options?: LinuxOperationOptions): Promise<Uint8Array>;
  write(fd: FileDescriptor, bytes: Uint8Array, options?: LinuxOperationOptions): Promise<number>;
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
  readFile(path: LinuxPath, maxBytes?: number): Promise<Uint8Array>;
  writeFile(path: LinuxPath, bytes: Uint8Array): Promise<void>;
  writeAll(fd: FileDescriptor, bytes: Uint8Array, options?: LinuxOperationOptions): Promise<void>;
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
