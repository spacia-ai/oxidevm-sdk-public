import type { CommandInterceptor } from "./command-interceptors.js";
export type { CommandInterceptor } from "./command-interceptors.js";
import type {ShippedSnapshotRef} from "./shipped-snapshot.js";
// Public contracts follow the approved design; declarations are emitted from implementation.
import type { ImageRef, ImageInfo } from "./image.js";
import type { RuntimeMode, ImagePreparation, ProcessId } from "./values.js";
import type { VMError } from "./runtime/errors.js";
import type { BackupDestination } from "./backup-destination.js";
import type { RelayConnectionOptions, VMNetwork } from "./runtime/network-types.js";
export type { BackupDestination } from "./backup-destination.js";
import type {
  WorkspaceChange, WorkspaceFile, WorkspaceFileEntry, WorkspaceOperationOptions, WorkspaceReadOptions, WorkspaceWatch, WorkspaceWatchOptions, WorkspaceWriteOptions,
} from "./runtime/workspace-files.js";
// The workspace's file owner declares these; the public and diagnostic workspaces share them.
export type {
  WorkspaceChange, WorkspaceFile, WorkspaceFileEntry, WorkspaceOperationOptions, WorkspaceReadOptions, WorkspaceWatch, WorkspaceWatchOptions, WorkspaceWriteOptions,
} from "./runtime/workspace-files.js";
// A Userspace start's workspace report is declared by its wire decoder, which the frame shares.
export type {
  UserspaceWorkspaceConflict, UserspaceWorkspaceStart, UserspaceWorkspaceState, PreservedWorkspaceReason,
} from "./runtime/protocol/workspace-start.js";
import type { UserspaceWorkspaceStart } from "./runtime/protocol/workspace-start.js";
// Relay protocol 2's owner is the runtime's network client; these are its own declarations.
export type { NetworkState, RelayConnectionOptions, RelayFailureReason, VMNetwork } from "./runtime/network-types.js";

/**
 * Where the runtime runs. `frame` loads it in a hidden frame on Spacia's runtime origin (or
 * `origin`); the page must be cross-origin isolated. `self-hosted` loads an engine release this
 * site serves at `baseUrl`. `{ baseUrl }` without a hosting key is the older self-hosted shape.
 */
export type RuntimeOptions =
  | { readonly hosting: "frame"; readonly origin?: string | URL; readonly license?: string; readonly baseUrl?: never }
  | { readonly hosting: "self-hosted"; readonly baseUrl: string | URL; readonly license?: string; readonly origin?: never }
  | RuntimeAssets;

/** Why the engine did not accept a license token. */
export type LicenseRejection =
  | "malformed" | "unsupported-version" | "unknown-key" | "bad-signature" | "expired" | "not-yet-valid"
  | "origin-mismatch" | "not-self-host-license" | "self-host-requires-license"
  | "public-requires-license" | "issuer-policy-violation";

/**
 * Admission at VM creation. Development needs no token. Licensed includes registered
 * non-commercial use. `free` is retained for source compatibility with legacy releases only.
 */
export type LicenseStatus =
  | { /** @deprecated New engines never emit this tier. */ readonly tier: "free"; readonly rejected?: LicenseRejection }
  | { readonly tier: "development" }
  | {
      readonly tier: "licensed";
      readonly licenseId: string;
      readonly licensee: string;
      readonly expiresAt: number;
      readonly commercial: boolean;
      readonly validity: "active" | "grace";
      /** End of the signed expiry's seven-day admission grace. */
      readonly validUntil: number;
      /** May run from the licensee's own copy of the engine. */
      readonly selfHost: boolean;
      /** Sends the runtime frame's boot ping; a license may opt out. */
      readonly telemetry: boolean;
    };

/** A runtime given only as `{ baseUrl }` is self-hosted; the `hosting` key is optional with that shape. */
export interface RuntimeAssets {
  readonly hosting?: never;
  readonly baseUrl: string | URL;
}

/** Guest sockets stay local unless the VM connects through `vm.network`; relay mode connects it
 * with `connection` once the VM is ready and before creation resolves. */
export type NetworkOptions =
  | { readonly mode: "local"; readonly connection?: never; readonly relayUrl?: never }
  | { readonly mode: "relay"; readonly connection: RelayConnectionOptions; readonly relayUrl?: never };

