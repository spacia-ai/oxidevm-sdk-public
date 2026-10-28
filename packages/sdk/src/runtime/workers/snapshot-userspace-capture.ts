import { integer } from "../decode.js";
import { USERSPACE_API_VERSION } from "../userspace-abi.js";
import { VMError } from "../errors.js";
import { decodeSnapshotRef, validateAppData } from "../protocol/snapshots.js";
import { decodeLabel } from "./snapshot-manifest-fields.js";
import { decodeSnapshotManifest, MAX_AGENT_STATE_BYTES, SNAPSHOT_CHUNK_BYTES, USERSPACE_SNAPSHOT_SCHEMA,
  type ChunkRef, type UserspaceSnapshotManifest, type ObjectRef, type SnapshotStream } from "./snapshot-manifest.js";
import type { SnapshotObjects } from "./snapshot-objects.js";

import type {NativeSnapshotArea,OpenNativeCapture,SealNativeCapture} from "../protocol/native-capture.js";
import { decodeNativeGraphVersion } from "../protocol/native-capture.js";
interface Cut {
  readonly time: number;
  readonly graph: number;
  readonly payloads: number;
  readonly attachment?: ObjectRef;
  readonly appData?: ObjectRef;
}
const MAX_STREAM_BYTES = 16 * 1024 ** 3;

/** Storage owns opaque native streams; Rust owns the object graph and its live
 * backing index. Replaced or deleted precopy chunks cannot extend the final cut. */
export class NativeSnapshotCapture {
  readonly #objects: SnapshotObjects;
  readonly #request: OpenNativeCapture;
  readonly #rootfs: UserspaceSnapshotManifest["rootfs"];
  readonly #chunks = { graph: new Map<number, ObjectRef>(), payloads: new Map<number, ObjectRef>() };
  #cut: Cut | undefined;
  #version: number | undefined;
  #durable: UserspaceSnapshotManifest["durable"];

  constructor(objects: SnapshotObjects, request: OpenNativeCapture, rootfs: UserspaceSnapshotManifest["rootfs"]) {
    decodeSnapshotRef(request.snapshot);
    if (request.label !== undefined) decodeLabel(request.label);
    integer(request.memoryBytes, "native memory", 16 * SNAPSHOT_CHUNK_BYTES, 3072 * SNAPSHOT_CHUNK_BYTES);
    if (request.memoryBytes % SNAPSHOT_CHUNK_BYTES !== 0) invalid("Native memory size is invalid");
    this.#objects = objects;
    this.#request = request;
    this.#rootfs = rootfs;
  }

