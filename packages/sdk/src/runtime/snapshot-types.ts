import type {BackupExportResult,BackupInspection} from "./protocol/snapshot-archive.js";
export type {BackupExportResult,BackupInspection} from "./protocol/snapshot-archive.js";
import type { UserspaceWorkspaceStart } from "./protocol/workspace-start.js";
import type { BackupDestination } from "../backup-destination.js";
import type { VMError } from "./errors.js";
import type {
  AutoSaveHint,
  SnapshotEventRecord,
  SnapshotInfo,
  SnapshotKind,
  SnapshotRef,
  SnapshotUsage,
} from "./protocol/snapshots.js";
import type { ProcessHandle } from "./process-types.js";
import type { ImagePreparationReport } from "./protocol/image-preparation.js";

export type {
  AutoSaveHint,
  SnapshotCompatibility,
  SnapshotInfo,
  SnapshotKind,
  SnapshotRef,
  SnapshotResumability,
  SnapshotUsage,
} from "./protocol/snapshots.js";

/**
 * Where a managed boot starts: the latest restore point (falling back to earlier automatic saves),
 * a cold boot from the live disk (`"none"`, a restart that keeps the files), a cold boot from the
 * disk the last resume replaced (`"pre-resume"`, "Restart instead", which keeps files newer than
 * the restore point; the live disk without a resume), a fresh image (a reset), the requested
 * image's own disk (`"update-image"`, "Update Linux"), or a chosen restore point. Only a reset or
 * an update moves the workspace to an image other than the one its disk runs.
 */
export type ManagedResume = "latest" | "none" | "pre-resume" | "fresh-image" | "update-image" | SnapshotRef;

/** Why a managed boot started Linux cold instead of resuming. */
export type ManagedBootReason =
  /** No restore point exists yet. */
  | "first-start"
  /** The caller asked for a restart: from the live disk, or from the disk before a resume. */
  | "restart"
  /** The caller asked for a fresh image. */
  | "fresh-image"
  /** The caller asked to move to the requested image ("Update Linux"). */
  | "update-image"
  /** Restore points exist, but none matches where the VM left off (it last booted cold). */
  | "no-save"
  /** The restore point is from another format, profile or machine shape, or its image is gone. */
  | "incompatible"
  /** Every candidate restore point was damaged. */
  | "damaged"
  /** The browser had no room to resume. */
  | "no-space"
  /** Restoring failed for another reason. */
  | "restore-failed"
  /** The restored guest agent did not answer. */
  | "agent-unavailable";

/** Why a shipped restore point the page asked for did not open, so Linux booted cold. */
export type ShippedSkipReason =
  /** No trusted key was given, or the manifest is signed by another key. */
  | "untrusted"
  | "signature-invalid"
  /** The shipped restore point needs a newer OxideVM, or is from an older one. */
  | "newer"
  | "older"
  /** It belongs to another image or does not fit this VM. */
  | "incompatible"
  | "damaged"
  /** It could not be downloaded (offline, or the server failed). */
  | "unavailable"
  | "no-space"
  | "restore-failed"
  | "agent-unavailable";

/** How a resumed VM's /workspace relates to file changes made elsewhere since its save. */
export type ResumedWorkspaceState = "in-sync" | "reconciled" | "conflict-preserved";

/** A terminal a resumed VM brought back. */
export type ResumedTerminal =
  /** The Linux console; its screen continues through `diagnostics.startSystem()`. */
  | { readonly source: "console"; readonly key: "console"; readonly screenTail: Uint8Array }
  /** A guest process the page had started, still running and waiting for a page. */
  | {
      readonly source: "process";
      readonly key: string;
      readonly command: string;
      readonly screenTail: Uint8Array;
      /** Takes over the process: its saved screen comes first, then what it printed since. */
      attach(options?: { readonly signal?: AbortSignal }): Promise<ProcessHandle>;
    };

export type ManagedStart =
  | {
      readonly kind: "resumed";
      readonly update?: { readonly id: string; readonly version: string };
      readonly workspaceDetails?: UserspaceWorkspaceStart;
      readonly snapshot: SnapshotInfo;
      /** The page data saved with the restore point. */
      readonly appData: Uint8Array | null;
      readonly terminals: readonly ResumedTerminal[];
      /** The disk held files newer than the restore point; "Restart instead" (`"pre-resume"`) keeps them. */
      readonly newerFilesDropped: boolean;
      readonly workspace: ResumedWorkspaceState;
      /** A newer restore point that could not be resumed. */
      readonly skipped?: SnapshotInfo;
    }
  | {
      readonly kind: "booted";
      readonly update?: { readonly id: string; readonly version: string };
      readonly workspaceDetails?: UserspaceWorkspaceStart;
      readonly reason: ManagedBootReason;
      /** The restore point that could not be resumed. */
      readonly skipped?: SnapshotInfo;
      /** Why the shipped restore point the page asked for did not open. */
      readonly shipped?: { readonly reason: ShippedSkipReason };
    };

/**
 * A step of starting, resuming or restoring, for a progress display. A resume or restore runs
 * download (a shipped restore point only), open, wake and reconnect in that order; a cold boot
 * reports boot alone.
 */