export type PreviewOptions =
  | { readonly origin: string | URL; readonly isolation: "per-session" }
  | {
      readonly origin: string | URL;
      readonly isolation: "shared";
      readonly developmentOnly: true;
    };

export type BootProgress =
  | {
      readonly phase: "download";
      readonly asset: "engine" | "image" | "restore-point";
      readonly completedBytes: number;
      readonly totalBytes: number | null;
    }
  | { readonly phase: "validate" }
  | { readonly phase: "prepare-image"; readonly stage: "download" | "verify" | "commit"; readonly completedBytes: number; readonly totalBytes: number }
  | { readonly phase: "boot"; readonly mode: RuntimeMode }
  | { readonly phase: "restore"; readonly step: "open"; readonly completedBytes?: number; readonly totalBytes?: number }
  | { readonly phase: "restore"; readonly step: "wake" | "reconnect" }
  | { readonly phase: "ready" };

export type {WorkspaceMovedAway,WorkspaceHandoffResult} from "./runtime/workspace-handoff-types.js";
import type {WorkspaceMovedAway,WorkspaceHandoffOptions as LocalHandoffOptions} from "./runtime/workspace-handoff-types.js";
export interface WorkspaceHandoffOptions extends LocalHandoffOptions { readonly runtime?:RuntimeOptions; }

export interface CommonVMOptions {
  /** Complete installation before execution and readiness; defaults to on-demand acquisition. */
  readonly imagePreparation?: ImagePreparation;
  readonly workspaceId?: string;
  readonly memoryMiB?: number;
  readonly runtime?: RuntimeOptions;
  readonly network?: NetworkOptions;
  readonly preview?: PreviewOptions;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: BootProgress) => void;
}

export interface SystemOptions extends CommonVMOptions {
  readonly shippedSnapshot?: string | ShippedSnapshotRef<"system">;
  readonly mode: "system";
  readonly image?: ImageRef<"system">;
  readonly vcpus?: 1 | 2 | 3 | 4;
  readonly restorePoint?: ManagedResume;
  readonly limits?: never;
}

export interface UserspaceOptions extends CommonVMOptions {
  /**
   * How commands run. "auto" (the default) runs qualified JavaScript commands in browser workers. "off" disables
   * automatic acceleration and interceptors, and is required for root. An array installs custom interceptor workers,
   * which need a self-hosted runtime.
   */
  readonly commandInterceptors?: "auto" | "off" | readonly CommandInterceptor[];
  readonly shippedSnapshot?: string | ShippedSnapshotRef<"userspace">;
  readonly mode: "userspace";
  readonly image?: ImageRef<"userspace">;
  readonly limits?: { readonly maxProcesses?: number };
  /** Ordinary processes use uid/gid 1000; root is an explicit runtime choice. */
  readonly initialUser?: "user" | "root";
  /** Persist writable system paths separately from /workspace and the immutable image. */
  readonly rootPersistence?: "ephemeral" | "persistent";
  readonly vcpus?: never;
  readonly restorePoint?: ManagedResume;
}

export type CreateVMOptions = SystemOptions | UserspaceOptions;
export type VM = SystemVM | UserspaceVM;

export type FeatureUnavailableReason =
  | "mode-unsupported"
  | "image-unsupported"
  | "browser-unsupported"
  | "release-gate-open"
  | "not-configured"
  | "runtime-unsupported";

export type FeatureSupport =
  | { readonly available: true }
  | { readonly available: false; readonly reason: FeatureUnavailableReason };

export interface VMCapabilities {
  readonly previews: FeatureSupport;
  readonly snapshots: FeatureSupport;
  readonly maximumVcpus: 1 | 2 | 3 | 4;
  /**
   * Native JavaScript command acceleration for this VM. It is available only when the runtime opened its
   * native execution. `runtime-unsupported` means `commandInterceptors: "auto"` opened without it, because the
   * runtime publishes no native-node-api.json; commands then run in Linux.
   */
  readonly commandAcceleration: FeatureSupport;
  readonly crossOriginIsolated: boolean;
}

