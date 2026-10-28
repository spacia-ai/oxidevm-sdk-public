/** The core's fixed eight-byte entropy capability. No guest instruction policy lives here. */
export function createCoreEntropyImport(
  memory: () => WebAssembly.Memory | undefined,
  fill: (bytes: Uint8Array<ArrayBuffer>) => void = bytes => { globalThis.crypto.getRandomValues(bytes); },
): (pointer: number, length: number) => number {
  return (pointer, length) => {
    const active = memory();
    if (active === undefined || length !== 8 || !Number.isInteger(pointer)
      || pointer < -0x8000_0000 || pointer > 0xffff_ffff) return 1;
    const start = pointer < 0 ? pointer + 0x1_0000_0000 : pointer;
    if (start > active.buffer.byteLength - 8) return 1;
    try {
      const bytes = new Uint8Array(8);
      fill(bytes);
      new Uint8Array(active.buffer, start, 8).set(bytes);
      return 0;
    } catch {
      return 1;
    }
  };
}
