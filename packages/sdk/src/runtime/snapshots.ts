import type { BackupDestination } from "../backup-destination.js";
import { VMError } from "./errors.js";
import type { ResumedSession } from "./managed-start.js";
import {
  type BackupExportResult,
  type BackupInspection,
  type ControlOperations,
  decodeSnapshotRef,
  type SnapshotInfo,
  type SnapshotRef,
  type SnapshotUsage,
  type StorageOperations,
  validateAppData,
  validateAutoSaveEnabled,
  validateAutoSaveHint,
  validateRestorePointName,
} from "./protocol.js";
import type { SnapshotObserver } from "./snapshot-observer.js";
import { withProgressPort } from "./progress-port.js";
import type {
  BackupOptions,
  SnapshotEvent,
  SnapshotRestoreOptions,
  SnapshotRestoreResult,
  StartProgress,
  RuntimeVMAutoSave,
  RuntimeVMSnapshots,
} from "./snapshot-types.js";
import type { WorkerClient } from "./worker-client.js";

/** The safety point a restore saves first, so the restore can be undone. */
const BEFORE_RESTORE = "Before restore";

/** The shared catalogue and the runtime's native snapshot coordinator. */
export interface RuntimeSnapshotsHost {
  readonly control: WorkerClient<ControlOperations>;
  readonly storage: WorkerClient<StorageOperations>;
  readonly observer: SnapshotObserver;
  /** Restores `snapshot` in session, reporting its steps, and returns what came back. */
  readonly restore: (
    snapshot: SnapshotRef,
    onProgress: ((progress: StartProgress) => void) | undefined,
    signal: AbortSignal | undefined,
  ) => Promise<ResumedSession>;
}

/** A VM's restore points: the storage worker's catalogue and the control worker's saves. */
export class RuntimeSnapshots implements RuntimeVMSnapshots {
  readonly #host: RuntimeSnapshotsHost;
  readonly autoSave: RuntimeVMAutoSave;

  constructor(host: RuntimeSnapshotsHost) {
    this.#host = host;
    this.autoSave = {
      configure: async (policy, options = {}) => {
        const enabled = validateAutoSaveEnabled(policy);
        await host.control.request("auto-save-configure", { enabled }, { signal: options.signal });
      },
      hint: (hint) => {
        void host.control.request("auto-save-hint", { hint: validateAutoSaveHint(hint) }).catch(() => {
          // A hint only times saves; a VM that cannot take it reports why through its other calls.
        });
      },
    };
  }

  observe(listener: (event: SnapshotEvent) => void, options: { readonly signal: AbortSignal }): void {
    // Untyped callers may pass anything.
    const callback: unknown = listener;
    const given: unknown = options;
    const signal = typeof given === "object" && given !== null && "signal" in given ? given.signal : undefined;
    if (typeof callback !== "function" || !(signal instanceof AbortSignal)) {
      throw new VMError("INVALID_ARGUMENT", "observing restore points takes a listener and an AbortSignal");
    }
    void this.#host.observer.listen(listener, signal).catch(() => {
      // Opening events fails only when the VM stops, which its other calls report.
    });
  }

  list(options: { readonly signal?: AbortSignal } = {}): Promise<readonly SnapshotInfo[]> {
    return this.#host.storage.request("snapshot-list", undefined, { signal: options.signal });
  }

  async capture(options: {
    readonly label: string;
    readonly kind?: "named" | "safety" | "automatic";
    readonly signal?: AbortSignal;
  }): Promise<SnapshotInfo> {
    const label = validateRestorePointName(options.label);
    // Untyped callers may pass anything; a save without a kind on the wire is automatic.
    const kind: unknown = options.kind ?? "named";
    if (kind !== "named" && kind !== "safety" && kind !== "automatic") {
      throw new VMError("INVALID_ARGUMENT", "a restore point is named, a safety point or automatic");
    }
    const ref = await this.#host.control.request("snapshot", kind === "automatic" ? { label } : { label, kind }, { signal: options.signal, cancellation: "settled" });
    return this.#listed(ref, undefined);
  }

  async restore(snapshot: SnapshotRef, options: SnapshotRestoreOptions = {}): Promise<SnapshotRestoreResult> {
    const ref = decodeSnapshotRef(snapshot);
    const signal = options.signal;
    const undo = (options.saveCurrentFirst ?? true)
      ? await this.capture({ label: BEFORE_RESTORE, kind: "safety", ...(signal === undefined ? {} : { signal }) })
      : undefined;
    const restored = await this.#listed(ref, signal);
    const session = await this.#host.restore(ref, options.onProgress, signal);
    return { start: { kind: "resumed", snapshot: restored, ...session }, ...(undo === undefined ? {} : { undo }) };
  }

  rename(snapshot: SnapshotRef, label: string, options: { readonly signal?: AbortSignal } = {}): Promise<SnapshotInfo> {
    return this.#host.storage.request(
      "snapshot-rename",
      { snapshot: decodeSnapshotRef(snapshot), label: validateRestorePointName(label) },
      { signal: options.signal },
    );
  }

  async delete(snapshot: SnapshotRef, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    await this.#host.storage.request("snapshot-delete", { snapshot: decodeSnapshotRef(snapshot) }, { signal: options.signal });
  }

  usage(options: { readonly signal?: AbortSignal } = {}): Promise<SnapshotUsage> {
    return this.#host.storage.request("snapshot-usage", undefined, { signal: options.signal });
  }

  async setAppData(data: Uint8Array | null): Promise<void> {
    const copy = validateAppData(data)?.slice() ?? null;
    await this.#host.control.request("snapshot-app-data", { data: copy }, { transfer: copy === null ? [] : [copy.buffer] });
  }

  async export(
    snapshot: SnapshotRef,
    options: BackupOptions & { readonly destination?: BackupDestination } = {},
  ): Promise<BackupExportResult> {
    const ref = decodeSnapshotRef(snapshot);
    // Untyped callers may pass anything as the picked file.
    const destination: unknown = options.destination;
    if (destination !== undefined && !isFileHandle(destination)) {
      throw new VMError("INVALID_ARGUMENT", "a backup destination is a file the user picked");
    }
    return withProgressPort(options.onProgress, (progress) => this.#host.storage.request(
      "snapshot-export",
      { snapshot: ref, ...(destination === undefined ? {} : { destination }), progress },
      { signal: options.signal, transfer: [progress] },
    ));
  }

  async inspect(file: Blob, options: { readonly signal?: AbortSignal } = {}): Promise<BackupInspection> {
    return this.#host.storage.request("snapshot-inspect", { file: requireBlob(file) }, { signal: options.signal });
  }

  async import(file: Blob, options: BackupOptions = {}): Promise<SnapshotInfo> {
    const blob = requireBlob(file);
    return withProgressPort(options.onProgress, (progress) => this.#host.storage.request(
      "snapshot-import",
      { file: blob, progress },
      { signal: options.signal, transfer: [progress] },
    ));
  }

  async #listed(ref: SnapshotRef, signal: AbortSignal | undefined): Promise<SnapshotInfo> {
    const listed = (await this.list(signal === undefined ? {} : { signal })).find((info) => info.ref.id === ref.id);
    if (listed === undefined) throw new VMError("STORAGE_NOT_FOUND", "the restore point was not found");
    return listed;
  }
}

function requireBlob(file: unknown): Blob {
  if (!(file instanceof Blob)) throw new VMError("INVALID_ARGUMENT", "a backup is a file");
  return file;
}

function isFileHandle(value: unknown): value is BackupDestination {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "file"
    && "createWritable" in value && typeof value.createWritable === "function";
}
