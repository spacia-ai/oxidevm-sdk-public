import { expect, it } from "vitest";
import { orderedDownloads } from "./ordered-downloads.js";

/** A fetch whose downloads finish only when the test says so, or fail when their signal aborts. */
function controlled() {
  const pending = new Map<number, { readonly resolve: (value: string) => void; readonly reject: (error: unknown) => void }>();
  const started: number[] = [], signals: AbortSignal[] = [];
  const fetch = (key: number, signal: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
    started.push(key); signals.push(signal);
    pending.set(key, { resolve, reject });
    signal.addEventListener("abort", () => { pending.delete(key); reject(new Error(`aborted ${String(key)}`)); }, { once: true });
  });
  const finish = (key: number): void => { pending.get(key)?.resolve(`value ${String(key)}`); pending.delete(key); };
  const fail = (key: number, error: unknown): void => { pending.get(key)?.reject(error); pending.delete(key); };
  return { fetch, finish, fail, started, signals, pending };
}

const turns = async (count = 3): Promise<void> => { for (let turn = 0; turn < count; turn++) await Promise.resolve(); };

it("keeps at most the given number of downloads ahead of the reader, and returns each by its key", async () => {
  const server = controlled(), downloads = orderedDownloads([0, 1, 2, 3, 4, 5], server.fetch, 3, new AbortController().signal);
  await turns();
  expect(server.started).toEqual([0, 1, 2]);
  // Finished out of order: the reader still gets each key's own value.
  server.finish(2); server.finish(1); server.finish(0);
  await turns();
  expect(server.started).toEqual([0, 1, 2]);
  await expect(downloads.take(0)).resolves.toBe("value 0");
  await turns();
  expect(server.started).toEqual([0, 1, 2, 3]);
  await expect(downloads.take(1)).resolves.toBe("value 1");
  await expect(downloads.take(2)).resolves.toBe("value 2");
  await turns();
  expect(server.started).toEqual([0, 1, 2, 3, 4, 5]);
  expect(server.pending.size).toBe(3);
  for (const key of [3, 4, 5]) server.finish(key);
  for (const key of [3, 4, 5]) await expect(downloads.take(key)).resolves.toBe(`value ${String(key)}`);
  await downloads.close();
});

it("holds a taken download's slot until it finishes", async () => {
  const server = controlled(), downloads = orderedDownloads([0, 1, 2], server.fetch, 2, new AbortController().signal);
  await turns();
  const taken = downloads.take(0);
  await turns();
  expect(server.started).toEqual([0, 1]);
  server.finish(0);
  await expect(taken).resolves.toBe("value 0");
  await turns();
  expect(server.started).toEqual([0, 1, 2]);
  server.finish(1); server.finish(2);
  await downloads.close();
});

it("fetches a key outside the plan on its own", async () => {
  const server = controlled(), downloads = orderedDownloads([0], server.fetch, 1, new AbortController().signal);
  const taken = downloads.take(9);
  await turns();
  expect(server.started).toEqual([0, 9]);
  server.finish(9);
  await expect(taken).resolves.toBe("value 9");
  server.finish(0);
  await downloads.close();
});

it("cancels every other download on the first failure, and every later take throws that failure", async () => {
  const server = controlled(), downloads = orderedDownloads([0, 1, 2, 3, 4], server.fetch, 4, new AbortController().signal);
  await turns();
  const first = downloads.take(0), failure = new Error("chunk 2 is damaged");
  server.fail(2, failure);
  await expect(first).rejects.toBe(failure);
  expect(server.signals.every(signal => signal.aborted)).toBe(true);
  await expect(downloads.take(1)).rejects.toBe(failure);
  await downloads.close();
  // Nothing new starts once a download failed.
  expect(server.started).toEqual([0, 1, 2, 3]);
});

it("cancels every download when the caller aborts, and close waits until all have settled", async () => {
  const controller = new AbortController(), server = controlled();
  const downloads = orderedDownloads([0, 1, 2, 3], server.fetch, 4, controller.signal);
  await turns();
  const taken = downloads.take(0);
  controller.abort();
  await expect(taken).rejects.toThrow("aborted 0");
  await downloads.close();
  expect(server.signals).toHaveLength(4);
  expect(server.signals.every(signal => signal.aborted)).toBe(true);
  expect(server.pending.size).toBe(0);
});

it("cancels what the reader left untaken when it closes", async () => {
  const server = controlled(), downloads = orderedDownloads([0, 1, 2], server.fetch, 2, new AbortController().signal);
  await turns();
  await downloads.close();
  expect(server.signals.every(signal => signal.aborted)).toBe(true);
  expect(server.started).toEqual([0, 1]);
});
