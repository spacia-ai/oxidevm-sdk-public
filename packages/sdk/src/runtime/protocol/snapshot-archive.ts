import type { BackupDestination } from "../../backup-destination.js";
import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { PROTOCOL_VERSION } from "./common.js";
import {decodeShippedSource, type ShippedSource} from "./shipped-source.js";
import {
  decodeSnapshotRef,
  decodeSnapshotMode,
  SNAPSHOT_KINDS,
  type SnapshotCompatibility,
  type SnapshotKind,
  type SnapshotRef,
} from "./snapshots.js";

const MAX_LABEL_LENGTH = 256;
/** A shipped restore point's name, as a profile lists it. */
export const SHIPPED_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_FILE_NAME_LENGTH = 255;

/** Backup requests the SDK sends the storage worker (ADR 0014 R10). */
export type SnapshotArchiveRequest =
  | {
      readonly type: "snapshot-export";
      readonly snapshot: SnapshotRef;
      /** A file the user picked; without one, the worker stages a file the page downloads. */
      readonly destination?: BackupDestination;
      readonly progress: InstanceType<typeof MessagePort>;
    }
  | { readonly type: "snapshot-import"; readonly file: Blob; readonly progress: InstanceType<typeof MessagePort> }
  | { readonly type: "snapshot-inspect"; readonly file: Blob }
  | {
      /** Installs the shipped restore point the prepared profile lists under `name`. */
      readonly type: "snapshot-install-shipped";
      readonly name: string;
      readonly trustedKeyId: string;
      readonly trustedPublicKey: Uint8Array;
      readonly progress: InstanceType<typeof MessagePort>;
      readonly source?: ShippedSource;
    };

export type SnapshotArchiveType = SnapshotArchiveRequest["type"];

/** What an export produced: bytes written to the picked file, or a staged file to download. */
export type BackupExportResult =
  | { readonly kind: "written"; readonly bytes: number }
  | { readonly kind: "file"; readonly file: File; readonly suggestedName: string };

/** What a backup file holds and whether it fits this VM, read without storing anything. */
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

/** How far an export or import has come, posted on its progress port. */
export interface ArchiveProgress {
  readonly completedBytes: number;
  readonly totalBytes: number;
}

const COMPATIBILITY = [true, "runtime-mismatch", "machine-mismatch", "profile-mismatch", "base-missing"] as const;

export function isSnapshotArchiveType(type: string): type is SnapshotArchiveType {
  return type === "snapshot-export" || type === "snapshot-import" || type === "snapshot-inspect"
    || type === "snapshot-install-shipped";
}

/** Decodes a backup request whose envelope (`id`, `version`, `type`) is already checked. */
export function decodeSnapshotArchiveRequest(
  message: Readonly<Record<string, unknown>>,
  type: SnapshotArchiveType,
): SnapshotArchiveRequest {
  switch (type) {
    case "snapshot-export": {
      exactKeys(message, ["id", "version", "type", "snapshot", "progress"], ["destination"]);
      const destination = message["destination"] === undefined ? undefined : decodeFileHandle(message["destination"]);
      return {
        type,
        snapshot: decodeSnapshotRef(message["snapshot"]),
        ...(destination === undefined ? {} : { destination }),
        progress: decodePort(message["progress"]),
      };
    }
    case "snapshot-import":
      exactKeys(message, ["id", "version", "type", "file", "progress"]);
      return { type, file: decodeBlob(message["file"]), progress: decodePort(message["progress"]) };
    case "snapshot-inspect":
      exactKeys(message, ["id", "version", "type", "file"]);
      return { type, file: decodeBlob(message["file"]) };
    case "snapshot-install-shipped": {
      exactKeys(message, ["id", "version", "type", "name", "trustedKeyId", "trustedPublicKey", "progress"], ["source"]);
      const name = string(message["name"], "shipped restore point name");
      const trustedKeyId = string(message["trustedKeyId"], "trusted key id");
      const trustedPublicKey = message["trustedPublicKey"];
      if (!SHIPPED_NAME.test(name) || trustedKeyId.length === 0 || !(trustedPublicKey instanceof Uint8Array) || trustedPublicKey.byteLength !== 32) {
        throw new VMError("PROTOCOL_ERROR", "shipped restore point request is invalid");
      }
      return { type, name, trustedKeyId, trustedPublicKey, progress: decodePort(message["progress"]), ...(message["source"] === undefined ? {} : {source:decodeShippedSource(message["source"])}) };
    }
  }
}

