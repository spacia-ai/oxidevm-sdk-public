import { describe, expect, it } from "vitest";

import { compareAotPackPriority } from "./aot-runtime.js";

describe("AOT prewarm priority", () => {
  it("compiles the hottest pack within a phase before colder content", () => {
    const packs = [
      { phase: "first-request" as const, score: 100, sha256: "a".repeat(64) },
      { phase: "ready" as const, score: 10, sha256: "b".repeat(64) },
      { phase: "ready" as const, score: 50, sha256: "c".repeat(64) },
    ];

    expect(packs.toSorted(compareAotPackPriority).map((pack) => pack.sha256[0])).toEqual([
      "c",
      "b",
      "a",
    ]);
  });
});
