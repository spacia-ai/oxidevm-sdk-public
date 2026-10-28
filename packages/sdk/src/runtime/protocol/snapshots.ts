import {decodePreparedUserspaceRootfs,type PreparedUserspaceRootfs} from "./storage.js";
import {decodeCurrentSystemImage,type CurrentSystemImage} from "./current-system-image.js";
import { boolean, exactKeys, integer, record, string } from "../decode.js";
import { decodeImagePreparationReport, IMAGE_PREPARATION_DETAILS, type ImagePreparationReport } from "./image-preparation.js";
import { decodeSerializedError, type SerializedError, VMError } from "../errors.js";
import { PROTOCOL_VERSION } from "./common.js";
import { decodeResumedWorkspace, type ResumedWorkspace } from "./agent.js";
import { decodeUserspaceWorkspaceStart, type UserspaceWorkspaceStart } from "./workspace-start.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LABEL_BYTES = 256;
const MAX_PROFILE_NAME_LENGTH = 256;
/** A workspace keeps far fewer restore points; the bound only stops a hostile list. */
const MAX_LISTED_SNAPSHOTS = 100_000;
/** The page data a restore point carries (open tabs, drafts). */
export const MAX_APP_DATA_BYTES = 1024 * 1024;
const MAX_RESTORED_PROCESSES = 4096;
const MAX_RESTORED_TAIL_BYTES = 64 * 1024;
const MAX_RESTORED_COMMAND_LENGTH = 4096;

export interface SnapshotRef {
  readonly id: string;
  readonly createdAt: string;
}

export const SNAPSHOT_KINDS = ["automatic", "named", "safety", "imported", "shipped"] as const;
/**
 * How a restore point came to be: an automatic save, one the user named, a safety point taken
 * before a restore, reset or update, an opened backup, or one shipped with a profile.
 */
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

const NOT_RESUMABLE = [
  "older-format",
  "newer-format",
  "profile-mismatch",
  "machine-mismatch",
  "runtime-mismatch",
  "base-missing",
  "corrupt",
] as const;
/** True when a restore point can resume this VM, otherwise why it cannot. */
export type SnapshotResumability = true | (typeof NOT_RESUMABLE)[number];
/** Whether a readable restore point fits this VM: its shape, its profile, and its kept image. */
export type SnapshotCompatibility = Extract<SnapshotResumability, true | "runtime-mismatch" | "machine-mismatch" | "profile-mismatch" | "base-missing">;

/** A restore point as the catalogue lists it. */
export interface SnapshotInfo {
  readonly mode: "system" | "userspace";
  readonly ref: SnapshotRef;
  readonly kind: SnapshotKind;
  readonly label?: string;
  readonly capturedAtUnixMs: number;
  /** The managed profile it runs; null for a VM booted from its own kernel. */
  readonly profile: { readonly id: string; readonly version: string } | null;
  /**
   * Its RAM and changed disk content, and what only it keeps: about what deleting it frees once
   * no running VM continues from it.
   */
  readonly bytes: { readonly ram: number; readonly disk: number; readonly unique: number };
  readonly resumable: SnapshotResumability;
}

/** What restore points occupy, and what the browser reports for this origin. */
export interface SnapshotUsage {
  readonly referencedBytes: number;
  readonly reclaimableBytes: number;
  readonly estimate: { readonly usage: number; readonly quota: number } | null;
  readonly persisted: boolean | null;
}

/** A guest process a restore brought back; it waits for a page to attach to it. */
export type RestoredProcess = {
  /** The command line it was started with. */
  readonly command: string;
  readonly terminal: boolean;
  /** Its newest output at the save, at most 64 KiB. */
  readonly tail: Uint8Array;
} & (
  | { readonly mode?: "system"; readonly agentRequestId: number }
  | { readonly mode: "userspace"; readonly attachmentKey: number; readonly terminalKey: number; readonly pid: number }
);

/** What a completed restore brought back, for the page that resumes it. */
export interface RestoredSnapshot {
  /** Verified selected metadata, admitted before publication and returned with its outcome. */
  readonly nativeRootfs?:PreparedUserspaceRootfs;
  readonly systemImage?:CurrentSystemImage;
  /** The managed disk the restore replaced held files newer than the restore point. */
  readonly newerFilesDropped: boolean;
  /** The page data saved with the restore point. */
  readonly appData: Uint8Array | null;
  /** The newest hvc0 console output at the save. */
  readonly consoleTail: Uint8Array;
  readonly processes: readonly RestoredProcess[];
  /** Native automatic resume reconciles the kept workspace before publication. */
  readonly workspace?: ResumedWorkspace;
  readonly workspaceDetails?: UserspaceWorkspaceStart;
}