export function decodeBackupExportResult(value: unknown): BackupExportResult {
  const result = record(value, "backup export result");
  if (result["kind"] === "written") {
    exactKeys(result, ["kind", "bytes"]);
    return { kind: "written", bytes: integer(result["bytes"], "backup bytes", 0) };
  }
  exactKeys(result, ["kind", "file", "suggestedName"]);
  const file = result["file"];
  const suggestedName = string(result["suggestedName"], "backup file name");
  if (
    result["kind"] !== "file" || !(file instanceof File)
    || !/^oxidevm-[a-z0-9-]+-\d{4}-\d{2}-\d{2}-\d{4}\.oxvm$/u.test(suggestedName) || suggestedName.length > MAX_FILE_NAME_LENGTH
  ) {
    throw new VMError("PROTOCOL_ERROR", "backup export result is invalid");
  }
  return { kind: "file", file, suggestedName };
}

export function decodeBackupInspection(value: unknown): BackupInspection {
  const inspection = record(value, "backup inspection");
  exactKeys(inspection, ["kind", "capturedAtUnixMs", "profile", "machine", "fileBytes", "compatible"], ["label", "mode"]);
  const kind = SNAPSHOT_KINDS.find((candidate) => candidate === inspection["kind"]);
  const compatible = COMPATIBILITY.find((candidate) => candidate === inspection["compatible"]);
  const label = inspection["label"] === undefined ? undefined : string(inspection["label"], "backup label");
  if (kind === undefined || compatible === undefined || (label !== undefined && label.length > MAX_LABEL_LENGTH)) {
    throw new VMError("PROTOCOL_ERROR", "backup inspection is invalid");
  }
  const machine = record(inspection["machine"], "backup machine");
  exactKeys(machine, ["memoryMiB", "vcpus"]);
  return {
    mode: decodeSnapshotMode(inspection["mode"]),
    kind,
    ...(label === undefined ? {} : { label }),
    capturedAtUnixMs: integer(inspection["capturedAtUnixMs"], "backup capture time", 0),
    profile: decodeProfile(inspection["profile"]),
    machine: { memoryMiB: integer(machine["memoryMiB"], "backup memory", 16, 3072), vcpus: integer(machine["vcpus"], "backup vCPUs", 1, 4) },
    fileBytes: integer(inspection["fileBytes"], "backup file size", 0),
    compatible,
  };
}

/** Decodes one `{ version, completedBytes, totalBytes }` message from an archive job's port. */
export function decodeArchiveProgressMessage(value: unknown): ArchiveProgress {
  const message = record(value, "backup progress");
  exactKeys(message, ["version", "completedBytes", "totalBytes"]);
  const completedBytes = integer(message["completedBytes"], "completed bytes", 0);
  const totalBytes = integer(message["totalBytes"], "total bytes", 0);
  if (message["version"] !== PROTOCOL_VERSION || completedBytes > totalBytes) {
    throw new VMError("PROTOCOL_ERROR", "backup progress is invalid");
  }
  return { completedBytes, totalBytes };
}

function decodeProfile(value: unknown): BackupInspection["profile"] {
  if (value === null) return null;
  const profile = record(value, "backup profile");
  exactKeys(profile, ["id", "version"]);
  return { id: string(profile["id"], "backup profile id"), version: string(profile["version"], "backup profile version") };
}

function decodePort(value: unknown): InstanceType<typeof MessagePort> {
  if (!(value instanceof MessagePort)) throw new VMError("PROTOCOL_ERROR", "backup progress port is invalid");
  return value;
}

function decodeBlob(value: unknown): Blob {
  if (!(value instanceof Blob)) throw new VMError("PROTOCOL_ERROR", "backup file is invalid");
  return value;
}

/** A file handle the user picked: the worker only asks it for a writable stream. */
function decodeFileHandle(value: unknown): BackupDestination {
  if (!isFileHandle(value)) throw new VMError("PROTOCOL_ERROR", "backup destination is invalid");
  return value;
}

function isFileHandle(value: unknown): value is BackupDestination {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "file"
    && "createWritable" in value && typeof value.createWritable === "function";
}
