import { VMError } from "./errors.ts";

export const MAX_WORKSPACE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_WORKSPACE_ENTRIES = 100_000;
export const MAX_WORKSPACE_WATCH_DIRECTORIES = 256;
export const MAX_WORKSPACE_CHANGES = 1_024;

export interface WorkspaceFileEntry {
  readonly kind: "file" | "directory" | "symlink";
  readonly link: { readonly kind: "file" | "directory" | "missing"; readonly path: string | null } | null;
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly version: string;
}

export interface WorkspaceFile {
  readonly entry: WorkspaceFileEntry;
  readonly data: Uint8Array;
}

export type WorkspaceChange =
  | { readonly kind: "changed"; readonly directory: string; readonly name: string }
  | { readonly kind: "rescan" };

/** A live watch of workspace directories; `done` settles when it ends (rejecting on failure). */
export interface WorkspaceWatch {
  /** Replaces the watched directories (at most 256 per VM across its watches). */
  setDirectories(paths: readonly string[]): Promise<void>;
  readonly done: Promise<void>;
}

/** `maxBytes` (at most 16 MiB, the default) bounds the file a read may return. */
export interface WorkspaceReadOptions { readonly maxBytes?: number; readonly signal?: AbortSignal }
/** `ifVersion`: write only over that version, or only a new file with `null`. */
export interface WorkspaceWriteOptions { readonly ifVersion?: string | null; readonly signal?: AbortSignal }
export interface WorkspaceOperationOptions { readonly signal?: AbortSignal }
export interface WorkspaceWatchOptions { readonly signal: AbortSignal }

export interface WorkspaceFileBackend {
  entries(path?: string, signal?: AbortSignal): Promise<WorkspaceFileEntry[]>;
  stat(path: string, signal?: AbortSignal): Promise<WorkspaceFileEntry>;
  read(path: string, options?: WorkspaceReadOptions): Promise<WorkspaceFile>;
  write(path: string, data: Uint8Array, options?: WorkspaceWriteOptions): Promise<WorkspaceFileEntry>;
  createDirectory(path: string, options?: WorkspaceOperationOptions): Promise<void>;
  rename(from: string, to: string, options?: WorkspaceOperationOptions): Promise<void>;
  watch(onChange: (changes: readonly WorkspaceChange[]) => void, options: WorkspaceWatchOptions): WorkspaceWatch;
}

export function validateWorkspaceReadLimit(maxBytes = MAX_WORKSPACE_FILE_BYTES): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_WORKSPACE_FILE_BYTES) {
    throw new VMError("INVALID_ARGUMENT", "workspace read limit must be at most 16 MiB");
  }
  return maxBytes;
}

export function validateWorkspaceVersion(version: string | null | undefined): void {
  if (version !== undefined && version !== null && !/^[0-9a-f]{48}$/u.test(version)) {
    throw new VMError("INVALID_ARGUMENT", "invalid workspace file version");
  }
}

export function filesUnavailable(reason: "image-update-required" | "no-root-filesystem" = "image-update-required"): VMError {
  return new VMError("FEATURE_NOT_AVAILABLE", reason === "image-update-required"
    ? "Update Linux to use the editor" : "No Linux root filesystem is installed", { reason });
}
