import { poolRetirementProgress } from "./userspace-pool-retirement.fixtures.ts";

export function poolFinalizationTrace(kind: 1 | 2 | 3, inherited = false, seccomp = false): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 992), view = new DataView(bytes.buffer), at = 24;
  bytes.set(new TextEncoder().encode("OXLT"));view.setUint16(4, 49, true);
  view.setUint32(8, 992, true);view.setUint32(12, 1, true);
  for (const [offset, value] of [[0, 1n], [8, 1n], [16, 1n], [32, 1n], [40, 0x1000n], [48, 0x1002n], [56, 60n],
    [192, 11n], [200, 2n], [208, 99n], [216, 50n], [224, 41n]] as const) view.setBigUint64(at + offset, value, true);
  view.setUint32(at + 24, 1, true);view.setUint32(at + 28, 2, true);
  bytes[at + 120] = kind === 3 ? 4 : 2;bytes[at + 121] = 4;bytes[at + 123] = 6;
  bytes.set(new TextEncoder().encode("exit"), at + 152);
  bytes[at + 235] = kind === 3 ? 1 : 0;bytes[at + 236] = 1;
  view.setUint32(at + 248, 1, true);bytes[at + 512] = inherited ? 2 : 1;
  if (inherited) { view.setBigUint64(at + 520, 11n, true);view.setBigUint64(at + 528, 7n, true); }
  if (seccomp) bytes[at + 272] = 1;
  bytes.set(poolRetirementProgress(kind, kind === 2), at + 544);
  return bytes;
}
