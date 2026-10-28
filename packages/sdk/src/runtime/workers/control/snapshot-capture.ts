import { VMError } from "../../errors.js";
import { decodeSnapshotRef, type SnapshotKind, type SnapshotRef } from "../../protocol.js";
import type { SnapshotStorageClient } from "../snapshot-channel.js";
import { assertStatus, callNumber, type Core, readRecord, stage } from "./core.js";
import { splitU64 } from "./snapshot.js";

/** Rounds a pre-copy runs at most: a busy guest can dirty RAM about as fast as it is copied. */
const PRECOPY_ROUNDS = 3;
/**
 * Chunks sent before the first is acknowledged. Awaiting each one let a guest execution slice
 * run between a reply's arrival and the next send, which copied about 23 ms per chunk in the
 * bun dev state: slower than the guest dirtied RAM, so pre-copy rounds never shrank.
 */
const CHUNKS_IN_FLIGHT = 4;
/**
 * RAM chunks the cut copies into memory so the guest resumes before they are written. The bun
 * dev state rewrites about 250 MiB within every pre-copy round, so that much is always dirty at
 * the cut however long a pre-copy runs. A pre-copy therefore only shrinks a larger dirty set
 * (a first capture) to this size; a cut still larger is written while frozen.
 */
const CUT_COPY_CHUNKS = 384;

/**
 * The steps of a save, which its failure names: opening it, copying RAM ahead of the freeze,
 * freezing, sealing the cut, writing a cut too large to copy while frozen, writing the cut after
 * the resume, and committing.
 */
type CapturePhase = "open" | "precopy" | "freeze" | "seal" | "frozen-write" | "write-out" | "commit";

/** What a capture asks of the machine it saves. */
export interface CaptureHooks {
  /** Quiesces the guest agent, pauses guest execution and quiesces disks; returns the resume. */
  readonly freeze: () => Promise<() => unknown>;
  /** The guest-agent session (OXHA) at the cut, called while the VM is frozen. */
  readonly agentState: () => Uint8Array<ArrayBuffer> | undefined;
  /** Whether the guest keeps running while RAM is copied ahead of the freeze. */
  readonly precopy: boolean;
  /** A monotonic clock in milliseconds, which times the guest's pause. */
  readonly now: () => number;
}

/** A committed capture and how long the guest was paused for it. */
export interface CaptureOutcome {
  readonly snapshot: SnapshotRef;
  readonly pauseMilliseconds: number;
}

export interface CaptureRequest {
  readonly memoryBytes: number;
  readonly vcpus: number;
  /** The snapshot this capture continues from; its RAM fills the chunks that are not sent. */
  readonly parentId: string | undefined;
  readonly kind: SnapshotKind;
  readonly label: string | undefined;
  /** The page data saved with the restore point. */
  readonly appData: Uint8Array | undefined;
}

/**
 * Captures the machine as an increment over `parentId`. With `precopy`, a dirty set too large
 * for the cut is copied in up to three rounds while the guest runs. The freeze then records the
 * machine, copies the chunks dirty since their last copy into memory and resumes the guest
 * before writing them, so the guest pauses for copies rather than storage writes. Dirty bits are cleared before a chunk
 * is read, so a store in between dirties it again instead of being lost; a capture that fails
 * before it commits marks every chunk it cleared dirty again, so the next capture sends it.
 */
export async function captureSystemSnapshot(
  loaded: Core,
  storage: SnapshotStorageClient,
  request: CaptureRequest,
  hooks: CaptureHooks,
): Promise<CaptureOutcome> {
  await inPhase("open", storage.request({
    type: "open-capture",
    snapshot: { id: crypto.randomUUID(), createdAt: new Date().toISOString() },
    kind: request.kind,
    memoryBytes: request.memoryBytes,
    vcpus: request.vcpus,
    ...(request.label === undefined ? {} : { label: request.label }),
    ...(request.parentId === undefined ? {} : { parentId: request.parentId }),
  }));
  const cleared = new Set<number>();
  let committed = false;
  try {
    if (hooks.precopy) await inPhase("precopy", precopyRam(loaded, storage, cleared));
    const resume = await inPhase("freeze", hooks.freeze());
    const frozenAt = hooks.now();
    let pauseMilliseconds = 0;
    let resumed = false;
    try {
      const ramChunks = await inPhase("seal", sealCapture(loaded, storage, hooks.agentState, request.appData));
      const cut = ramChunks.length <= CUT_COPY_CHUNKS ? copyRamChunks(loaded, ramChunks) : undefined;
      if (cut === undefined) {
        await inPhase("frozen-write", putChunks(storage, "ram", ramChunks, (index) => readChunk(loaded, "ram", index)));
      }
      // Clears the cut's dirty bits and retires the JIT's direct write pages, so a translated
      // store after the resume marks its chunk dirty for the next capture.
      clearRamDirty(loaded, ramChunks);
      for (const index of ramChunks) cleared.add(index);
      resumed = true;
      pauseMilliseconds = hooks.now() - frozenAt;
      await resume();
      if (cut !== undefined) await inPhase("write-out", putChunks(storage, "ram", ramChunks, (index) => takeChunk(cut, index)));
      const snapshot = decodeSnapshotRef(await inPhase("commit", storage.request({ type: "commit-capture" })));
      committed = true;
      return { snapshot, pauseMilliseconds };
    } finally {
      if (!resumed) await resume();
    }
  } catch (error) {
    if (!committed) {
      await storage.request({ type: "abort" }).catch(() => undefined);
      markRamDirty(loaded, cleared);
    }
    throw error;
  }
}

