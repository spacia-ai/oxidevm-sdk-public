import { expect, it, vi } from "vitest";
import { readStorageObjects } from "./storage-read-batch.js";

it("bounds verification by both eight objects and eight MiB, admitting a large object alone", async () => {
  for (const sizes of [Array<number>(20).fill(1024 ** 2), [5 * 1024 ** 2, 5 * 1024 ** 2, 1], [20 * 1024 ** 2, 1]]) {
    let active = 0, bytes = 0, peak = 0, peakBytes = 0;
    await readStorageObjects(sizes.map(bytes => ({ bytes })), async object => {
      active++; bytes += object.bytes; peak = Math.max(peak, active); peakBytes = Math.max(peakBytes, bytes);
      await Promise.resolve();
      active--; bytes -= object.bytes;
    });
    expect(peak).toBeLessThanOrEqual(8);
    expect(peakBytes).toBeLessThanOrEqual(Math.max(8 * 1024 ** 2, ...sizes));
    if (sizes[0] === 20 * 1024 ** 2) expect(peak).toBe(1);
  }
});

it("settles every admitted read before reporting a verification failure", async () => {
  const release = Promise.withResolvers<undefined>(), failure = new Error("invalid hash");
  let ended = false;
  const read = readStorageObjects([{ bytes: 1, index: 0 }, { bytes: 1, index: 1 }], object => {
    if (object.index === 0) throw failure;
    return release.promise;
  });
  void read.then(() => { ended = true; }, () => { ended = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(ended).toBe(false);
  release.resolve(undefined);
  await expect(read).rejects.toBe(failure);
});

it("replenishes finished reads while one earlier object is still pending", async () => {
  const release = Promise.withResolvers<undefined>();
  const started: number[] = [];
  const reading = readStorageObjects(Array.from({ length: 16 }, (_, index) => ({ bytes: 1, index })), async object => {
    started.push(object.index);
    if (object.index === 0) await release.promise;
  });
  try { await vi.waitFor(() => expect(started).toContain(8), { timeout: 100 }); }
  finally { release.resolve(undefined); await reading; }
});

it("uses thirty-two acquisition slots without exceeding the existing byte window", async () => {
  const release = Promise.withResolvers<undefined>();
  let count = 0, bytes = 0;
  const reading = readStorageObjects(Array.from({ length: 40 }, () => ({ bytes: 128 * 1024 })), async object => {
    count++; bytes += object.bytes;
    await release.promise;
    count--; bytes -= object.bytes;
  }, undefined, 32);
  try {
    await vi.waitFor(() => expect(count).toBe(32), { timeout: 100 });
    expect(bytes).toBeLessThanOrEqual(8 * 1024 ** 2);
  } finally { release.resolve(undefined); await reading; }
});

it("drains admitted reads on cancellation without scheduling another object", async () => {
  const controller = new AbortController(), release = Promise.withResolvers<undefined>();
  const started: number[] = [];
  const reading = readStorageObjects(Array.from({ length: 16 }, (_, index) => ({ bytes: 1, index })), async object => {
    started.push(object.index);
    if (object.index === 0) controller.abort();
    await release.promise;
  }, controller.signal);
  const rejected = expect(reading).rejects.toMatchObject({ code: "ABORTED" });
  await vi.waitFor(() => expect(started).toHaveLength(8));
  release.resolve(undefined);
  await rejected;
  expect(started).toHaveLength(8);
});

it("stops admission after a failure and drains every other in-flight read", async () => {
  const release = Promise.withResolvers<undefined>(), failure = new Error("invalid object");
  const started: number[] = [];
  const reading = readStorageObjects(Array.from({ length: 16 }, (_, index) => ({ bytes: 1, index })), async object => {
    started.push(object.index);
    if (object.index === 0) throw failure;
    await release.promise;
  });
  let finished = false;
  void reading.then(() => { finished = true; }, () => { finished = true; });
  const rejected = expect(reading).rejects.toBe(failure);
  await vi.waitFor(() => expect(started).toHaveLength(8));
  expect(finished).toBe(false);
  release.resolve(undefined);
  await rejected;
  expect(started).toHaveLength(8);
});