/** The VM a storage worker's restore points must fit. */
export interface SnapshotMachine {
  readonly mode?: "system" | "userspace";
  readonly memoryMiB: number;
  readonly vcpus: number;
}

export const AUTO_SAVE_HINTS = ["hidden", "visible", "activity", "files-changed"] as const;
/** What a page tells automatic saves: hidden saves at once, activity and file changes soon. */
export type AutoSaveHint = (typeof AUTO_SAVE_HINTS)[number];

/** A hint a page gives automatic saves, from a caller that may pass anything. */
export function validateAutoSaveHint(value: unknown): AutoSaveHint {
  const hint = AUTO_SAVE_HINTS.find((candidate) => candidate === value);
  if (hint === undefined) {
    throw new VMError("INVALID_ARGUMENT", "an automatic save hint is hidden, visible, activity or files-changed");
  }
  return hint;
}

/** Whether automatic saves run, from a caller that may pass anything. */
export function validateAutoSaveEnabled(policy: unknown): boolean {
  if (typeof policy === "object" && policy !== null && "enabled" in policy && typeof policy.enabled === "boolean") {
    return policy.enabled;
  }
  throw new VMError("INVALID_ARGUMENT", "an automatic save policy says whether saves are enabled");
}

/** What a VM's restore points tell the pages that follow them, as it happens. */
export type SnapshotEventRecord =
  | ({ readonly type: "image-preparation-progress" } & ImagePreparationReport)
  | { readonly type: "image-prepared" }
  | { readonly type: "image-preparation-failed"; readonly error:SerializedError }
  | { readonly type: "save-started"; readonly kind: SnapshotKind }
  | {
      readonly type: "save-finished";
      readonly kind: SnapshotKind;
      readonly snapshot: SnapshotRef;
      /** How long the guest was paused for the save. */
      readonly pauseMilliseconds: number;
      readonly durationMilliseconds: number;
    }
  | { readonly type: "save-failed"; readonly kind: SnapshotKind; readonly error: SerializedError }
  | { readonly type: "auto-save-paused"; readonly reason: "quota"; readonly retryInMilliseconds: number }
  | { readonly type: "restore-progress"; readonly completedBytes: number; readonly totalBytes: number };

/** Decodes one `{ version, event }` message from a VM's restore point event port. */
export function decodeSnapshotEventMessage(value: unknown): SnapshotEventRecord {
  const message = record(value, "restore point event message");
  exactKeys(message, ["version", "event"]);
  if (message["version"] !== PROTOCOL_VERSION) invalidEvent();
  return decodeSnapshotEventRecord(message["event"]);
}

export function decodeSnapshotEventRecord(value: unknown): SnapshotEventRecord {
  const event = record(value, "restore point event");
  switch (event["type"]) {
    case "image-prepared": exactKeys(event,["type"]);return {type:"image-prepared"};
    case "image-preparation-failed": exactKeys(event,["type","error"]);return {type:"image-preparation-failed",error:decodeSerializedError(event["error"])};
    case "image-preparation-progress": {
      exactKeys(event,["type","completedBytes","totalBytes"],IMAGE_PREPARATION_DETAILS);
      const completedBytes=integer(event["completedBytes"],"prepared image bytes",0),totalBytes=integer(event["totalBytes"],"image bytes",0);
      if(completedBytes>totalBytes)invalidEvent();return {type:"image-preparation-progress",...decodeImagePreparationReport(event)};
    }
    case "save-started":
      exactKeys(event, ["type", "kind"]);
      return { type: "save-started", kind: decodeKind(event["kind"]) };
    case "save-finished":
      exactKeys(event, ["type", "kind", "snapshot", "pauseMilliseconds", "durationMilliseconds"]);
      return {
        type: "save-finished",
        kind: decodeKind(event["kind"]),
        snapshot: decodeSnapshotRef(event["snapshot"]),
        pauseMilliseconds: milliseconds(event["pauseMilliseconds"]),
        durationMilliseconds: milliseconds(event["durationMilliseconds"]),
      };
    case "save-failed":
      exactKeys(event, ["type", "kind", "error"]);
      return { type: "save-failed", kind: decodeKind(event["kind"]), error: decodeSerializedError(event["error"]) };
    case "auto-save-paused":
      exactKeys(event, ["type", "reason", "retryInMilliseconds"]);
      if (event["reason"] !== "quota") invalidEvent();
      return { type: "auto-save-paused", reason: "quota", retryInMilliseconds: integer(event["retryInMilliseconds"], "retry delay", 0) };
    case "restore-progress": {
      exactKeys(event, ["type", "completedBytes", "totalBytes"]);
      const completedBytes = integer(event["completedBytes"], "restored bytes", 0);
      const totalBytes = integer(event["totalBytes"], "bytes to restore", 0);
      if (completedBytes > totalBytes) invalidEvent();
      return { type: "restore-progress", completedBytes, totalBytes };
    }
    default:
      return invalidEvent();
  }
}