export interface VMBase {
  /** Opt in to saving and releasing this workspace when another tab requests it. */
  allowWorkspaceHandoff(listener:(moved:WorkspaceMovedAway)=>void,options:{readonly signal:AbortSignal}):Promise<void>;
  readonly start: VMStart;
  readonly snapshots: VMSnapshots;
  suspend(options: { readonly label: string; readonly signal?: AbortSignal }): Promise<SnapshotInfo>;
  readonly mode: RuntimeMode;
  readonly image: ImageInfo;
  /** Verify the configured image and offer it when it differs from the running image. */
  checkForUpdate(options?: { readonly signal?: AbortSignal }): Promise<ImageInfo | null>;
  /** Prepare or repair the actual running image without replacing the session or image version. */
  prepareImage(options?: { readonly signal?: AbortSignal }): Promise<void>;
  readonly workspace: Workspace;
  /** Guest internet access: the runtime's relay owner, the same object for the VM's lifetime. */
  readonly network: VMNetwork;
  readonly capabilities: VMCapabilities;
  readonly license: LicenseStatus;
  exec(spec: ExecSpec): Promise<ExecResult>;
  spawn(spec: TerminalSpawnSpec): Promise<TerminalHandle>;
  spawn(spec: PipeSpawnSpec): Promise<ProcessHandle>;
  exposePort(port: number, options?: { readonly signal?: AbortSignal }): Promise<PreviewHandle>;
  listeningPorts(options?: { readonly signal?: AbortSignal }): Promise<readonly ListeningPort[]>;
  watchListeningPorts(
    listener: (ports: readonly ListeningPort[]) => void,
    options: { readonly signal: AbortSignal },
  ): Promise<void>;
  dispose(): Promise<void>;
}

export interface SystemVM extends VMBase {
  readonly mode: "system";
  readonly image: ImageInfo & { readonly mode: "system" };
}

export interface UserspaceVM extends VMBase {
  readonly mode: "userspace";
  spawnJS(spec: TerminalJSProcessSpec): Promise<TerminalHandle>;
  spawnJS(spec: PipeJSProcessSpec): Promise<ProcessHandle>;
  readonly image: ImageInfo & { readonly mode: "userspace" };
  /**
   * `workspace` says how the workspace's saved /workspace met this image: kept as saved, carried
   * over from the image it was saved on, or carried over with conflicts or set aside.
   */
  readonly start: VMStart;
}





export interface WorkspaceEntry {
  readonly kind: "file" | "directory" | "symlink";
  readonly name: string;
  readonly path: string;
}

export type WorkspacePersistence =
  | { readonly kind: "ephemeral" }
  | {
      readonly kind: "persistent";
      readonly backend: "opfs" | "indexeddb";
      readonly browserRetention: "best-effort" | "granted";
    };

export interface Workspace {
  readonly id: string;
  readonly persistence: WorkspacePersistence;
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  readText(path: string, signal?: AbortSignal): Promise<string>;
  writeFile(path: string, data: Uint8Array, signal?: AbortSignal): Promise<void>;
  writeText(path: string, data: string, signal?: AbortSignal): Promise<void>;
  list(path?: string, signal?: AbortSignal): Promise<readonly WorkspaceEntry[]>;
  remove(path: string, options?: { readonly recursive?: boolean; readonly signal?: AbortSignal }): Promise<void>;
  /** The entries of a directory with their size, link target and content version. */
  entries(path?: string, signal?: AbortSignal): Promise<WorkspaceFileEntry[]>;
  stat(path: string, signal?: AbortSignal): Promise<WorkspaceFileEntry>;
  /** Reads a file and its entry; a file larger than `maxBytes` fails with STORAGE_ERROR `too-large`. */
  read(path: string, options?: WorkspaceReadOptions): Promise<WorkspaceFile>;
  /** Writes a file (at most 16 MiB), conditionally on `ifVersion`, and returns its new entry. */
  write(path: string, data: Uint8Array, options?: WorkspaceWriteOptions): Promise<WorkspaceFileEntry>;
  createDirectory(path: string, options?: WorkspaceOperationOptions): Promise<void>;
  rename(from: string, to: string, options?: WorkspaceOperationOptions): Promise<void>;
  /** Reports changes in the directories the watch names until `signal` aborts. */
  watch(onChange: (changes: readonly WorkspaceChange[]) => void, options: WorkspaceWatchOptions): WorkspaceWatch;
}

export type { LinuxSignal } from "./runtime/process-signals.js";
import type { LinuxSignal } from "./runtime/process-signals.js";

export type ProcessExit =
  | { readonly kind: "exited"; readonly code: number }
  | {
      readonly kind: "signaled";
      readonly signal: LinuxSignal | null;
      readonly signalNumber: number;
    };

