import { writeWorkerBindingFields } from "./userspace-worker-binding-retirement.fixtures.ts";

export function poolRetirementProgress(kind: 1 | 2 | 3, metadata = false): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(80), view = new DataView(bytes.buffer);
  bytes[0] = kind;
  if (kind === 1) { bytes[1] = 15;view.setBigUint64(8, 7n, true);view.setBigUint64(16, 8n, true); }
  if (kind === 2) { view.setBigUint64(8, 7n, true);writeWorkerBindingFields(bytes, 24, metadata); }
  if (kind === 3) { view.setBigUint64(24, 11n, true);view.setBigUint64(32, 91n, true);view.setBigUint64(40, 1n, true); }
  return bytes;
}
