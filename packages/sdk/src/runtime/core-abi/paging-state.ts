import { fault, type BinaryCursor } from "./cursor.ts";

export type CorePaePdpte = readonly [bigint, bigint, bigint, bigint] | null;

/** PAE roots are latched registers; changed PDPT memory does not replace them. */
export function decodePaePdpte(cursor: BinaryCursor, version: number): CorePaePdpte {
  if (version < 7) return null;
  const loaded = cursor.u8();
  if (loaded !== 0 && loaded !== 1) throw fault("CPU snapshot has invalid PAE PDPTE loaded flag");
  cursor.zero(7, "PAE PDPTE reserved field");
  const entries = [cursor.u64(), cursor.u64(), cursor.u64(), cursor.u64()] as const;
  if (entries.some(entry => (entry & 1n) !== 0n && (entry & 0xfff0_0000_0000_01e6n) !== 0n)
    || loaded === 0 && entries.some(entry => entry !== 0n)) {
    throw fault("CPU snapshot has invalid PAE PDPTE state");
  }
  return loaded === 1 ? entries : null;
}
