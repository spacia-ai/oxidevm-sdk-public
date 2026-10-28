import { VMError } from "./errors.js";

export interface UserspaceWorkspaceExport {
  readonly id: bigint;
  readonly bytes: number;
}
export function decodeUserspaceWorkspaceCapture(bytes: Uint8Array): UserspaceWorkspaceExport & { readonly kind: "snapshot" | "delta" } {
  if (bytes.length !== 24 || bytes[4] !== 2 || bytes[5] !== 0 || bytes[6] !== 0 && bytes[6] !== 1 || bytes[7] !== 0) invalid();
  const copy = bytes.slice(); copy[4] = 1; copy[6] = 0;
  return { ...decodeUserspaceWorkspaceExport(copy), kind: bytes[6] === 0 ? "snapshot" : "delta" };
}

export function decodeUserspaceWorkspaceExport(bytes: Uint8Array): UserspaceWorkspaceExport {
  const invalidWorkspace = (): never => {
    throw new VMError("PROTOCOL_ERROR", "Invalid Userspace workspace transfer record");
  };
  if (bytes.length !== 24) invalidWorkspace();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x4f585750
    || view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0) invalidWorkspace();
  const id = view.getBigUint64(8, true);
  const length = view.getBigUint64(16, true);
  if (id === 0n || length < 12n || length > 1024n ** 4n) invalidWorkspace();
  return { id, bytes: Number(length) };
}

export interface UserspaceRootExport {
  readonly id: bigint;
  readonly bytes: number;
  readonly revision: bigint;
}

export function decodeUserspaceRootExport(bytes: Uint8Array): UserspaceRootExport {
  if (bytes.length !== 32) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x4f585250
    || view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 0) invalid();
  const id = view.getBigUint64(8, true);
  const length = view.getBigUint64(16, true);
  const revision = view.getBigUint64(24, true);
  if (id === 0n || length === 0n || length > 1024n ** 4n
    || revision === 0xffff_ffff_ffff_ffffn) invalid();
  return { id, bytes: Number(length), revision };
}

function invalid(): never {
  throw new VMError("PROTOCOL_ERROR", "Invalid Userspace root transfer record");
}
