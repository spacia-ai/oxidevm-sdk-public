import { poolFinalizationTrace } from "./userspace-pool-finalization-trace.fixtures.ts";
import { writeFilterFields, type FilterPhase } from "./userspace-filter-retirement.fixtures.ts";

export function taskFilterTrace(phase: FilterPhase): Uint8Array<ArrayBuffer> {
  const bytes = poolFinalizationTrace(1), view = new DataView(bytes.buffer), at = 24;
  view.setUint16(4,50,true);view.setBigUint64(at + 192,1n << 48n,true);
  bytes.fill(0,at + 512,at + 624);bytes[at + 123] = 7;
  bytes[at + 232] = 9;bytes[at + 233] = phase;bytes[at + 234] = phase === 34 || phase === 35 ? 0 : 1;
  bytes[at + 120] = phase === 35 ? 4 : 2;bytes[at + 235] = phase === 35 ? 1 : 0;
  writeFilterFields(bytes,at + 512,phase);return bytes;
}
