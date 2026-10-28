import { VMError } from "../errors.js";
import { MAX_APP_DATA_BYTES } from "../protocol.js";
import type { ManagedDisk } from "./managed-disk.js";
import type { SnapshotStorageRequest } from "./snapshot-channel.js";
import {
  type ChunkRef,
  type DiskChunk,
  isZeroChunk,
  MAX_AGENT_STATE_BYTES,
  MAX_MACHINE_RECORD_BYTES,
  type ObjectRef,
  objectRef,
  SNAPSHOT_SCHEMA,
  type SnapshotDisk,
  type SystemSnapshotManifest,
  snapshotChunkLength,
} from "./snapshot-manifest.js";
import type { SnapshotObjects } from "./snapshot-objects.js";

const MAX_LABEL_BYTES = 256;
const MIB = 1024 * 1024;
/** Object writes (digest and store) a capture runs at once while its next chunk arrives. */
const WRITES_IN_FLIGHT = 4;

/** The boot a capture belongs to: its kernel, initrd and disk. */
export interface SnapshotBoot {
  readonly kernel: ObjectRef;
  readonly initrd?: ObjectRef;
  readonly disk:
    | null
    | {
        readonly origin: "core";
        readonly bytes: number;
        readonly baseIdentity: string;
        /** The raw boot disk's non-zero chunks. */
        readonly base: ReadonlyMap<number, ObjectRef>;
      }
    | { readonly origin: "managed" };
}

export type OpenCaptureRequest = Extract<SnapshotStorageRequest, { readonly type: "open-capture" }>;
export type SealCaptureRequest = Extract<SnapshotStorageRequest, { readonly type: "seal-capture" }>;

type PendingDisk =
  | {
      readonly origin: "core";
      readonly bytes: number;
      readonly baseIdentity: string;
      readonly base: ReadonlyMap<number, ObjectRef>;
      readonly chunks: Map<number, DiskChunk>;
      readonly expected: Set<number>;
    }
  | {
      readonly origin: "managed";
      readonly bytes: number;
      readonly baseIdentity: string;
      readonly image: { readonly id: string; readonly version: string };
      readonly chunks: Map<number, DiskChunk>;
      readonly expected: Set<number>;
    };

/** What a capture's cut fixes: the frozen machine, its guest-agent session and the disk. */
interface CaptureCut {
  readonly request: SealCaptureRequest;
  readonly machine: ObjectRef;
  readonly agent: ObjectRef | undefined;
  readonly appData: ObjectRef | undefined;
  readonly disk: PendingDisk | null;
  readonly managedDisk: ManagedDisk | undefined;
}

/**
 * One capture transaction. It opens before its cut, so RAM can be copied while the guest still
 * runs (a pre-copy), and is sealed at the cut with the frozen machine and the chunks to send
 * again. The latest copy of a chunk wins. RAM chunks the control worker did not send keep the
 * parent's content; a chunk that became zero is dropped, because an absent RAM chunk is zero. A
 * disk chunk equal to its base is dropped, because an absent disk chunk is the base, and a disk
 * chunk that became zero over non-zero base content is kept as an explicit zero marker.
 */
export class SnapshotCapture {
  readonly #request: OpenCaptureRequest;
  readonly #objects: SnapshotObjects;
  readonly #boot: SnapshotBoot;
  readonly #parent: SystemSnapshotManifest | undefined;
  readonly #workspace: SystemSnapshotManifest["workspace"];
  readonly #ram: Map<number, ObjectRef>;
  readonly #writes = new CaptureWrites();
  /** The copy of each RAM chunk sent last; an older write that lands later is ignored. */
  readonly #latestRam = new Map<number, number>();
  #sent = 0;
  #expectedRam = new Set<number>();
  #cut: CaptureCut | undefined;

