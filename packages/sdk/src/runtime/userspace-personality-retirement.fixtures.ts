import { regionTrace } from "./userspace-region-retirement.fixtures.ts";

export type PersonalityPhase = 23 | 24 | 25 | 26 | 27 | 28 | 29;
export const PERSONALITY_PHASES = [23, 24, 25, 26, 27, 28, 29] as const;

export function personalityTrace(phase: PersonalityPhase): Uint8Array<ArrayBuffer> {
  const bytes = regionTrace(22, false), view = new DataView(bytes.buffer), at = 24;
  view.setUint16(4, 46, true);
  bytes[at + 232] = 8; bytes[at + 233] = phase;
  bytes[at + 234] = phase === 26 || phase === 29 ? 0 : 1;
  bytes.fill(0, at + 512, at + 560);
  writePersonalityFields(bytes, at + 512, phase);
  return bytes;
}

export function writePersonalityFields(bytes: Uint8Array, at: number, phase: PersonalityPhase): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (phase <= 26) view.setBigUint64(at, 7n, true);
  if (phase >= 24 && phase <= 26) view.setUint32(at + 12, 65536, true);
  if (phase === 23) {
    view.setUint32(at + 8, 257, true); view.setUint32(at + 12, 257, true); view.setUint16(at + 16, 3, true);
  } else if (phase === 24) {
    view.setUint32(at + 8, 1, true); view.setUint32(at + 20, 65, true);
  } else if (phase === 25) view.setUint32(at + 8, 64, true);
  else if (phase === 27) {
    view.setUint32(at + 8, 2, true); view.setUint16(at + 16, 5, true); view.setUint16(at + 18, 7, true);
  } else if (phase === 28) {
    view.setUint32(at + 8, 5, true); view.setUint32(at + 12, 5, true);
  }
  if (phase === 25 || phase === 28) {
    view.setBigUint64(at + 24, 57n, true); view.setBigUint64(at + 32, 92n, true);
  }
}