/** Waits for `step`; an SDK error it ends with also says which step of the save it was. */
async function inPhase<T>(phase: CapturePhase, step: Promise<T>): Promise<T> {
  try {
    return await step;
  } catch (error) {
    if (!(error instanceof VMError) || error.detail?.["phase"] !== undefined) throw error;
    throw new VMError(error.code, error.message, { ...error.detail, phase });
  }
}

/** Copies dirty RAM while the guest runs, round by round, until the cut can copy the rest. */
async function precopyRam(
  loaded: Core,
  storage: SnapshotStorageClient,
  cleared: Set<number>,
): Promise<void> {
  for (let round = 0; round < PRECOPY_ROUNDS; round += 1) {
    const dirty = dirtyRamChunks(loaded);
    if (dirty.length <= CUT_COPY_CHUNKS) return;
    clearRamDirty(loaded, dirty);
    for (const index of dirty) cleared.add(index);
    await putChunks(storage, "ram", dirty, (index) => readChunk(loaded, "ram", index));
  }
}

/**
 * Records the frozen machine and seals the capture with the chunks dirty at the cut; returns
 * the RAM chunks still to send. A core disk's chunks are sent while frozen.
 */
async function sealCapture(
  loaded: Core,
  storage: SnapshotStorageClient,
  agentState: () => Uint8Array<ArrayBuffer> | undefined,
  pageData: Uint8Array | undefined,
): Promise<readonly number[]> {
  const capturedAtUnixMs = Date.now();
  assertStatus(callNumber(loaded, "oxidevm_system_snapshot"));
  const machineRecord = readRecord(loaded, "result").slice();
  // The guest-agent session is recorded in the same cut as the machine.
  const agent = agentState();
  const ramChunks = dirtyRamChunks(loaded);
  assertStatus(callNumber(loaded, "oxidevm_system_dirty_disk_chunks"));
  const disk = decodeDiskSnapshotInfo(readRecord(loaded, "result"));
  const appData = pageData?.slice();
  await storage.request(
    {
      type: "seal-capture",
      capturedAtUnixMs,
      machineRecord,
      ramChunks,
      disk,
      ...(agent === undefined ? {} : { agentState: agent }),
      ...(appData === undefined ? {} : { appData }),
    },
    [machineRecord.buffer, ...(agent === undefined ? [] : [agent.buffer]), ...(appData === undefined ? [] : [appData.buffer])],
  );
  if (disk.kind === "core") await putChunks(storage, "disk", disk.chunks, (index) => readChunk(loaded, "disk", index));
  return ramChunks;
}

/** The cut's RAM, copied while the guest is frozen. */
function copyRamChunks(loaded: Core, chunks: readonly number[]): Map<number, Uint8Array<ArrayBuffer>> {
  return new Map(chunks.map((index) => [index, readChunk(loaded, "ram", index)]));
}

/** Hands one copied chunk to its send, releasing the cut's hold on it. */
function takeChunk(cut: Map<number, Uint8Array<ArrayBuffer>>, index: number): Uint8Array<ArrayBuffer> {
  const data = cut.get(index);
  if (data === undefined) throw new VMError("VM_FAULT", "a copied snapshot chunk is missing");
  cut.delete(index);
  return data;
}

/**
 * Sends `chunks` in order with up to CHUNKS_IN_FLIGHT unacknowledged, reading each as its send
 * starts; the first failure stops new sends and is rethrown once the outstanding ones settle.
 */
