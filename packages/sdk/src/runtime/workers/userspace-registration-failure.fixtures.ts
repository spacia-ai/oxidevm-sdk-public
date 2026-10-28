export function putSource(view: DataView, offset: number, number: bigint, tid: number): void {
  view.setUint32(offset, 7, true); view.setUint32(offset + 4, tid, true);
  view.setBigUint64(offset + 8, 41n, true); view.setBigUint64(offset + 16, number, true);
  for (let index = 0; index < 6; index += 1) view.setBigUint64(offset + 24 + index * 8, BigInt(index + 3), true);
  view.setBigUint64(offset + 72, 0x5000n, true); view.setBigUint64(offset + 80, 0x5002n, true);
  view.setBigUint64(offset + 88, 11n, true);
}

export function record(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(256), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("OXRF")); view.setUint16(4, 1, true); view.setUint16(6, 256, true);
  putSource(view, 8, 427n, 8); view.setBigUint64(104, 51n, true);
  bytes[112] = 2; bytes[113] = 4; bytes[115] = 1; view.setInt32(116, 5, true);
  return bytes;
}