  private constructor(
    request: OpenCaptureRequest,
    objects: SnapshotObjects,
    boot: SnapshotBoot,
    parent: SystemSnapshotManifest | undefined,
    workspace: SystemSnapshotManifest["workspace"],
  ) {
    this.#request = request;
    this.#objects = objects;
    this.#boot = boot;
    this.#parent = parent;
    this.#workspace = workspace;
    this.#ram = new Map((parent?.ram ?? []).map((chunk) => [chunk.index, objectRef(chunk)]));
  }

  /**
   * Opens a capture; `parent` supplies the RAM the control worker does not send, and
   * `workspace` is the workspace store's generation at this save.
   */
  static open(
    objects: SnapshotObjects,
    request: OpenCaptureRequest,
    boot: SnapshotBoot,
    managedDisk: ManagedDisk | undefined,
    lineage: { readonly parent: SystemSnapshotManifest | undefined; readonly workspace: SystemSnapshotManifest["workspace"] },
  ): SnapshotCapture {
    const parent = lineage.parent;
    validateOpenRequest(request);
    if (parent !== undefined && !sameLineage(parent, request.memoryBytes, boot, managedDisk)) {
      throw new VMError("SNAPSHOT_VERSION", "snapshot parent does not match the running VM");
    }
    return new SnapshotCapture(request, objects, boot, parent, lineage.workspace);
  }

  /**
   * Seals the capture at its cut. `changeBase` is the snapshot a managed disk's change bitmap
   * follows; the disk chunks changed since it are read now.
   */
  async seal(
    request: SealCaptureRequest,
    managedDisk: ManagedDisk | undefined,
    changeBase: SystemSnapshotManifest | undefined,
  ): Promise<void> {
    if (this.#cut !== undefined) throw new VMError("PROTOCOL_ERROR", "snapshot capture is already sealed");
    validateSealRequest(request, this.#request.memoryBytes);
    const machine = await this.#objects.put(request.machineRecord);
    const agent = request.agentState === undefined ? undefined : await this.#objects.put(request.agentState);
    const appData = request.appData === undefined ? undefined : await this.#objects.put(request.appData);
    const disk = await sealDisk(this.#objects, this.#writes, request, this.#boot, managedDisk, {
      parent: this.#parent,
      changeBase,
    });
    this.#expectedRam = new Set(request.ramChunks);
    this.#cut = { request, machine, agent, appData, disk, managedDisk: disk?.origin === "managed" ? managedDisk : undefined };
  }

  /** The snapshot this capture commits as. */
  get id(): string {
    return this.#request.snapshot.id;
  }

  /** The managed disk whose changes this capture consumed; it records the commit. */
  get managedDisk(): ManagedDisk | undefined {
    return this.#cut?.managedDisk;
  }

  /** The digests of every object this capture has written or carries from its parent. */
  objectRefs(): string[] {
    const refs = [...this.#ram.values()].map((ref) => ref.sha256);
    if (this.#workspace !== undefined) refs.push(this.#workspace.index.sha256);
    const cut = this.#cut;
    if (cut === undefined) return refs;
    refs.push(cut.machine.sha256);
    if (cut.agent !== undefined) refs.push(cut.agent.sha256);
    if (cut.appData !== undefined) refs.push(cut.appData.sha256);
    for (const chunk of cut.disk?.chunks.values() ?? []) if (!isZeroChunk(chunk)) refs.push(chunk.sha256);
    return refs;
  }

  /**
   * Accepts one chunk; its object write may still be in flight when this resolves. A failed write
   * fails a later put and `settled`. Before the seal any RAM chunk may arrive; after it, only the
   * chunks the seal listed and the requested disk chunks.
   */
  async put(area: "ram" | "disk", index: number, data: Uint8Array): Promise<void> {
    if (area === "ram") {
      await this.#putRam(index, data);
      return;
    }
    const disk = this.#cut?.disk;
    if (disk === undefined || disk === null || !disk.expected.has(index)) {
      throw new VMError("PROTOCOL_ERROR", "snapshot chunk was not requested");
    }
    if (data.byteLength !== snapshotChunkLength(index, disk.bytes)) {
      throw new VMError("STORAGE_ERROR", "snapshot chunk length is invalid");
    }
    if (disk.origin !== "core") {
      throw new VMError("PROTOCOL_ERROR", "managed disk chunks are read by the storage owner");
    }
    disk.expected.delete(index);
    const base = disk.base.get(index);
    if (allZero(data)) {
      if (base === undefined) disk.chunks.delete(index);
      else disk.chunks.set(index, { index, zero: true });
      return;
    }
    await this.#writes.add(async () => {
      const ref = await this.#objects.put(data);
      if (sameContent(ref, base)) disk.chunks.delete(index);
      else disk.chunks.set(index, { index, ...ref });
    });
  }

  async #putRam(index: number, data: Uint8Array): Promise<void> {
    const memoryBytes = this.#request.memoryBytes;
    const sealed = this.#cut !== undefined;
    if (!Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(memoryBytes / MIB) || (sealed && !this.#expectedRam.has(index))) {
      throw new VMError("PROTOCOL_ERROR", "snapshot chunk was not requested");
    }
    if (data.byteLength !== snapshotChunkLength(index, memoryBytes)) {
      throw new VMError("STORAGE_ERROR", "snapshot chunk length is invalid");
    }
    this.#expectedRam.delete(index);
    this.#sent += 1;
    const copy = this.#sent;
    this.#latestRam.set(index, copy);
    if (allZero(data)) {
      this.#ram.delete(index);
      return;
    }
    await this.#writes.add(async () => {
      const ref = await this.#objects.put(data);
      if (this.#latestRam.get(index) === copy) this.#ram.set(index, ref);
    });
  }

