import { describe, expect, it } from "vitest";

import { decodeJitArtifact } from "./system-trace-events.js";

describe("JIT trace artifacts", () => {
  it("decodes a member of a linked batch from schema 45", () => {
    const linked = { kind: "linked", batch: 3, memberIndex: 1, members: 2 };

    expect(decodeJitArtifact(linked, 45)).toEqual(linked);
    expect(decodeJitArtifact({ kind: "dynamic" }, 45)).toEqual({ kind: "dynamic" });
  });

  it("rejects linked members before schema 45 and impossible member identities", () => {
    expect(() => decodeJitArtifact({ kind: "linked", batch: 1, memberIndex: 0, members: 2 }, 44))
      .toThrow("JIT trace artifact kind is invalid");
    for (const identity of [
      { batch: 0, memberIndex: 0, members: 2 },
      { batch: 1, memberIndex: 2, members: 2 },
      { batch: 1, memberIndex: 0, members: 1 },
      { batch: 1, memberIndex: 0, members: 257 },
    ]) {
      expect(() => decodeJitArtifact({ kind: "linked", ...identity }, 45)).toThrow();
    }
    expect(() =>
      decodeJitArtifact({ kind: "linked", batch: 1, memberIndex: 0, members: 2, slot: 4 }, 45),
    ).toThrow();
  });
});
