import { describe, expect, it } from "vitest";

import {
  appendBoundedRing,
  createBoundedRing,
  readBoundedRing,
  resetBoundedRing,
} from "./bounded-ring.js";

describe("bounded ring", () => {
  it("retains the newest values in chronological order", () => {
    const ring = createBoundedRing<number>();
    for (const value of [1, 2, 3, 4, 5]) {
      appendBoundedRing(ring, 3, value);
    }
    expect(readBoundedRing(ring)).toEqual([3, 4, 5]);
    expect(ring.dropped).toBe(2);
  });

  it("resets values and counters", () => {
    const ring = createBoundedRing<number>();
    appendBoundedRing(ring, 1, 1);
    appendBoundedRing(ring, 1, 2);
    resetBoundedRing(ring);
    expect(readBoundedRing(ring)).toEqual([]);
    expect(ring).toEqual({ values: [], start: 0, dropped: 0 });
  });
});
