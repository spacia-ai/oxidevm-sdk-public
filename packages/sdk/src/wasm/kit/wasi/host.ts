import type { ClockHost, LinuxAtFiles, LinuxDirent, LinuxProcesses, LinuxSyncFiles, NativeSyncRunResult, ProcessSync, RandomHost } from "../../../js-process-types.js";
import type { NetHost } from "../../capabilities.js";
import type { BaseHost } from "../../define.js";

/**
 * The host members the WASI layer uses: the process's own Linux streams (`files.sync`), and, when the module declares
 * them, descriptor-relative files (`files.at`), the VM's clocks (`clock`) and its entropy (`random`). A member a module
 * does not declare is absent, and every WASI function that needs it answers NOSYS instead of guessing.
 */
export interface WasiHost {
  readonly fs: Pick<LinuxSyncFiles, "read" | "write" | "fstat" | "seek" | "close" | "fsync" | "ftruncate" | "pipe">;
  readonly at?: LinuxAtFiles;
  readonly clock?: ClockHost;
  readonly random?: RandomHost;
}

/**
 * What `kit.wasi.run` takes: the WASI members plus failure reporting, and optionally the process's identity
 * (`process.info`), synchronous native runs (`process.sync`) and its network reach (`net.vm` or `net.internet`), which
 * serve the `oxidevm_bridge_v1` imports.
 */
export interface WasiRunHost extends WasiHost {
  readonly fail: BaseHost["fail"];
  readonly process?: Partial<Pick<LinuxProcesses, "info"> & Pick<ProcessSync, "runSync">>;
  readonly net?: Pick<NetHost, "connectSync" | "connectUnixSync">;
}

export type AtFiles = LinuxAtFiles;
export type { LinuxDirent };
export type ProcessSyncHost = Pick<ProcessSync, "runSync">;
export type NativeRunResult = NativeSyncRunResult;

/** A synchronous VM socket connection, and the network port the bridge uses. */
export interface SyncConnection {
  read(max: number, options?: { readonly timeoutMs?: number }): Uint8Array;
  write(bytes: Uint8Array): void;
  closeWrite(): void;
  close(): void;
}
export interface NetSyncHost {
  connectSync(options: { readonly host: string; readonly port: number; readonly tls?: boolean; readonly alpn?: readonly string[] }): SyncConnection;
  connectUnixSync(path: string): SyncConnection;
  /** The Linux errno a network failure carries (kit.net.errno). */
  errno(error: unknown): number;
}

/** Linux open(2) and *at(2) flag values the adapter passes. */
export const LINUX = {
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 0o100, O_EXCL: 0o200, O_TRUNC: 0o1000, O_APPEND: 0o2000, O_NONBLOCK: 0o4000,
  O_DSYNC: 0o10000, O_SYNC: 0o4010000, O_DIRECTORY: 0o200000, O_NOFOLLOW: 0o400000, O_CLOEXEC: 0o2000000, O_PATH: 0o10000000,
  AT_SYMLINK_NOFOLLOW: 0x100, AT_REMOVEDIR: 0x200, AT_SYMLINK_FOLLOW: 0x400, AT_EMPTY_PATH: 0x1000,
  RESOLVE_NO_MAGICLINKS: 2, RESOLVE_BENEATH: 8,
} as const;