async function putChunks(
  storage: SnapshotStorageClient,
  area: "ram" | "disk",
  chunks: readonly number[],
  read: (index: number) => Uint8Array<ArrayBuffer>,
): Promise<void> {
  const sending = new Set<Promise<void>>();
  let failure: { readonly error: unknown } | undefined;
  for (const index of chunks) {
    while (sending.size >= CHUNKS_IN_FLIGHT) await Promise.race(sending);
    if (failure !== undefined) break;
    const put: Promise<void> = putChunk(storage, area, index, read)
      .catch((error: unknown) => {
        failure ??= { error };
      })
      .finally(() => sending.delete(put));
    sending.add(put);
  }
  await Promise.all(sending);
  if (failure !== undefined) throw failure.error;
}

async function putChunk(
  storage: SnapshotStorageClient,
  area: "ram" | "disk",
  index: number,
  read: (index: number) => Uint8Array<ArrayBuffer>,
): Promise<void> {
  const data = read(index);
  await storage.request({ type: "put-capture-chunk", area, index, data }, [data.buffer]);
}

/** Copies one chunk out of the core. */
function readChunk(loaded: Core, area: "ram" | "disk", index: number): Uint8Array<ArrayBuffer> {
  const [low, high] = splitU64(index);
  const read = area === "ram" ? "oxidevm_system_read_ram_chunk" : "oxidevm_system_read_disk_chunk";
  assertStatus(callNumber(loaded, read, [low, high]));
  return readRecord(loaded, "result").slice();
}

function dirtyRamChunks(loaded: Core): number[] {
  assertStatus(callNumber(loaded, "oxidevm_system_dirty_ram_chunks"));
  return decodeChunkIndices(readRecord(loaded, "result"));
}

/** Clears the chunks' dirty bits and retires the JIT's direct write pages. */
function clearRamDirty(loaded: Core, chunks: readonly number[]): void {
  stage(loaded, encodeChunkIndices(chunks));
  assertStatus(callNumber(loaded, "oxidevm_system_snapshot_commit_ram", [chunks.length]));
}

/** Marks cleared chunks dirty again after a capture that did not commit. */
function markRamDirty(loaded: Core, chunks: ReadonlySet<number>): void {
  if (chunks.size === 0) return;
  const list = [...chunks].sort((left, right) => left - right);
  stage(loaded, encodeChunkIndices(list));
  assertStatus(callNumber(loaded, "oxidevm_system_mark_ram_dirty", [list.length]));
}

function encodeChunkIndices(indices: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(indices.length * 8);
  const view = new DataView(bytes.buffer);
  indices.forEach((index, offset) => view.setBigUint64(offset * 8, BigInt(index), true));
  return bytes;
}

function decodeChunkIndices(bytes: Uint8Array): number[] {
  if (bytes.byteLength % 8 !== 0) {
    throw new VMError("VM_FAULT", "core returned an invalid chunk list");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const indices = Array.from({ length: bytes.byteLength / 8 }, (_, offset) =>
    safeU64(view.getBigUint64(offset * 8, true)),
  );
  if (
    indices.some(
      (index, offset) => {
        const previous = indices[offset - 1];
        return previous !== undefined && index <= previous;
      },
    )
  ) {
    throw new VMError("VM_FAULT", "core returned unordered chunk indices");
  }
  return indices;
}

function decodeDiskSnapshotInfo(bytes: Uint8Array): {
  readonly kind: "none" | "core" | "managed";
  readonly bytes: number;
  readonly chunks: readonly number[];
} {
  if (bytes.byteLength < 16 || (bytes.byteLength - 16) % 8 !== 0) {
    throw new VMError(
      "VM_FAULT",
      "core returned invalid disk snapshot metadata",
    );
  }
  if (bytes.subarray(1, 8).some((byte) => byte !== 0)) {
    throw new VMError(
      "VM_FAULT",
      "disk snapshot metadata has reserved bits",
    );
  }
  const kind =
    bytes[0] === 0
      ? "none"
      : bytes[0] === 1
        ? "core"
        : bytes[0] === 2
          ? "managed"
          : undefined;
  if (kind === undefined) {
    throw new VMError("VM_FAULT", "disk snapshot backend is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = safeU64(view.getBigUint64(8, true));
  const chunks = decodeChunkIndices(bytes.subarray(16));
  if (
    (kind === "none") !== (length === 0) ||
    (kind !== "core" && chunks.length !== 0)
  ) {
    throw new VMError(
      "VM_FAULT",
      "disk snapshot metadata is inconsistent",
    );
  }
  return { kind, bytes: length, chunks };
}

function safeU64(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new VMError(
      "VM_FAULT",
      "core returned a value outside JavaScript's safe range",
    );
  }
  return number;
}
