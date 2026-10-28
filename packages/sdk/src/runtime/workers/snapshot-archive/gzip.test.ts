import { describe, expect, it } from "vitest";

import { sha256Hex } from "../snapshot-content.js";
import { gunzipExact, gzip } from "./gzip.js";

const KIB = 1024;
const MIB = 1024 * KIB;

/** A copy of `bytes` with every bit of byte `index` inverted. */
function inverted(bytes: Uint8Array<ArrayBuffer>, index: number): Uint8Array<ArrayBuffer> {
  const copy = bytes.slice();
  copy[index] = (copy[index] ?? 0) ^ 0xff;
  return copy;
}

async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("backup chunk compression", () => {
  it("round-trips a chunk, and compresses the same bytes the same way", async () => {
    const bytes = new Uint8Array(MIB).map((_, index) => (index * 7) % 256);

    const compressed = await gzip(bytes);

    expect(await sha256Hex(await gunzipExact(compressed, bytes.byteLength))).toBe(await sha256Hex(bytes));
    expect(await sha256Hex(await gzip(bytes))).toBe(await sha256Hex(compressed));
  });

  it("stops a gzip bomb at the first byte past the declared size", async () => {
    const bomb = await gzip(new Uint8Array(MIB));
    expect(bomb.byteLength).toBeLessThanOrEqual(2 * KIB);

    const error = await refusal(() => gunzipExact(bomb, 4 * KIB));

    expect(error).toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "backup-damaged", stoppedAtBytes: 4 * KIB + 1 } });
  });

  it("refuses content shorter than declared, damaged, cut short, or not gzip at all", async () => {
    const bytes = new Uint8Array(64 * KIB).map((_, index) => index % 13);
    const compressed = await gzip(bytes);
    const flipped = inverted(compressed, Math.floor(compressed.byteLength / 2));
    const tail = inverted(compressed, compressed.byteLength - 1);

    for (const [label, run] of [
      ["shorter", () => gunzipExact(compressed, bytes.byteLength + 1)],
      ["damaged", () => gunzipExact(flipped, bytes.byteLength)],
      ["bad trailer", () => gunzipExact(tail, bytes.byteLength)],
      ["cut short", () => gunzipExact(compressed.slice(0, compressed.byteLength - 4), bytes.byteLength)],
      ["not gzip", () => gunzipExact(new Uint8Array([1, 2, 3, 4]), 4)],
    ] as const) {
      expect(await refusal(run), label).toMatchObject({ detail: { reason: "backup-damaged" } });
    }
  });
});