export type StartProgress =
  /** Preparing runtime assets before selecting a cold boot or a saved session. */
  | ({ readonly step: "prepare" } & ImagePreparationReport)
  /** Booting Linux cold: the image is ready and the kernel starts. */
  | { readonly step: "boot" }
  /** Downloading a shipped restore point (a example's first open). */
  | { readonly step: "download"; readonly completedBytes: number; readonly totalBytes: number }
  /** Reading the restore point; `totalBytes` is 0 until its size is known. */
  | { readonly step: "open"; readonly completedBytes: number; readonly totalBytes: number }
  /** Starting Linux where the restore point left it. */
  | { readonly step: "wake" }
  /** Greeting the guest agent, setting the guest's clock and bringing its files up to date. */
  | { readonly step: "reconnect" };

export interface SnapshotRestoreOptions {
  /** Saves the current state as a "Before restore" safety point first (default true). */
  readonly saveCurrentFirst?: boolean;
  /** Called with each step of the restore. */
  readonly onProgress?: (progress: StartProgress) => void;
  readonly signal?: AbortSignal;
}

export interface SnapshotRestoreResult {
  readonly start: Extract<ManagedStart, { readonly kind: "resumed" }>;
  /** The safety point saved first, which restoring undoes the restore. */
  readonly undo?: SnapshotInfo;
}

/** What a VM's restore points do, as it happens; see `RuntimeVMSnapshots.observe`. */
export type SnapshotEvent =
  | Exclude<SnapshotEventRecord, { readonly type: "save-failed" | "image-preparation-failed" }>
  | { readonly type: "save-failed"; readonly kind: SnapshotKind; readonly error: VMError }
  | { readonly type: "image-preparation-failed"; readonly error:VMError };

export interface AutoSavePolicy {
  /** Saves the running VM while it changes, so reopening the page resumes it. */
  readonly enabled: boolean;
}

/** Automatic saves: off until configured. */
export interface RuntimeVMAutoSave {
  configure(policy: AutoSavePolicy, options?: { readonly signal?: AbortSignal }): Promise<void>;
  /**
   * Tells automatic saves what the page sees: `"hidden"` saves at once; activity (a keystroke)
   * and file changes save once things are quiet.
   */
  hint(hint: AutoSaveHint): void;
}

/** How far a backup export or import has come, in bytes. */
export interface BackupProgress {
  readonly completedBytes: number;
  readonly totalBytes: number;
}

export interface BackupOptions {
  /** Called with progress at most ten times a second, and when the bytes are all done. */
  readonly onProgress?: (progress: BackupProgress) => void;
  readonly signal?: AbortSignal;
}

/** Restore points shared by both runtime modes; unsupported storage capabilities fail explicitly. */
export interface RuntimeVMSnapshots {
  /** Every restore point, newest first, with whether it can resume this VM. */
  list(options?: { readonly signal?: AbortSignal }): Promise<readonly SnapshotInfo[]>;
  /**
   * Saves the running VM as a named restore point, a safety point (kept among the newest three,
   * for the save before a destructive action), or an automatic save made now, which retention
   * thins with the others.
   */
  capture(options: {
    readonly label: string;
    readonly kind?: "named" | "safety" | "automatic";
    readonly signal?: AbortSignal;
  }): Promise<SnapshotInfo>;
  /** Brings the VM back to `snapshot`: files, memory and running programs. */
  restore(snapshot: SnapshotRef, options?: SnapshotRestoreOptions): Promise<SnapshotRestoreResult>;
  rename(snapshot: SnapshotRef, label: string, options?: { readonly signal?: AbortSignal }): Promise<SnapshotInfo>;
  delete(snapshot: SnapshotRef, options?: { readonly signal?: AbortSignal }): Promise<void>;
  usage(options?: { readonly signal?: AbortSignal }): Promise<SnapshotUsage>;
  /** Sets the page data (at most 1 MiB) later restore points carry; null for none. */
  setAppData(data: Uint8Array | null): Promise<void>;
  /**
   * Calls `listener` with what the VM's restore points do (saves starting, finishing or failing,
   * automatic saves pausing for space, restores reading bytes) until `signal` aborts.
   */
  observe(listener: (event: SnapshotEvent) => void, options: { readonly signal: AbortSignal }): void;
  readonly autoSave: RuntimeVMAutoSave;
  /**
   * Writes `snapshot` as a backup file (`.oxvm`): to `destination`, a file the user picked, or
   * otherwise to a staged file the page offers as a download (`suggestedName`).
   */
  export(
    snapshot: SnapshotRef,
    options?: BackupOptions & { readonly destination?: BackupDestination },
  ): Promise<BackupExportResult>;
  /** What a backup file holds and whether this VM can open it, without storing anything. */
  inspect(file: Blob, options?: { readonly signal?: AbortSignal }): Promise<BackupInspection>;
  /** Stores a backup file as a new restore point (kind "imported"); restoring it opens it. */
  import(file: Blob, options?: BackupOptions): Promise<SnapshotInfo>;
}
