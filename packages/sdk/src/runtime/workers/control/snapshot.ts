import {decodeCurrentSystemImage} from "../../protocol/current-system-image.js";
import { VMError } from "../../errors.js";
import { record } from "../../decode.js";
import {
  type ControlRequest,
  decodeSnapshotRef,
  MAX_APP_DATA_BYTES,
  type SnapshotRef,
} from "../../protocol.js";
import type {
  PreparedSnapshotRestore,
  SnapshotStorageClient,
} from "../snapshot-channel.js";
import { type RestoreChunkArea, RestoreStreamReader } from "../snapshot-restore-stream.js";
import { assertStatus, callNumber, type Core, stage } from "./core.js";

export const SNAPSHOT_CHUNK_BYTES = 1024 * 1024;

const CORE_STATUS_INVALID_ARGUMENT = 2;
const CORE_STATUS_SNAPSHOT_INCOMPATIBLE = 5;
const RESTORE_CLOCK_PAUSE = 0;

/** The VM a restore must fit: its RAM, vCPU count and core CPU profile code. */
export interface RestoreShape {
  readonly memoryMiB: number;
  readonly vcpus: number;
  readonly profile: number;
}

/**
 * Stages a machine record and asks the core whether it restores into a VM of `shape`. It fails
 * before any destructive step: another record format or machine shape is a typed
 * incompatibility, and a malformed record is damaged storage.
 */
export function validateRestoreRecord(
  loaded: Core,
  record: Uint8Array,
  shape: RestoreShape,
): void {
  stage(loaded, record);
  const status = callNumber(loaded, "oxidevm_system_restore_validate", [
    record.byteLength,
    shape.memoryMiB,
    shape.vcpus,
    shape.profile,
  ]);
  if (status === CORE_STATUS_SNAPSHOT_INCOMPATIBLE) {
    throw new VMError(
      "SNAPSHOT_VERSION",
      "the snapshot was saved by another OxideVM version or a differently configured VM",
      { reason: "snapshot-incompatible" },
    );
  }
  if (status === CORE_STATUS_INVALID_ARGUMENT) {
    throw new VMError("STORAGE_ERROR", "the snapshot's machine record is damaged", {
      reason: "snapshot-damaged",
    });
  }
  assertStatus(status);
}

/**
 * Completes a restore with guest time paused: no TSC or timer catch-up, and the CMOS RTC reads
 * the host's wall clock. A crafted capture time therefore cannot move guest clocks.
 */
export function finishRestorePaused(loaded: Core, unixMilliseconds: number): void {
  const [low, high] = splitU64(Math.floor(unixMilliseconds / 1_000));
  assertStatus(
    callNumber(loaded, "oxidevm_system_restore_finish", [RESTORE_CLOCK_PAUSE, low, high]),
  );
}

export async function rememberSnapshotBootAssets(
  storage: SnapshotStorageClient,
  request: Extract<
    ControlRequest,
    { type: "boot-system" | "run-system-probe" }
  >,
): Promise<void> {
  const kernel = request.kernel.slice();
  const initrd = request.initrd?.slice();
  const disk = request.disk?.slice();
  await storage.request(
    {
      type: "remember-boot",
      kernel,
      managedDisk: request.hostDiskBytes !== undefined,
      ...(initrd === undefined ? {} : { initrd }),
      ...(disk === undefined ? {} : { disk }),
    },
    [
      kernel.buffer,
      ...(initrd === undefined ? [] : [initrd.buffer]),
      ...(disk === undefined ? [] : [disk.buffer]),
    ],
  );
}

