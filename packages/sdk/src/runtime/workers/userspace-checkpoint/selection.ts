import { invalid } from "./stream.js";
/** Host-verified image/root identities; native admission retains configured policy. */
export function restoreSelection(selected: Uint8Array, recovery?: Uint8Array, root?: Uint8Array | null): Uint8Array {
  if (selected.length !== 32 || recovery !== undefined && recovery.length !== 32 || root !== undefined && root !== null && root.length !== 32) invalid("Checkpoint image or root identity is invalid");
  if (recovery === undefined && root === undefined) return selected;
  if (root === undefined) {
    const bytes = new Uint8Array(64); bytes.set(selected); bytes.set(recovery ?? selected, 32); return bytes;
  }
  const bytes = new Uint8Array(105); bytes.set(new TextEncoder().encode("OXUR")); bytes[4] = 1;
  bytes.set(selected, 8); bytes.set(recovery ?? selected, 40);
  if (root !== null) { bytes[72] = 1; bytes.set(root, 73); }
  return bytes;
}
