import { describe, expect, it } from "vitest";

import { EMPTY_CORE_RUNTIME_PROFILE } from "./system-trace-core-profile.js";
import { jitChainProfileReconciles } from "./system-trace-profile.js";

describe("JIT chain profile", () => {
  const chain = {
    ...EMPTY_CORE_RUNTIME_PROFILE,
    jitChainAttempts: 12n,
    jitChainHits: 4n,
    jitChainMissingCoverage: 1n,
    jitChainMissingCache: 1n,
    jitChainMissingDispatchSlot: 1n,
    jitChainMissingEntry: 1n,
    jitChainInvalidCode: 1n,
    jitChainContextFailures: 1n,
    jitChainMissingCompilePending: 2n,
  };

  it("accounts for every chain attempt, including misses on translations still compiling", () => {
    expect(jitChainProfileReconciles(chain)).toBe(true);
    expect(jitChainProfileReconciles(EMPTY_CORE_RUNTIME_PROFILE)).toBe(true);
  });

  it("rejects attempts its outcomes do not account for", () => {
    expect(jitChainProfileReconciles({ ...chain, jitChainAttempts: 13n })).toBe(false);
    expect(jitChainProfileReconciles({ ...chain, jitChainMissingCompilePending: 0n })).toBe(false);
  });
});
