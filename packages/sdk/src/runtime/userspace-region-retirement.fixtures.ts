export type RegionPhase = 18 | 19 | 20 | 21 | 22;
export const REGION_PHASES = [[18, true], [18, false], [19, true], [20, false], [21, true], [21, false], [22, true], [22, false]] as const;

export function writeRegionFields(bytes: Uint8Array, at: number, phase: RegionPhase, user: boolean): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(at, 257, true); bytes[at + 12] = user ? 1 : 2;
  if (phase !== 22) view.setUint32(at + 8, user ? 3 : 1, true);
  if (phase === 18) {
    view.setUint32(at + 4, 257, true);
    view.setBigUint64(at + 16, 1001n, true); view.setBigUint64(at + 24, 257n, true);
  } else if (phase === 19 || phase === 20) {
    view.setUint32(at + 4, 128, true);
    if (phase === 20) {
      view.setBigUint64(at + 16, 1n << 48n, true); view.setBigUint64(at + 24, 127n * 4096n, true);
    }
  }
  if (phase === 19 || phase === 20 || phase === 21) {
    view.setBigUint64(at + 32, 57n, true); view.setBigUint64(at + 40, 92n, true);
  }
}

export function regionTrace(phase: RegionPhase, user: boolean): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 992), view = new DataView(bytes.buffer), at = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 45, true); view.setUint32(8, 992, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(at + field, 1n, true);
  view.setUint32(at + 24, 2, true); view.setUint32(at + 28, 2, true);
  view.setBigUint64(at + 40, 0x1000n, true); view.setBigUint64(at + 48, 0x1002n, true);
  view.setBigUint64(at + 56, 3n, true); bytes[at + 120] = 2; bytes[at + 123] = 4;
  for (const [field, value] of [[192, 7n], [200, 8n], [208, 99n], [216, 50n], [224, 91n]] as const) view.setBigUint64(at + field, value, true);
  bytes[at + 232] = 7; bytes[at + 233] = phase; bytes[at + 234] = phase === 22 ? 0 : 1; bytes[at + 236] = 1;
  writeRegionFields(bytes, at + 512, phase, user);
  return bytes;
}
