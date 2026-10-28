import { invalid } from "./stream.js";
export interface CheckpointPayloadDeclaration { readonly reference: bigint; readonly kind: 0n | 1n; readonly length: bigint }
/** The shared native/SDK declaration format. IDs are sorted and scoped to one capture. */
export function decodeCheckpointDeclaration(bytes: Uint8Array, previous: bigint): CheckpointPayloadDeclaration {
  if (bytes.length !== 24) invalid("Checkpoint declaration length is invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const reference = view.getBigUint64(0, true), kind = view.getBigUint64(8, true), length = view.getBigUint64(16, true);
  if (reference <= previous || kind !== 0n && kind !== 1n || kind === 1n && length !== 4096n || length > 1024n ** 3n) invalid("Checkpoint payload declaration is invalid");
  return { reference, kind, length };
}
export function encodeCheckpointDeclaration(declaration: CheckpointPayloadDeclaration): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24), view = new DataView(bytes.buffer);
  view.setBigUint64(0, declaration.reference, true); view.setBigUint64(8, declaration.kind, true); view.setBigUint64(16, declaration.length, true);
  decodeCheckpointDeclaration(bytes, 0n); return bytes;
}