export interface CommandSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ExecSpec extends CommandSpec {
  readonly stdin?: Uint8Array;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
  readonly terminal?: never;
}

export interface ExecResult {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exit: ProcessExit;
}

export interface PipeSpawnSpec extends CommandSpec {
  readonly signal?: AbortSignal;
  readonly terminal?: never;
}

export interface TerminalSpawnSpec extends CommandSpec {
  readonly signal?: AbortSignal;
  readonly terminal: { readonly columns: number; readonly rows: number };
}

export interface JSProcessSpec {
  readonly worker: URL;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}
export interface PipeJSProcessSpec extends JSProcessSpec { readonly terminal?: never }
export interface TerminalJSProcessSpec extends JSProcessSpec { readonly terminal: { readonly columns: number; readonly rows: number } }

export interface RunningProcess {
  /** Matches ResumedTerminal.key across a capture/reload; absent for legacy handles. */
  readonly snapshotKey?:string;
  readonly pid: ProcessId;
  readonly stdin: WritableStream<Uint8Array>;
  readonly exit: Promise<ProcessExit>;
  kill(
    signal?: LinuxSignal,
    options?: { readonly scope?: "process" | "process-group" },
  ): Promise<void>;
}

export interface ProcessHandle extends RunningProcess {
  readonly kind: "process";
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
}

export interface TerminalHandle extends RunningProcess {
  readonly kind: "terminal";
  readonly output: ReadableStream<Uint8Array>;
  resize(size: { readonly columns: number; readonly rows: number }): Promise<void>;
  interrupt(): Promise<void>;
}

export interface ListeningPort {
  readonly port: number;
  readonly address: string;
  readonly program: string | null;
  readonly previewable: boolean;
}

export interface PreviewHandle {
  readonly port: number;
  readonly url: URL;
  readonly isolation: "per-session" | "shared";
  close(): Promise<void>;
}

export interface SnapshotRef {
  readonly id: string;
  readonly createdAt: string;
}

export type ManagedResume =
  | "none" | "latest" | "pre-resume" | "fresh-image" | "update-image"
  | SnapshotRef;

export type SnapshotKind = "automatic" | "named" | "safety" | "imported" | "shipped";
export type SnapshotResumability =
  | true | "older-format" | "newer-format" | "profile-mismatch"
  | "machine-mismatch" | "runtime-mismatch" | "base-missing" | "corrupt";
export type SnapshotCompatibility =
  | true | "profile-mismatch" | "machine-mismatch" | "runtime-mismatch" | "base-missing";

export interface SnapshotInfo {
  readonly mode: "system" | "userspace";
  readonly ref: SnapshotRef;
  readonly kind: SnapshotKind;
  readonly label?: string;
  readonly capturedAtUnixMs: number;
  readonly profile: { readonly id: string; readonly version: string } | null;
  readonly bytes: { readonly ram: number; readonly disk: number; readonly unique: number };
  readonly resumable: SnapshotResumability;
}

export type ManagedBootReason =
  | "first-start" | "restart" | "fresh-image" | "update-image" | "no-save"
  | "incompatible" | "damaged" | "no-space" | "restore-failed" | "agent-unavailable";

export type ShippedSkipReason =
  | "untrusted" | "signature-invalid" | "newer" | "older" | "incompatible"
  | "damaged" | "unavailable" | "no-space" | "restore-failed" | "agent-unavailable";

export type ResumedTerminal =
  | { readonly source: "console"; readonly key: "console"; readonly screenTail: Uint8Array }
  | {
      readonly source: "process";
      readonly key: string;
      readonly command: string;
      readonly screenTail: Uint8Array;
      /** Replays the saved screen once, then streams output from the restored process. */
      attach(options?: { readonly signal?: AbortSignal }): Promise<ProcessHandle | TerminalHandle>;
    };

export type VMStart =
  | {
      readonly kind: "booted";
      readonly workspaceDetails?: UserspaceWorkspaceStart;
      readonly update?: {readonly id:string;readonly version:string};
      readonly reason: ManagedBootReason;
      readonly skipped?: SnapshotInfo;
      readonly shipped?: { readonly reason: ShippedSkipReason };
    }
  | {
      readonly kind: "resumed";
      readonly workspaceDetails?: UserspaceWorkspaceStart;
      readonly update?: {readonly id:string;readonly version:string};
      readonly snapshot: SnapshotInfo;
      readonly appData: Uint8Array | null;
      readonly terminals: readonly ResumedTerminal[];
      readonly newerFilesDropped: boolean;
      readonly workspace: "in-sync" | "reconciled" | "conflict-preserved";
      readonly skipped?: SnapshotInfo;
    };