export function validatePreparedRestore(
  value: unknown,
  snapshot: SnapshotRef,
): PreparedSnapshotRestore {
  const candidate = record(value, "snapshot restore metadata");
  const ref = decodeSnapshotRef(candidate["snapshot"]);
  if (ref.id !== snapshot.id || ref.createdAt !== snapshot.createdAt) {
    invalidRestore();
  }
  const capturedAtUnixMs = safeNonnegativeInteger(
    candidate["capturedAtUnixMs"],
  );
  const machineRecord = candidate["machineRecord"];
  const agentState = candidate["agentState"];
  const appData = candidate["appData"];
  const newerFiles = candidate["newerFiles"];
  const memoryBytes = safeNonnegativeInteger(candidate["memoryBytes"]);
  const diskRecord = candidate["disk"];
  if (
    capturedAtUnixMs === undefined ||
    !(machineRecord instanceof Uint8Array) ||
    (agentState !== undefined && !(agentState instanceof Uint8Array)) ||
    (appData !== undefined && (!(appData instanceof Uint8Array) || appData.byteLength > MAX_APP_DATA_BYTES)) ||
    typeof newerFiles !== "boolean" ||
    memoryBytes === undefined ||
    memoryBytes < 16 * SNAPSHOT_CHUNK_BYTES ||
    memoryBytes > 3072 * SNAPSHOT_CHUNK_BYTES ||
    memoryBytes % SNAPSHOT_CHUNK_BYTES !== 0 ||
    typeof diskRecord !== "object" ||
    diskRecord === null
  ) {
    invalidRestore();
  }
  const disk = record(diskRecord, "snapshot restore disk metadata");
  const modeValue = disk["mode"];
  const mode =
    modeValue === "none" || modeValue === "core" || modeValue === "host"
      ? modeValue
      : undefined;
  const diskBytes = safeNonnegativeInteger(disk["bytes"]);
  if (
    mode === undefined ||
    diskBytes === undefined
  ) {
    invalidRestore();
  }
  const ramChunks = decodeRestoreIndices(candidate["ramChunks"], memoryBytes);
  const baseChunks = decodeRestoreIndices(disk["baseChunks"], diskBytes);
  const overlayChunks = decodeRestoreIndices(disk["overlayChunks"], diskBytes);
  if (
    (mode === "none") !== (diskBytes === 0) ||
    (mode !== "core" &&
      (baseChunks.length !== 0 || overlayChunks.length !== 0)) ||
    (mode === "core" && diskBytes > 128 * 1024 * 1024)
  ) {
    invalidRestore();
  }
  return {
    snapshot: ref,
    ...(candidate["systemImage"]===undefined?{}:{systemImage:decodeCurrentSystemImage(candidate["systemImage"])}),
    capturedAtUnixMs,
    newerFiles,
    machineRecord,
    memoryBytes,
    ramChunks,
    ...(agentState instanceof Uint8Array ? { agentState } : {}),
    ...(appData instanceof Uint8Array ? { appData } : {}),
    disk: { mode, bytes: diskBytes, baseChunks, overlayChunks },
  };
}

function decodeRestoreIndices(
  value: unknown,
  totalBytes: number,
): number[] {
  if (!Array.isArray(value)) invalidRestore();
  const maximum = Math.ceil(totalBytes / SNAPSHOT_CHUNK_BYTES);
  const indices: number[] = [];
  for (const entry of value) {
    const index = safeNonnegativeInteger(entry);
    const previous = indices.at(-1);
    if (
      index === undefined ||
      index >= maximum ||
      (previous !== undefined && index <= previous)
    ) {
      invalidRestore();
    }
    indices.push(index);
  }
  return indices;
}

function safeNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export interface RestoreStream {
  readonly reader: RestoreStreamReader;
  /** Settles with the storage request; already observed, so awaiting it is optional. */
  readonly done: Promise<void>;
}

/**
 * Opens the prepared restore's chunk stream. The storage owner reads ahead while the core
 * applies chunks; when the storage request fails, the reader fails with its error.
 */
export function openRestoreStream(storage: SnapshotStorageClient): RestoreStream {
  const { port1, port2 } = new MessageChannel();
  const reader = new RestoreStreamReader(port1);
  const done = storage.request({ type: "stream-restore", port: port2 }, [port2]).then(() => undefined);
  void done.catch((error: unknown) => {
    reader.cancel(error instanceof VMError ? error : new VMError("STORAGE_ERROR", String(error)));
  });
  return { reader, done };
}

/** The stream's next chunk, which must be `area` chunk `index` of a `totalBytes` image. */
export async function takeRestoreChunk(
  reader: RestoreStreamReader,
  area: RestoreChunkArea,
  index: number,
  totalBytes: number,
): Promise<Uint8Array> {
  const chunk = await reader.next();
  if (chunk?.area !== area || chunk.index !== index) {
    throw new VMError("PROTOCOL_ERROR", "the restore stream sent an unexpected chunk");
  }
  if (chunk.data.byteLength !== snapshotChunkLength(index, totalBytes)) {
    throw new VMError("STORAGE_ERROR", `restored ${area} chunk ${String(index)} has the wrong length`);
  }
  return chunk.data;
}

export function snapshotChunkLength(index: number, totalBytes: number): number {
  return Math.min(
    SNAPSHOT_CHUNK_BYTES,
    totalBytes - index * SNAPSHOT_CHUNK_BYTES,
  );
}

export function splitU64(value: number): [number, number] {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "u64 value is outside JavaScript's safe range",
    );
  }
  return [value >>> 0, Math.floor(value / 0x1_0000_0000)];
}

function invalidRestore(): never {
  throw new VMError(
    "PROTOCOL_ERROR",
    "snapshot restore metadata is invalid",
  );
}
