import { personalityTrace } from "./userspace-personality-retirement.fixtures.ts";
export const FILTER_PHASES = [30, 31, 32, 33, 34, 35] as const;
export type FilterPhase = (typeof FILTER_PHASES)[number];

export function filterTrace(phase: FilterPhase): Uint8Array<ArrayBuffer> {
  const bytes = personalityTrace(29), view = new DataView(bytes.buffer), at = 24;
  view.setUint16(4, 47, true);
  bytes[at + 232] = 9; bytes[at + 233] = phase;
  bytes[at + 234] = phase === 34 || phase === 35 ? 0 : 1;
  writeFilterFields(bytes, at + 512, phase);
  return bytes;
}

export function writeFilterFields(bytes: Uint8Array, at: number, phase: FilterPhase): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.fill(0, at, at + 48);
  if (phase !== 35) {
    view.setBigUint64(at, 1n << 48n, true);
    view.setBigUint64(at + 8, (1n << 48n) + 4096n, true);
    view.setUint16(at + 32, 4096, true);
  }
  if (phase === 30 || phase === 32) view.setBigUint64(at + 16, 257n, true);
  if (phase === 33) {
    view.setBigUint64(at + 16, 57n, true); view.setBigUint64(at + 24, 92n, true);
    bytes[at + 35] = 9; view.setBigUint64(at + 40, 32768n, true);
  }
}
