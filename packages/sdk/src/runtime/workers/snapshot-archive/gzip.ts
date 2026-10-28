import { backupError } from "./errors.js";

/** One gzip member of `bytes`, as this engine's CompressionStream writes it. */
export async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const compressed = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

/**
 * The content of a gzip member that must expand to exactly `rawBytes` bytes. Decompression stops
 * at the first byte past `rawBytes`, so a small file cannot expand without bound.
 */
export async function gunzipExact(compressed: Uint8Array<ArrayBuffer>, rawBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const content = new Uint8Array(rawBytes);
  let produced = 0;
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read().catch(() => {
        throw backupError("damaged", "a backup chunk does not decompress");
      });
      if (done) break;
      if (value.byteLength > rawBytes - produced) {
        throw backupError("damaged", "a backup chunk is larger than declared", { stoppedAtBytes: rawBytes + 1 });
      }
      content.set(value, produced);
      produced += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (produced !== rawBytes) throw backupError("damaged", "a backup chunk is smaller than declared");
  return content;
}