/** Restore point control operations whose decoding this module owns. */
export type SnapshotControlRequest =
  | { readonly type: "snapshot-events"; readonly port: InstanceType<typeof MessagePort> }
  | { readonly type: "auto-save-configure"; readonly enabled: boolean }
  | { readonly type: "auto-save-hint"; readonly hint: AutoSaveHint };

export type SnapshotControlType = SnapshotControlRequest["type"];

export function isSnapshotControlType(type: string): type is SnapshotControlType {
  return type === "snapshot-events" || type === "auto-save-configure" || type === "auto-save-hint";
}

/** Decodes a restore point control request whose envelope is already checked. */
export function decodeSnapshotControlRequest(
  message: Readonly<Record<string, unknown>>,
  type: SnapshotControlType,
): SnapshotControlRequest {
  switch (type) {
    case "snapshot-events": {
      exactKeys(message, ["id", "version", "type", "port"]);
      const port = message["port"];
      if (!(port instanceof MessagePort)) throw new VMError("PROTOCOL_ERROR", "restore point event port is invalid");
      return { type, port };
    }
    case "auto-save-configure":
      exactKeys(message, ["id", "version", "type", "enabled"]);
      return { type, enabled: boolean(message["enabled"], "automatic saves enabled") };
    case "auto-save-hint": {
      exactKeys(message, ["id", "version", "type", "hint"]);
      const hint = AUTO_SAVE_HINTS.find((candidate) => candidate === message["hint"]);
      if (hint === undefined) throw new VMError("PROTOCOL_ERROR", "automatic save hint is invalid");
      return { type, hint };
    }
  }
}

/** Restore point catalogue requests the SDK sends to the storage worker. */
export type SnapshotCatalogRequest =
  | { readonly type: "snapshot-list" | "snapshot-usage" | "snapshot-resume-candidates" }
  | { readonly type: "snapshot-delete"; readonly snapshot: SnapshotRef }
  | { readonly type: "snapshot-rename"; readonly snapshot: SnapshotRef; readonly label: string };

export type SnapshotCatalogType = SnapshotCatalogRequest["type"];

export function isSnapshotCatalogType(type: string): type is SnapshotCatalogType {
  return type === "snapshot-list" || type === "snapshot-usage" || type === "snapshot-resume-candidates"
    || type === "snapshot-delete" || type === "snapshot-rename";
}

/** A capture the page names: a restore point it keeps, or a safety point before a change. */
export type NamedSnapshotKind = "named" | "safety";

/**
 * A capture request's fields: none for an automatic save, a label for a named restore point, or a
 * kind with a name for a named or safety point.
 */
export function decodeCaptureFields(
  message: Readonly<Record<string, unknown>>,
): { readonly label?: string; readonly kind?: NamedSnapshotKind } {
  exactKeys(message, ["id", "version", "type"], ["label", "kind"]);
  const kind = message["kind"];
  if (kind === undefined) return message["label"] === undefined ? {} : { label: validateSnapshotLabel(message["label"]) };
  if (kind !== "named" && kind !== "safety") throw new VMError("PROTOCOL_ERROR", "snapshot kind is invalid");
  return { label: validateRestorePointName(message["label"]), kind };
}

/** Decodes a catalogue request whose envelope (`id`, `version`, `type`) is already checked. */
export function decodeSnapshotCatalogRequest(
  message: Readonly<Record<string, unknown>>,
  type: SnapshotCatalogType,
): SnapshotCatalogRequest {
  switch (type) {
    case "snapshot-list":
    case "snapshot-usage":
    case "snapshot-resume-candidates":
      exactKeys(message, ["id", "version", "type"]);
      return { type };
    case "snapshot-delete":
      exactKeys(message, ["id", "version", "type", "snapshot"]);
      return { type, snapshot: decodeSnapshotRef(message["snapshot"]) };
    case "snapshot-rename":
      exactKeys(message, ["id", "version", "type", "snapshot", "label"]);
      return { type, snapshot: decodeSnapshotRef(message["snapshot"]), label: validateRestorePointName(message["label"]) };
  }
}