  /** Waits for every object write this capture started; rethrows the first that failed. */
  settled(): Promise<void> {
    return this.#writes.settled();
  }

  manifest(): SystemSnapshotManifest {
    const cut = this.#cut;
    if (cut === undefined || this.#expectedRam.size !== 0 || (cut.disk?.expected.size ?? 0) !== 0) {
      throw new VMError("STORAGE_ERROR", "snapshot capture is incomplete");
    }
    const request = this.#request;
    return {
      schema: SNAPSHOT_SCHEMA,
      id: request.snapshot.id,
      createdAt: request.snapshot.createdAt,
      kind: request.kind,
      ...(request.label === undefined ? {} : { label: request.label }),
      capturedAtUnixMs: cut.request.capturedAtUnixMs,
      parent: request.parentId ?? null,
      machine: { record: cut.machine, memoryBytes: request.memoryBytes, vcpus: request.vcpus },
      ram: sorted(this.#ram).map(([index, ref]) => ({ index, ...ref })),
      disk: manifestDisk(cut.disk),
      assets: {
        kernel: this.#boot.kernel,
        ...(this.#boot.initrd === undefined ? {} : { initrd: this.#boot.initrd }),
      },
      ...(cut.agent === undefined && cut.appData === undefined
        ? {}
        : {
            host: {
              ...(cut.agent === undefined ? {} : { agent: cut.agent }),
              ...(cut.appData === undefined ? {} : { appData: cut.appData }),
            },
          }),
      ...(this.#workspace === undefined ? {} : { workspace: this.#workspace }),
    };
  }
}

async function sealDisk(
  objects: SnapshotObjects,
  writes: CaptureWrites,
  request: SealCaptureRequest,
  boot: SnapshotBoot,
  managedDisk: ManagedDisk | undefined,
  lineage: { readonly parent: SystemSnapshotManifest | undefined; readonly changeBase: SystemSnapshotManifest | undefined },
): Promise<PendingDisk | null> {
  const parent = lineage.parent;
  const descriptor = request.disk;
  if (descriptor.kind === "none") {
    if (descriptor.bytes !== 0 || descriptor.chunks.length !== 0 || boot.disk !== null) {
      throw new VMError("STORAGE_ERROR", "snapshot disk state is inconsistent");
    }
    return null;
  }
  if (descriptor.kind === "core") {
    if (boot.disk?.origin !== "core" || descriptor.bytes !== boot.disk.bytes) {
      throw new VMError("STORAGE_ERROR", "core disk identity changed");
    }
    validateIndices(descriptor.chunks, descriptor.bytes);
    return {
      origin: "core",
      bytes: boot.disk.bytes,
      baseIdentity: boot.disk.baseIdentity,
      base: boot.disk.base,
      chunks: new Map(parent?.disk?.chunks.map((chunk) => [chunk.index, chunk]) ?? []),
      expected: new Set(descriptor.chunks),
    };
  }
  if (
    boot.disk?.origin !== "managed" ||
    managedDisk === undefined ||
    descriptor.bytes !== managedDisk.length ||
    descriptor.chunks.length !== 0
  ) {
    throw new VMError("STORAGE_ERROR", "managed disk identity changed");
  }
  // Only the chunks changed since the change base are read; the rest keep its entries. When the
  // change base cannot be loaded, the whole overlay (every change since the image) is read.
  const from = lineage.changeBase?.disk;
  const changeBase = from?.origin === "managed" && from.baseIdentity === managedDisk.identity
    && from.bytes === managedDisk.length ? from : undefined;
  // The cut: changes from here on belong to the next save, whatever happens to this one.
  const changed = managedDisk.cutChanges();
  const indices = managedDisk.changeBase === null || changeBase !== undefined ? changed : managedDisk.snapshotDirtyChunks();
  const baseChunks = new Set(managedDisk.snapshotBaseChunks());
  const chunks = new Map<number, DiskChunk>(changeBase?.chunks.map((chunk) => [chunk.index, chunk]) ?? []);
  managedDisk.flush();
  for (const index of indices) {
    const data = managedDisk.readSnapshotChunk(index);
    if (allZero(data)) {
      if (baseChunks.has(index)) chunks.set(index, { index, zero: true });
      else chunks.delete(index);
      continue;
    }
    await writes.add(async () => {
      chunks.set(index, { index, ...(await objects.put(data)) });
    });
  }
  return {
    origin: "managed",
    bytes: managedDisk.length,
    baseIdentity: managedDisk.identity,
    image: { id: managedDisk.image.id, version: managedDisk.image.version },
    chunks,
    expected: new Set(),
  };
}

function manifestDisk(disk: PendingDisk | null): SnapshotDisk | null {
  if (disk === null) return null;
  const chunks = sorted(disk.chunks).map(([, chunk]) => chunk);
  return disk.origin === "core"
    ? {
        origin: "core",
        bytes: disk.bytes,
        baseIdentity: disk.baseIdentity,
        base: sorted(disk.base).map(([index, ref]): ChunkRef => ({ index, ...ref })),
        chunks,
      }
    : { origin: "managed", bytes: disk.bytes, baseIdentity: disk.baseIdentity, image: disk.image, chunks };
}

function validateOpenRequest(request: OpenCaptureRequest): void {
  if (
    (request.label !== undefined && new TextEncoder().encode(request.label).byteLength > MAX_LABEL_BYTES) ||
    request.memoryBytes < 16 * MIB ||
    request.memoryBytes > 3072 * MIB ||
    request.memoryBytes % MIB !== 0 ||
    !Number.isSafeInteger(request.vcpus) || request.vcpus < 1 || request.vcpus > 4
  ) {
    throw new VMError("STORAGE_ERROR", "snapshot machine geometry is invalid");
  }
}

function validateSealRequest(request: SealCaptureRequest, memoryBytes: number): void {
  const record = request.machineRecord;
  if ((request.agentState?.byteLength ?? 1) === 0 || (request.agentState?.byteLength ?? 0) > MAX_AGENT_STATE_BYTES) {
    throw new VMError("STORAGE_ERROR", "snapshot agent state is invalid");
  }
  if ((request.appData?.byteLength ?? 1) === 0 || (request.appData?.byteLength ?? 0) > MAX_APP_DATA_BYTES) {
    throw new VMError("STORAGE_ERROR", "snapshot page data is invalid");
  }
  if (
    record.byteLength < 12 ||
    record.byteLength > MAX_MACHINE_RECORD_BYTES ||
    record[0] !== 0x4f ||
    record[1] !== 0x58 ||
    record[2] !== 0x4d ||
    record[3] !== 0x53
  ) {
    throw new VMError("STORAGE_ERROR", "snapshot machine record is invalid");
  }
  validateIndices(request.ramChunks, memoryBytes);
}

function sameLineage(
  parent: SystemSnapshotManifest,
  memoryBytes: number,
  boot: SnapshotBoot,
  managedDisk: ManagedDisk | undefined,
): boolean {
  if (
    parent.machine.memoryBytes !== memoryBytes ||
    !sameContent(parent.assets.kernel, boot.kernel) ||
    !sameContent(parent.assets.initrd, boot.initrd)
  ) {
    return false;
  }
  if (parent.disk === null || boot.disk === null) return parent.disk === null && boot.disk === null;
  if (boot.disk.origin === "core") {
    return parent.disk.origin === "core"
      && parent.disk.bytes === boot.disk.bytes
      && parent.disk.baseIdentity === boot.disk.baseIdentity;
  }
  return managedDisk !== undefined
    && parent.disk.origin === "managed"
    && parent.disk.bytes === managedDisk.length
    && parent.disk.baseIdentity === managedDisk.identity;
}

function validateIndices(indices: readonly number[], totalBytes: number): void {
  const chunks = Math.ceil(totalBytes / MIB);
  if (indices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= chunks)) {
    throw new VMError("STORAGE_ERROR", "snapshot chunk index is out of bounds");
  }
}

function sorted<T>(map: ReadonlyMap<number, T>): [number, T][] {
  return [...map].sort(([left], [right]) => left - right);
}

export function sameContent(left: ObjectRef | undefined, right: ObjectRef | undefined): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.bytes === right.bytes && left.sha256 === right.sha256;
}

/**
 * Whether every byte is zero. Compares 32-bit words between the unaligned head and tail: a
 * per-byte callback cost about 6 ms per MiB, the word loop about 0.13 ms.
 */
export function allZero(bytes: Uint8Array): boolean {
  const head = Math.min(bytes.byteLength, (4 - (bytes.byteOffset % 4)) % 4);
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset + head, Math.floor((bytes.byteLength - head) / 4));
  for (let index = 0; index < head; index += 1) if (bytes[index] !== 0) return false;
  for (let index = 0; index < words.length; index += 1) if (words[index] !== 0) return false;
  for (let index = head + words.length * 4; index < bytes.byteLength; index += 1) if (bytes[index] !== 0) return false;
  return true;
}

/**
 * A capture's object writes: up to WRITES_IN_FLIGHT run at once, so digests and stores overlap
 * the arrival of the next chunk. The first failure is kept, refuses further writes and is
 * reported when the writes settle.
 */
export class CaptureWrites {
  readonly #running = new Set<Promise<void>>();
  #failure: { readonly error: unknown } | undefined;

  /** Starts `write` once fewer than WRITES_IN_FLIGHT writes are running. */
  async add(write: () => Promise<void>): Promise<void> {
    while (this.#running.size >= WRITES_IN_FLIGHT) await Promise.race(this.#running);
    if (this.#failure !== undefined) throw toError(this.#failure.error);
    const running: Promise<void> = write()
      .catch((error: unknown) => {
        this.#failure ??= { error };
      })
      .finally(() => this.#running.delete(running));
    this.#running.add(running);
  }

  async settled(): Promise<void> {
    await Promise.all(this.#running);
    if (this.#failure !== undefined) throw toError(this.#failure.error);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new VMError("STORAGE_ERROR", String(error));
}
