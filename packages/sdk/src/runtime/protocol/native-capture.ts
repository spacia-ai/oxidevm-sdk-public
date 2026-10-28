import type {SnapshotKind,SnapshotRef} from "./snapshots.js";
import { VMError } from "../errors.js";
export const NATIVE_LOGICAL_CHECKPOINT_VERSION = 99;
export const NATIVE_CHECKPOINT_FRAME_BYTES = 65536;
export function supportsNativeCheckpointVersion(version: number): boolean {
  return Number.isInteger(version) && version >= 1 && version <= NATIVE_LOGICAL_CHECKPOINT_VERSION;
}
/** The graph starts with its envelope, the fixed authorization frame and native metadata. */
export function decodeNativeGraphVersion(bytes: Uint8Array): number {
  const fail = (): never => { throw new VMError("STORAGE_ERROR", "Native checkpoint graph header is invalid"); };
  if (bytes.length < 85) fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => new TextDecoder().decode(bytes.subarray(offset, offset + 4));
  const count = view.getUint32(8, true), length = view.getUint32(73, true);
  if (tag(0) !== "OXUG" || view.getUint32(4, true) !== 1 || count < 2 || count > 4097
    || view.getUint32(12, true) !== 0 || view.getUint32(16, true) !== 49
    || tag(20) !== "OXWA" || view.getUint32(24, true) !== 1
    || view.getUint32(69, true) !== 1 || length < 8 || length > NATIVE_CHECKPOINT_FRAME_BYTES
    || 77 + length + 8 * (count - 2) > bytes.length
    || tag(77) !== "OXUC" || view.getUint16(83, true) !== 0) fail();
  const version = view.getUint16(81, true);
  if (!supportsNativeCheckpointVersion(version)) fail();
  return version;
}
export type NativeSnapshotArea="graph"|"payloads";
export interface OpenNativeCapture {readonly snapshot:SnapshotRef;readonly kind:SnapshotKind;readonly label?:string;readonly parentId?:string;readonly memoryBytes:number}
export interface SealNativeCapture {readonly capturedAtUnixMs:number;readonly graphBytes:number;readonly payloadBytes:number;readonly attachment?:Uint8Array;readonly appData?:Uint8Array}