export function validateSnapshotLabel(value: unknown): string {
  const label = string(value, "snapshot label");
  if (new TextEncoder().encode(label).byteLength > MAX_LABEL_BYTES) {
    throw new VMError(
      "INVALID_ARGUMENT",
      "snapshot labels are limited to 256 UTF-8 bytes",
    );
  }
  return label;
}

/** A name the user gives a restore point: not blank, at most 256 UTF-8 bytes. */
export function validateRestorePointName(value: unknown): string {
  const label = validateSnapshotLabel(value);
  if (label.trim().length === 0) throw new VMError("INVALID_ARGUMENT", "a restore point needs a name");
  return label;
}

export function decodeSnapshotRef(value: unknown): SnapshotRef {
  const snapshot = record(value, "snapshot reference");
  exactKeys(snapshot, ["id", "createdAt"]);
  const id = decodeSnapshotId(snapshot["id"]);
  const createdAt = string(snapshot["createdAt"], "snapshot createdAt");
  if (
    Number.isNaN(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  ) {
    throw new VMError("INVALID_ARGUMENT", "snapshot reference is invalid");
  }
  return { id, createdAt };
}

export function decodeSnapshotId(value: unknown): string {
  const id = string(value, "snapshot id");
  if (!UUID.test(id)) throw new VMError("INVALID_ARGUMENT", "snapshot identity is invalid");
  return id;
}

export function decodeSnapshotMachine(value: unknown): SnapshotMachine {
  const machine = record(value, "snapshot machine");
  exactKeys(machine, ["memoryMiB", "vcpus"], ["mode"]);
  return {
    ...(machine["mode"] === undefined ? {} : { mode: decodeSnapshotMode(machine["mode"]) }),
    memoryMiB: integer(machine["memoryMiB"], "snapshot machine memory", 16, 3072),
    vcpus: integer(machine["vcpus"], "snapshot machine vCPUs", 1, 4),
  };
}

export function decodeSnapshotInfos(value: unknown): readonly SnapshotInfo[] {
  if (!Array.isArray(value) || value.length > MAX_LISTED_SNAPSHOTS) {
    throw new VMError("PROTOCOL_ERROR", "restore point list is invalid");
  }
  const infos: readonly unknown[] = value;
  return infos.map(decodeSnapshotInfo);
}

export function decodeSnapshotInfo(value: unknown): SnapshotInfo {
  const info = record(value, "restore point");
  exactKeys(info, ["ref", "kind", "capturedAtUnixMs", "profile", "bytes", "resumable"], ["label", "mode"]);
  const kind = SNAPSHOT_KINDS.find((candidate) => candidate === info["kind"]);
  const resumable = info["resumable"] === true ? true : NOT_RESUMABLE.find((reason) => reason === info["resumable"]);
  if (kind === undefined || resumable === undefined) invalidInfo();
  const label = info["label"] === undefined ? undefined : validateSnapshotLabel(info["label"]);
  const bytes = record(info["bytes"], "restore point bytes");
  exactKeys(bytes, ["ram", "disk", "unique"]);
  return {
    mode: decodeSnapshotMode(info["mode"]),
    ref: decodeSnapshotRef(info["ref"]),
    kind,
    ...(label === undefined ? {} : { label }),
    capturedAtUnixMs: integer(info["capturedAtUnixMs"], "restore point capture time", 0),
    profile: info["profile"] === null ? null : decodeProfile(info["profile"]),
    bytes: {
      ram: integer(bytes["ram"], "restore point RAM bytes", 0),
      disk: integer(bytes["disk"], "restore point disk bytes", 0),
      unique: integer(bytes["unique"], "restore point unique bytes", 0),
    },
    resumable,
  };
}

export function decodeRestoredSnapshot(value: unknown): RestoredSnapshot {
  const restored = record(value, "restored snapshot");
  exactKeys(restored, ["newerFilesDropped", "appData", "consoleTail", "processes"], ["workspace", "workspaceDetails", "nativeRootfs", "systemImage"]);
  if(restored["nativeRootfs"]!==undefined&&restored["systemImage"]!==undefined)throw new VMError("PROTOCOL_ERROR","Restored image metadata has two runtime owners");
  const processes: unknown = restored["processes"];
  if (!Array.isArray(processes) || processes.length > MAX_RESTORED_PROCESSES) invalidRestored();
  const list: readonly unknown[] = processes;
  return {
    ...(restored["nativeRootfs"]===undefined?{}:{nativeRootfs:decodePreparedUserspaceRootfs(restored["nativeRootfs"])}),
    ...(restored["systemImage"]===undefined?{}:{systemImage:decodeCurrentSystemImage(restored["systemImage"])}),
    newerFilesDropped: boolean(restored["newerFilesDropped"], "newer files dropped"),
    appData: restored["appData"] === null ? null : boundedBytes(restored["appData"], MAX_APP_DATA_BYTES),
    consoleTail: boundedBytes(restored["consoleTail"], MAX_RESTORED_TAIL_BYTES),
    processes: list.map(decodeRestoredProcess),
    ...(restored["workspace"] === undefined ? {} : { workspace: decodeResumedWorkspace(restored["workspace"]) }),
    ...(restored["workspaceDetails"] === undefined ? {} : { workspaceDetails: decodeUserspaceWorkspaceStart(restored["workspaceDetails"]) }),
  };
}

function decodeRestoredProcess(value: unknown): RestoredProcess {
  const process = record(value, "restored process");
  const native = process["mode"] === "userspace";
  exactKeys(process, [...(native ? ["mode", "attachmentKey", "terminalKey", "pid"] : ["agentRequestId"]), "command", "terminal", "tail"]);
  const command = string(process["command"], "restored process command");
  if (command.length > MAX_RESTORED_COMMAND_LENGTH) invalidRestored();
  return {
    ...(native ? { mode: "userspace", attachmentKey: integer(process["attachmentKey"], "restored attachment key", 1, 0xffff_ffff),
      terminalKey: integer(process["terminalKey"], "stable restored attachment key", 1, 0xffff_ffff),
      pid: integer(process["pid"], "restored process PID", 1, 0x7fff_ffff) } as const
      : { agentRequestId: integer(process["agentRequestId"], "restored process request", 1, 0xffff_ffff) }),
    command,
    terminal: boolean(process["terminal"], "restored process terminal"),
    tail: boundedBytes(process["tail"], MAX_RESTORED_TAIL_BYTES),
  };
}

/** Page data for later restore points: at most 1 MiB, or null for none. */
export function validateAppData(value: unknown): Uint8Array | null {
  return value === null ? null : boundedBytes(value, MAX_APP_DATA_BYTES);
}

function boundedBytes(value: unknown, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new VMError("PROTOCOL_ERROR", "restore point bytes are invalid");
  if (value.byteLength > maximum) {
    throw new VMError("INVALID_ARGUMENT", `restore point data is limited to ${String(maximum)} bytes`);
  }
  return value;
}

function invalidRestored(): never {
  throw new VMError("PROTOCOL_ERROR", "restored snapshot is invalid");
}

export function decodeSnapshotUsage(value: unknown): SnapshotUsage {
  const usage = record(value, "restore point usage");
  exactKeys(usage, ["referencedBytes", "reclaimableBytes", "estimate", "persisted"]);
  let estimate: SnapshotUsage["estimate"] = null;
  if (usage["estimate"] !== null) {
    const fields = record(usage["estimate"], "storage estimate");
    exactKeys(fields, ["usage", "quota"]);
    estimate = {
      usage: integer(fields["usage"], "storage estimate usage", 0),
      quota: integer(fields["quota"], "storage estimate quota", 0),
    };
  }
  return {
    referencedBytes: integer(usage["referencedBytes"], "referenced bytes", 0),
    reclaimableBytes: integer(usage["reclaimableBytes"], "reclaimable bytes", 0),
    estimate,
    persisted: usage["persisted"] === null ? null : boolean(usage["persisted"], "persisted storage"),
  };
}

function decodeProfile(value: unknown): NonNullable<SnapshotInfo["profile"]> {
  const profile = record(value, "restore point profile");
  exactKeys(profile, ["id", "version"]);
  return { id: decodeProfileName(profile["id"]), version: decodeProfileName(profile["version"]) };
}

function decodeProfileName(value: unknown): string {
  const name = string(value, "restore point profile name");
  if (name.length === 0 || name.length > MAX_PROFILE_NAME_LENGTH) invalidInfo();
  return name;
}

function decodeKind(value: unknown): SnapshotKind {
  return SNAPSHOT_KINDS.find((kind) => kind === value) ?? invalidEvent();
}

function milliseconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalidEvent();
  return value;
}

function invalidEvent(): never {
  throw new VMError("PROTOCOL_ERROR", "restore point event is invalid");
}

function invalidInfo(): never {
  throw new VMError("PROTOCOL_ERROR", "restore point is invalid");
}

/** Legacy catalogue messages imply system mode; new messages retain their runtime identity. */
export function decodeSnapshotMode(value: unknown): "system" | "userspace" {
  if (value === undefined || value === "system") return "system";
  if (value === "userspace") return value;
  throw new VMError("PROTOCOL_ERROR", "snapshot runtime mode is invalid");
}