export type StartProgress =
  | { readonly step: "boot" }
  | { readonly step: "prepare" | "download" | "open"; readonly completedBytes: number; readonly totalBytes: number }
  | { readonly step: "wake" | "reconnect" };

export interface SnapshotRestoreOptions {
  readonly saveCurrentFirst?: boolean;
  readonly onProgress?: (progress: StartProgress) => void;
  readonly signal?: AbortSignal;
}

export interface SnapshotRestoreResult {
  readonly start: Extract<VMStart, { readonly kind: "resumed" }>;
  readonly undo?: SnapshotInfo;
}

export interface SnapshotUsage {
  readonly referencedBytes: number;
  readonly reclaimableBytes: number;
  readonly estimate: { readonly usage: number; readonly quota: number } | null;
  readonly persisted: boolean | null;
}

export interface BackupOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: { readonly completedBytes: number; readonly totalBytes: number }) => void;
}

export type BackupExportResult =
  | { readonly kind: "written"; readonly bytes: number }
  | { readonly kind: "file"; readonly file: File; readonly suggestedName: string };

export interface BackupInspection {
  readonly mode: "system" | "userspace";
  readonly kind: SnapshotKind;
  readonly label?: string;
  readonly capturedAtUnixMs: number;
  readonly profile: { readonly id: string; readonly version: string } | null;
  readonly machine: { readonly memoryMiB: number; readonly vcpus: number };
  readonly fileBytes: number;
  readonly compatible: SnapshotCompatibility;
}

export type SnapshotEvent =
  | { readonly type: "image-preparation-progress"; readonly completedBytes:number; readonly totalBytes:number }
  | { readonly type: "image-prepared" }
  | { readonly type: "image-preparation-failed"; readonly error:VMError }
  | { readonly type: "save-started"; readonly kind: SnapshotKind }
  | {
      readonly type: "save-finished";
      readonly kind: SnapshotKind;
      readonly snapshot: SnapshotRef;
      readonly pauseMilliseconds: number;
      readonly durationMilliseconds: number;
    }
  | { readonly type: "save-failed"; readonly kind: SnapshotKind; readonly error: VMError }
  | { readonly type: "auto-save-paused"; readonly reason: "quota"; readonly retryInMilliseconds: number }
  | { readonly type: "restore-progress"; readonly completedBytes: number; readonly totalBytes: number };

export interface VMSnapshots {
  list(options?: { readonly signal?: AbortSignal }): Promise<readonly SnapshotInfo[]>;
  capture(options: {
    readonly label: string;
    readonly kind?: "named" | "safety" | "automatic";
    readonly signal?: AbortSignal;
  }): Promise<SnapshotInfo>;
  restore(snapshot: SnapshotRef, options?: SnapshotRestoreOptions): Promise<SnapshotRestoreResult>;
  rename(snapshot: SnapshotRef, label: string, options?: { readonly signal?: AbortSignal }): Promise<SnapshotInfo>;
  delete(snapshot: SnapshotRef, options?: { readonly signal?: AbortSignal }): Promise<void>;
  usage(options?: { readonly signal?: AbortSignal }): Promise<SnapshotUsage>;
  setAppData(data: Uint8Array | null): Promise<void>;
  observe(listener: (event: SnapshotEvent) => void, options: { readonly signal: AbortSignal }): void;
  readonly autoSave: {
    configure(policy: { readonly enabled: boolean }, options?: { readonly signal?: AbortSignal }): Promise<void>;
    hint(hint: "hidden" | "visible" | "activity" | "files-changed"): void;
  };
  export(snapshot: SnapshotRef, options?: BackupOptions & { readonly destination?: BackupDestination }): Promise<BackupExportResult>;
  inspect(file: Blob, options?: { readonly signal?: AbortSignal }): Promise<BackupInspection>;
  import(file: Blob, options?: BackupOptions): Promise<SnapshotInfo>;
}

/** Compatibility aliases for callers using the original System restore-point names. */
export type SystemStart = VMStart;
export type SystemSnapshots = VMSnapshots;
