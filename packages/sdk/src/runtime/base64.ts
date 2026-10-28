/** Decode large embedded runtime assets without one protected callback per byte. */
export function decodeRuntimeBase64(source: string): Uint8Array<ArrayBuffer> {
  const native: unknown = Reflect.get(Uint8Array, "fromBase64");
  if (typeof native === "function") {
    const bytes: unknown = Reflect.apply(native, Uint8Array, [source]);
    if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) throw new TypeError("Base64 decoder returned invalid bytes");
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  const text = atob(source), length = text.length, byteAt = text.charCodeAt.bind(text), bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = byteAt(index);
  return bytes;
}
