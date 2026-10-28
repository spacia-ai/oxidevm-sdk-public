import { filterTrace } from "./userspace-filter-retirement.fixtures.ts";

export function writeWorkerBindingFields(bytes: Uint8Array, at: number, metadata: boolean): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.fill(0, at, at + 48);
  view.setBigUint64(at, 11n, true); view.setBigUint64(at + 8, 91n, true);
  view.setUint16(at + 32, 257, true); view.setUint16(at + 34, metadata ? 25 : 1, true);
  if (metadata) {
    view.setBigUint64(at + 16, 57n, true); view.setBigUint64(at + 24, 92n, true);
    bytes[at + 36] = 1; view.setBigUint64(at + 40, 1n, true);
  }
}

export function workerBindingTrace(metadata: boolean): Uint8Array<ArrayBuffer> {
  const bytes = filterTrace(31), view = new DataView(bytes.buffer), at = 24;
  view.setUint16(4, 48, true); bytes[at + 232] = 10; bytes[at + 233] = 36;
  writeWorkerBindingFields(bytes, at + 512, metadata);
  return bytes;
}

export function workerBindingFailure(metadata: boolean): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(256), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OXFF")); view.setUint16(4, 8, true); view.setUint16(6, 256, true);
  view.setBigUint64(8, 99n, true); bytes[16] = 2; bytes[17] = 1; bytes[18] = 1; view.setInt32(20, 5, true);
  for (const [field, value] of [[24, 7n], [32, 8n], [40, 91n], [64, 50n], [88, 3n],
    [144, 0x1000n], [152, 0x1002n], [160, 1n]] as const) view.setBigUint64(field, value, true);
  bytes[48] = 1; view.setUint32(52, 2, true); view.setUint32(56, 2, true);
  bytes[184] = 10; bytes[185] = 36; bytes[186] = 1;
  writeWorkerBindingFields(bytes, 208, metadata);
  return bytes;
}
