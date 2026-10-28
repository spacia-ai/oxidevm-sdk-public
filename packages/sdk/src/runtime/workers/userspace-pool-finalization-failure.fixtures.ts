import { poolRetirementProgress } from "../userspace-pool-retirement.fixtures.ts";

export function poolFinalizationFailure(kind: 1 | 2 | 3, inherited = false): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(320), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OXFF"));view.setUint16(4, 9, true);view.setUint16(6, 320, true);
  view.setBigUint64(8, 99n, true);bytes[16] = kind === 3 ? 7 : 6;bytes[17] = 1;bytes[18] = 2;view.setInt32(20, 5, true);
  for (const [offset, value] of [[24, 11n], [32, 2n], [40, 41n], [64, 50n], [88, 60n], [144, 0x1000n], [152, 0x1002n], [160, 1n]] as const) view.setBigUint64(offset, value, true);
  bytes[48] = 1;view.setUint32(52, 1, true);view.setUint32(56, 2, true);view.setUint32(188, 1, true);
  bytes[184] = inherited ? 2 : 1;
  if (inherited) { view.setBigUint64(272, 11n, true);view.setBigUint64(280, 7n, true); }
  bytes.set(poolRetirementProgress(kind, kind === 2), 192);
  return bytes;
}
