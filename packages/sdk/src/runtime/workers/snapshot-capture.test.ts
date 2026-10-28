import { describe, expect, it } from "vitest";

import { VMError } from "../errors.js";
import { allZero, CaptureWrites } from "./snapshot-capture.js";

async function failure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("capture writes", () => {
  it("keeps four writes in flight and admits the next as one lands", async () => {
    const writes = new CaptureWrites();
    const release: (() => void)[] = [];
    const started: number[] = [];
    const write = (index: number) => () => {
      started.push(index);
      return new Promise<void>((resolve) => release.push(resolve));
    };
    for (const index of [0, 1, 2, 3]) await writes.add(write(index));

    const fifth = writes.add(write(4));
    expect(started).toEqual([0, 1, 2, 3]);
    release.shift()?.();
    await fifth;

    expect(started).toEqual([0, 1, 2, 3, 4]);
    let settled = false;
    const all = writes.settled().then(() => {
      settled = true;
    });
    for (const open of release.splice(0, 3)) open();
    await Promise.resolve();
    expect(settled).toBe(false);
    release.shift()?.();
    await all;
  });

  it("reports a failed write when the writes settle and refuses more", async () => {
    const writes = new CaptureWrites();
    const quota = new VMError("QUOTA_EXCEEDED", "storage is full");
    await writes.add(() => Promise.reject(quota));

    expect(await failure(writes.settled())).toBe(quota);
    expect(await failure(writes.add(() => Promise.resolve()))).toBe(quota);
  });
});

describe("zero chunk detection", () => {
  it("finds a single non-zero byte anywhere, including an unaligned view's last byte", () => {
    const bytes = new Uint8Array(4099);
    expect(allZero(bytes)).toBe(true);
    expect(allZero(bytes.subarray(1))).toBe(true);
    for (const index of [0, 1, 7, 4096, 4098]) {
      bytes.fill(0);
      bytes[index] = 1;
      expect(allZero(bytes)).toBe(false);
      expect(allZero(bytes.subarray(1))).toBe(index === 0);
    }
  });
});
