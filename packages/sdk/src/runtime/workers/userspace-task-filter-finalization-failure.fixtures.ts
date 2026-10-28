import { writeFilterFields, type FilterPhase } from "../userspace-filter-retirement.fixtures.ts";
import { poolFinalizationFailure } from "./userspace-pool-finalization-failure.fixtures.ts";

export function taskFilterFailure(phase: FilterPhase): Uint8Array<ArrayBuffer> {
  const bytes = poolFinalizationFailure(1),view = new DataView(bytes.buffer);
  view.setUint16(4,10,true);view.setBigUint64(24,1n << 48n,true);
  bytes[16] = phase === 35 ? 11 : 10;bytes[18] = 3;
  bytes[184] = 9;bytes[185] = phase;bytes[186] = phase === 34 || phase === 35 ? 0 : 1;
  bytes.fill(0,192,320);writeFilterFields(bytes,208,phase);return bytes;
}
