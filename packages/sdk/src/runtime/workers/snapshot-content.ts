/**
 * Content identity in the snapshot store and its archives: an object is named by the SHA-256 of
 * its bytes in lowercase hex. Kept apart from the OPFS object store so the archive codecs can use
 * it in workers and in Node alike.
 */

/** `bytes` itself when it views a whole ArrayBuffer, otherwise a copy that does. */
export function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buffer = bytes.buffer;
  return buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength
    ? new Uint8Array(buffer)
    : bytes.slice();
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** `bytes` in lowercase hex. */
export function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
