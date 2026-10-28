import { putSource } from "./workers/userspace-registration-failure.fixtures.ts";

export function registeredCancellation(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 832), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 33, true); view.setUint32(8, 832, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 7, true); view.setUint32(offset + 28, 2, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 426n, true); view.setBigInt64(offset + 112, -125n, true);
  bytes[offset + 121] = 14; bytes[offset + 123] = 1;
  bytes.set(new TextEncoder().encode("io_uring_enter"), offset + 152);
  view.setBigUint64(offset + 192, 7n, true); view.setBigUint64(offset + 200, 9n, true);
  view.setBigUint64(offset + 208, 51n, true); view.setUint32(offset + 216, 7, true);
  view.setUint32(offset + 224, 2, true); view.setUint32(offset + 228, 1, true);
  bytes[offset + 232] = 22; bytes[offset + 233] = 1; bytes[offset + 234] = 2;
  view.setBigUint64(offset + 240, 19n, true);
  bytes[offset + 288] = 1;
  putSource(view, offset + 296, 427n, 7);
  view.setBigUint64(offset + 328, 24n, true); view.setBigUint64(offset + 336, 0x600800n, true);
  view.setBigUint64(offset + 344, 1n, true); view.setBigUint64(offset + 416, 19n, true);
  view.setBigUint64(offset + 432, 73n, true); view.setInt32(offset + 440, -1, true);
  view.setBigInt64(offset + 448, -1n, true); view.setBigInt64(offset + 456, -1n, true);
  bytes[offset + 464] = 255;
  return bytes;
}

export function registeredCancellationTaskRun(): Uint8Array<ArrayBuffer> {
  const bytes = registeredCancellation(), view = new DataView(bytes.buffer), offset = 24;
  view.setUint32(offset + 28, 7, true);
  bytes[offset + 624] = 1;
  bytes.copyWithin(offset + 632, offset + 296, offset + 392);
  return bytes;
}

export function registeredCancellationDeferredTaskRun(): Uint8Array<ArrayBuffer> {
  const bytes = registeredCancellationTaskRun(), view = new DataView(bytes.buffer), offset = 24;
  bytes[offset + 233] = 0; bytes[offset + 234] = 5;
  bytes[offset + 512] = 2;
  view.setBigUint64(offset + 520, 17n, true); view.setUint32(offset + 528, 7, true);
  return bytes;
}

export function counterCapacityWait(): Uint8Array<ArrayBuffer> {
  const bytes = registeredCancellation(), view = new DataView(bytes.buffer), offset = 24;
  bytes.fill(0, offset + 288, offset + 496);
  view.setBigInt64(offset + 112, 0n, true); bytes[offset + 120] = 2;
  bytes[offset + 232] = 23; bytes[offset + 233] = 0; bytes[offset + 234] = 3;
  view.setBigUint64(offset + 248, 57n, true); view.setUint32(offset + 256, 4, true);
  view.setBigUint64(offset + 264, 5n, true); bytes[offset + 512] = 3;
  view.setBigUint64(offset + 520, 0xffff_ffff_ffff_fffen, true);
  return bytes;
}

export function syncCancelTurn(phase: 14 | 15, reason: 2 | 3 | 4 | 5): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + 832), view = new DataView(bytes.buffer), offset = 24;
  bytes.set(new TextEncoder().encode("OXLT"));
  view.setUint16(4, 33, true); view.setUint32(8, 832, true); view.setUint32(12, 1, true);
  for (const field of [0, 8, 16, 32]) view.setBigUint64(offset + field, 1n, true);
  view.setUint32(offset + 24, 1, true); view.setUint32(offset + 28, 1, true);
  view.setBigUint64(offset + 40, 0x1000n, true); view.setBigUint64(offset + 48, 0x1002n, true);
  view.setBigUint64(offset + 56, 427n, true); view.setBigUint64(offset + 64, 3n, true);
  view.setBigUint64(offset + 72, 24n, true); view.setBigUint64(offset + 80, 0x600800n, true);
  view.setBigUint64(offset + 88, 1n, true);
  bytes[offset + 120] = 2; bytes[offset + 122] = 11;
  view.setBigUint64(offset + 128, 7n, true); view.setBigUint64(offset + 136, 10n, true);
  bytes[offset + 192] = phase; bytes[offset + 193] = reason;
  view.setUint32(offset + 196, reason === 2 ? 128 : 7, true);
  view.setBigUint64(offset + 200, reason === 2 ? 138n : 17n, true);
  return bytes;
}
