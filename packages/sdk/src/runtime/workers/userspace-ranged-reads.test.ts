import { describe, expect, it } from "vitest";
import { UserspaceRangedReads, type VerifiedBlob } from "./userspace-ranged-reads.js";

const path = "/usr/local/lib/node_modules/big";
const digest = "cd".repeat(32);
const content = Uint8Array.from({ length: 10 }, (_value, index) => index);

function countingLoad(): { readonly loads: { count: number }; readonly load: () => Promise<VerifiedBlob> } {
  const loads = { count: 0 };
  return {
    loads,
    load: () => {
      loads.count += 1;
      return Promise.resolve({ bytes: new Uint8Array(content), sha256: digest });
    },
  };
}

describe("ranged reads of verified blobs", () => {
  it("verifies a blob once and serves every range from that copy", async () => {
    const reads = new UserspaceRangedReads();
    const { loads, load } = countingLoad();

    expect(await reads.range(path, digest, 10, 0, 3, load)).toEqual({ bytes: content.slice(0, 3), sha256: digest });
    expect(await reads.range(path, digest, 10, 3, 3, load)).toEqual({ bytes: content.slice(3, 6), sha256: digest });
    expect(loads.count).toBe(1);
  });

  it("releases the verified copy with its last range, so a later read verifies again", async () => {
    const reads = new UserspaceRangedReads();
    const { loads, load } = countingLoad();

    await reads.range(path, digest, 10, 0, 10, load);
    await reads.range(path, digest, 10, 0, 3, load);
    expect(loads.count).toBe(2);
  });

  it("shares one load between concurrent first ranges", async () => {
    const reads = new UserspaceRangedReads();
    const { loads, load } = countingLoad();

    const [first, second] = await Promise.all([
      reads.range(path, digest, 10, 0, 3, load),
      reads.range(path, digest, 10, 3, 3, load),
    ]);
    expect(first.bytes).toEqual(content.slice(0, 3));
    expect(second.bytes).toEqual(content.slice(3, 6));
    expect(loads.count).toBe(1);
  });

  it("refuses a range outside the file, a blob of another size, and a blob of another digest", async () => {
    const reads = new UserspaceRangedReads();
    const { load } = countingLoad();

    await expect(reads.range(path, digest, 10, 8, 3, load)).rejects.toThrow("outside");
    await expect(reads.range(path, digest, 12, 0, 3, load)).rejects.toThrow("length");
    await expect(
      reads.range(path, "ef".repeat(32), 10, 0, 3, load),
    ).rejects.toThrow("digest");
  });

  it("does not keep a failed load, so the next range loads again", async () => {
    const reads = new UserspaceRangedReads();
    let attempts = 0;
    const load = (): Promise<VerifiedBlob> => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("store unavailable"));
      return Promise.resolve({ bytes: new Uint8Array(content), sha256: digest });
    };

    await expect(reads.range(path, digest, 10, 0, 3, load)).rejects.toThrow("store unavailable");
    expect(await reads.range(path, digest, 10, 0, 3, load)).toEqual({ bytes: content.slice(0, 3), sha256: digest });
    expect(attempts).toBe(2);
  });

  it("clear drops every pinned copy", async () => {
    const reads = new UserspaceRangedReads();
    const { loads, load } = countingLoad();

    await reads.range(path, digest, 10, 0, 3, load);
    reads.clear();
    await reads.range(path, digest, 10, 3, 3, load);
    expect(loads.count).toBe(2);
  });
});