  get id(): string { return this.#request.snapshot.id; }

  async put(area: NativeSnapshotArea, index: number, data: Uint8Array): Promise<void> {
    integer(index, "native chunk index", 0, MAX_STREAM_BYTES / SNAPSHOT_CHUNK_BYTES - 1);
    const bytes = this.#cut?.[area];
    const expected = bytes === undefined ? undefined : Math.min(SNAPSHOT_CHUNK_BYTES, bytes - index * SNAPSHOT_CHUNK_BYTES);
    if (data.byteLength === 0 || data.byteLength > SNAPSHOT_CHUNK_BYTES || expected !== undefined && data.byteLength !== expected) {
      invalid("Native snapshot chunk length or index is invalid");
    }
    const version = area === "graph" && index === 0 ? decodeNativeGraphVersion(data) : undefined;
    const ref = await this.#objects.put(data);
    this.#chunks[area].set(index, ref);
    if (version !== undefined) this.#version = version;
  }

  /** Only the validated payload consolidator can carry a pinned immutable chunk forward. */
  reusePayload(index: number, ref: ObjectRef): void {
    integer(index, "native chunk index", 0, MAX_STREAM_BYTES / SNAPSHOT_CHUNK_BYTES - 1);
    if (this.#cut !== undefined || ref.bytes !== SNAPSHOT_CHUNK_BYTES) invalid("Native reused payload chunk is invalid");
    this.#chunks.payloads.set(index, ref);
  }

  async seal(request: SealNativeCapture): Promise<void> {
    if (this.#cut !== undefined) invalid("Native snapshot capture is already sealed");
    integer(request.capturedAtUnixMs, "native capture time", 0);
    integer(request.graphBytes, "native graph length", 1, MAX_STREAM_BYTES);
    integer(request.payloadBytes, "native payload length", 0, MAX_STREAM_BYTES);
    if (request.attachment !== undefined && (request.attachment.byteLength === 0 || request.attachment.byteLength > MAX_AGENT_STATE_BYTES)) {
      invalid("Native host attachment exceeds its bound");
    }
    if (request.appData !== undefined) validateAppData(request.appData);
    const attachment = request.attachment === undefined ? undefined : await this.#objects.put(request.attachment);
    const appData = request.appData === undefined ? undefined : await this.#objects.put(request.appData);
    this.#cut = { time: request.capturedAtUnixMs, graph: request.graphBytes, payloads: request.payloadBytes,
      ...(attachment === undefined ? {} : { attachment }), ...(appData === undefined ? {} : { appData }) };
    for (const area of ["graph", "payloads"] as const) {
      for (const [index, ref] of this.#chunks[area]) {
        const length = Math.min(SNAPSHOT_CHUNK_BYTES, this.#cut[area] - index * SNAPSHOT_CHUNK_BYTES);
        if (ref.bytes !== length) this.#chunks[area].delete(index);
      }
    }
  }

  setDurable(durable: UserspaceSnapshotManifest["durable"]): void { this.#durable = durable; }

  *objectRefs(): Iterable<string> {
    yield this.#rootfs.manifest.sha256;
    for (const area of ["graph", "payloads"] as const) for (const ref of this.#chunks[area].values()) yield ref.sha256;
    if (this.#cut?.attachment !== undefined) yield this.#cut.attachment.sha256;
    if (this.#cut?.appData !== undefined) yield this.#cut.appData.sha256;
    const durable = this.#durable;
    if (durable?.workspace !== undefined) {
      for (const stream of [durable.workspace.snapshot, durable.workspace.delta]) for (const ref of stream.chunks) yield ref.sha256;
      for (const ref of durable.workspace.dependencies?.tree.chunks ?? []) yield ref.sha256;
    }
    for (const ref of durable?.root?.chunks ?? []) yield ref.sha256;
  }

  manifest(): UserspaceSnapshotManifest {
    const cut = this.#cut;
    if (cut === undefined || this.#version === undefined) invalid("Native snapshot capture is incomplete");
    const request = this.#request;
    const host = { ...(cut.attachment === undefined ? {} : { attachment: cut.attachment }),
      ...(cut.appData === undefined ? {} : { appData: cut.appData }) };
    const manifest = decodeSnapshotManifest({
      schema: USERSPACE_SNAPSHOT_SCHEMA, mode: "userspace", ...request.snapshot, kind: request.kind,
      ...(request.label === undefined ? {} : { label: request.label }),
      capturedAtUnixMs: cut.time, parent: request.parentId ?? null,
      compatibility: { format: "OXUC", version: this.#version, abiVersion: USERSPACE_API_VERSION, memoryBytes: request.memoryBytes },
      graph: this.#stream("graph", cut.graph), payloads: this.#stream("payloads", cut.payloads), rootfs: this.#rootfs,
      ...(Object.keys(host).length === 0 ? {} : { host }),
      ...(this.#durable === undefined ? {} : { durable: this.#durable }),
    });
    if (manifest.schema !== USERSPACE_SNAPSHOT_SCHEMA) invalid("Native snapshot format changed during capture");
    return manifest;
  }

  #stream(area: NativeSnapshotArea, bytes: number): SnapshotStream {
    const chunks: ChunkRef[] = [];
    for (let index = 0; index < Math.ceil(bytes / SNAPSHOT_CHUNK_BYTES); index++) {
      const ref = this.#chunks[area].get(index);
      if (ref === undefined || ref.bytes !== Math.min(SNAPSHOT_CHUNK_BYTES, bytes - index * SNAPSHOT_CHUNK_BYTES)) {
        invalid("Native snapshot capture is incomplete");
      }
      chunks.push({ index, ...ref });
    }
    return { bytes, chunks };
  }
}

function invalid(message: string): never { throw new VMError("STORAGE_ERROR", message); }
