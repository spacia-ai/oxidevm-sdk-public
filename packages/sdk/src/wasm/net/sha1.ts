/**
 * SHA-1 (FIPS 180-4), only to check a WebSocket server's `Sec-WebSocket-Accept` (RFC 6455 section 4.2.2): module
 * workers run in an opaque origin, where Chromium offers no `crypto.subtle`. It is never used for integrity or security.
 */
export function sha1(message: Uint8Array): Uint8Array {
  const length = message.length, padded = new Uint8Array(((length + 8) >> 6) + 1 << 6), view = new DataView(padded.buffer);
  padded.set(message); padded[length] = 0x80;
  view.setUint32(padded.length - 8, Math.floor(length / 0x2000_0000)); view.setUint32(padded.length - 4, length * 8 >>> 0);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0], words = new Uint32Array(80);
  const rotate = (value: number, bits: number): number => (value << bits | value >>> (32 - bits)) >>> 0;
  for (let block = 0; block < padded.length; block += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(block + index * 4);
    for (let index = 16; index < 80; index++) words[index] = rotate((words[index - 3] ?? 0) ^ (words[index - 8] ?? 0) ^ (words[index - 14] ?? 0) ^ (words[index - 16] ?? 0), 1);
    let [a = 0, b = 0, c = 0, d = 0, e = 0] = state;
    for (let index = 0; index < 80; index++) {
      const [f, k] = index < 20 ? [b & c | ~b & d, 0x5a827999] : index < 40 ? [b ^ c ^ d, 0x6ed9eba1] : index < 60 ? [b & c | b & d | c & d, 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const next = (rotate(a, 5) + (f >>> 0) + e + k + (words[index] ?? 0)) >>> 0;
      e = d; d = c; c = rotate(b, 30); b = a; a = next;
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0; state[1] = ((state[1] ?? 0) + b) >>> 0; state[2] = ((state[2] ?? 0) + c) >>> 0;
    state[3] = ((state[3] ?? 0) + d) >>> 0; state[4] = ((state[4] ?? 0) + e) >>> 0;
  }
  const out = new Uint8Array(20), result = new DataView(out.buffer);
  state.forEach((word, index) => { result.setUint32(index * 4, word); });
  return out;
}
