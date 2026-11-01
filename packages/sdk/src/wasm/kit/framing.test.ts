import { expect, it } from "vitest";
import { VMError } from "../../runtime/errors.js";
import { readExactly, readFrame, writeFrame } from "./framing.js";

/** A source that yields the given chunks, each no longer than the requested size, then ends. */
function source(...chunks: readonly number[][]) {
  const queue = chunks.map(chunk => Uint8Array.from(chunk));
  return {
    reads: [] as number[],
    read(maxBytes: number): Promise<Uint8Array> {
      this.reads.push(maxBytes);
      const next = queue.shift();
      if (next === undefined) return Promise.resolve(new Uint8Array());
      if (next.length <= maxBytes) return Promise.resolve(next);
      queue.unshift(next.subarray(maxBytes));
      return Promise.resolve(next.subarray(0, maxBytes));
    },
  };
}

it("assembles an exact read from short chunks and asks only for what is missing", async () => {
  const input = source([1], [2, 3], [4, 5, 6]);
  expect(Array.from(await readExactly(input, 5))).toEqual([1, 2, 3, 4, 5]);
  expect(input.reads).toEqual([5, 4, 2]);
  expect(await readExactly(source(), 0)).toEqual(new Uint8Array());
});

it("rejects a stream that ends early or returns more than was asked", async () => {
  await expect(readExactly(source([1, 2]), 3)).rejects.toMatchObject({ code: "PROTOCOL_ERROR", detail: { reason: "wasm-module-frame" } });
  const greedy = { read: () => Promise.resolve(new Uint8Array(9)) };
  await expect(readExactly(greedy, 4)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  for (const size of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) await expect(readExactly(source(), size), String(size)).rejects.toBeInstanceOf(VMError);
});

it("reads one big-endian length-prefixed frame and leaves the next frame unread", async () => {
  const input = source([0, 0, 0, 3, 7, 8], [9, 0, 0, 0, 1, 42]);
  expect(Array.from(await readFrame(input, 16))).toEqual([7, 8, 9]);
  expect(Array.from(await readFrame(input, 16))).toEqual([42]);
});

it("refuses an oversized frame before reading its payload", async () => {
  const input = source([0, 0, 1, 0], [1, 2, 3]);
  await expect(readFrame(input, 255)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(input.reads).toEqual([4]);
  await expect(readFrame(source([0xff, 0xff, 0xff, 0xff]), 1024)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await expect(readFrame(source([0, 0, 0, 2, 1]), 16)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
});

it("writes the header and payload in one write and enforces the same limit", async () => {
  const written: Uint8Array[] = [];
  const sink = { write: (bytes: Uint8Array) => { written.push(bytes); return Promise.resolve(); } };
  await writeFrame(sink, Uint8Array.of(1, 2, 3), 8);
  expect(written.map(bytes => Array.from(bytes))).toEqual([[0, 0, 0, 3, 1, 2, 3]]);
  await writeFrame(sink, new Uint8Array(), 8);
  expect(Array.from(written[1] ?? [])).toEqual([0, 0, 0, 0]);
  await expect(writeFrame(sink, new Uint8Array(9), 8)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(written).toHaveLength(2);
});
