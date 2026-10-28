import { describe, expect, it } from "vitest";

import { VMError } from "../../errors.js";
import {
  decodeJitHealthProfile,
  jitHealthReconciles,
} from "../../protocol/system-trace-jit-health.js";
import {
  JitModuleFailure,
  classifyJitFailure,
  createJitHealth,
  engineJitCall,
  jitDegradationWarning,
  jitHealthProfile,
  recordInterpretedCompile,
  recordParkedCompile,
  recordJitFailure,
  recordPromotionFailure,
  recordPromotionDiscard,
  resetJitHealth,
  stickyJitFailure,
} from "./jit-health.js";

function failure(name: string, message: string, phase: "background-compile" | "synchronous-compile" | "instantiation" = "background-compile") {
  return { phase, generation: 2, cacheKey: 0xabcn, error: { name, message } } as const;
}

it("records failed promotions without degrading Tier 1 and resets them with the generation", () => {
  const health = createJitHealth();
  recordPromotionFailure(health, failure("CompileError", "trace rejected"));
  recordPromotionFailure(health, failure("RangeError", "out of memory", "instantiation"));
  const profile = jitHealthProfile(health);
  expect(profile.state).toBe("active");
  expect(profile.firstFailure).toBeNull();
  expect(profile.promotionFailures).toMatchObject({
    counts: { "module-compilation": 1, "code-memory": 1, "module-abi": 0 },
    firstFailure: { phase: "background-compile", cacheKey: 0xabcn },
  });
  expect(decodeJitHealthProfile(profile)).toEqual(profile);
  resetJitHealth(health);
  expect(jitHealthProfile(health)).toEqual(jitHealthProfile(createJitHealth()));
});

it("retains the exact delayed promotion discard without degrading Tier 1", () => {
  const health = createJitHealth();
  const detail = { generation: 3, cacheKey: 0x123n, reason: "cpu-context-changed" } as const;
  recordPromotionDiscard(health, detail);
  recordPromotionDiscard(health, { ...detail, reason: "code-pages-changed" });
  const profile = jitHealthProfile(health);
  expect(profile.state).toBe("active");
  expect(profile.promotionDiscards).toMatchObject({
    counts: { "cpu-context-changed": 1, "code-pages-changed": 1 },
    firstDiscard: detail,
  });
  expect(decodeJitHealthProfile(profile)).toEqual(profile);
  const discards = profile.promotionDiscards;
  if (discards === undefined) throw new Error("expected discard evidence");
  expect(() => decodeJitHealthProfile({ ...profile, promotionDiscards: {
    ...discards, counts: { ...discards.counts, "cpu-context-changed": 0 },
  } })).toThrow("do not reconcile");
  expect(() => decodeJitHealthProfile({ ...profile, promotionDiscards: {
    ...discards, firstDiscard: { ...detail, reason: "stale" },
  } })).toThrow("invalid");
  resetJitHealth(health);
  expect(jitHealthProfile(health)).toEqual(jitHealthProfile(createJitHealth()));
});

describe("JIT failure classification", () => {
  it("treats a RangeError or an engine's out-of-memory report as code-memory exhaustion", () => {
    expect(classifyJitFailure("background-compile", { name: "Error", message: "out of memory" }))
      .toBe("code-memory");
    expect(classifyJitFailure("instantiation", { name: "RangeError", message: "WebAssembly.Instance(): Out of memory" }))
      .toBe("code-memory");
    expect(classifyJitFailure("synchronous-compile", { name: "CompileError", message: "Out of memory: Cannot allocate Wasm code" }))
      .toBe("code-memory");
  });

  it("separates rejected modules from modules that cannot be instantiated", () => {
    expect(classifyJitFailure("background-compile", { name: "CompileError", message: "invalid opcode" }))
      .toBe("module-compilation");
    expect(classifyJitFailure("synchronous-compile", { name: "TypeError", message: "bad bytes" }))
      .toBe("module-compilation");
    expect(classifyJitFailure("instantiation", { name: "LinkError", message: "import mismatch" }))
      .toBe("module-abi");
  });

  it("wraps only the engine call it runs", () => {
    expect(engineJitCall("instantiation", () => 7)).toBe(7);
    let raised: unknown;
    try {
      engineJitCall("synchronous-compile", () => {
        throw new RangeError("out of memory");
      });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(JitModuleFailure);
    expect(raised).toMatchObject({
      phase: "synchronous-compile",
      engineError: { name: "RangeError", message: "out of memory" },
    });
    expect(new JitModuleFailure("instantiation", "not an error").engineError)
      .toEqual({ name: "non-Error", message: "non-Error failure" });
  });
});

describe("JIT health", () => {
  it("starts active and reconciles", () => {
    const health = createJitHealth();
    expect(jitHealthProfile(health)).toEqual(decodeJitHealthProfile(jitHealthProfile(health)));
    expect(stickyJitFailure(health)).toBeNull();
  });

  it("reports leaving active once and keeps counting failures", () => {
    const health = createJitHealth();
    const first = recordJitFailure(health, failure("Error", "out of memory"));
    expect(first).toMatchObject({ state: "exhausted", reason: "code-memory" });
    expect(recordJitFailure(health, failure("RangeError", "out of memory", "instantiation")))
      .toBeUndefined();
    recordInterpretedCompile(health);
    expect(health.state).toBe("exhausted");
    expect(health.failures["code-memory"]).toBe(2);
    expect(health.firstFailure).toEqual(first?.failure);

    // A rejected module after exhaustion disables the JIT without a second report.
    expect(recordJitFailure(health, failure("CompileError", "bad"))).toBeUndefined();
    expect(health).toMatchObject({ state: "disabled", reason: "module-compilation" });
    expect(recordJitFailure(health, failure("Error", "out of memory"))).toBeUndefined();
    expect(health.state).toBe("disabled");
    expect(health.failures).toEqual({ "code-memory": 3, "module-compilation": 1, "module-abi": 0 });
    expect(health.firstFailure?.reason).toBe("code-memory");
    expect(stickyJitFailure(health)).toEqual({ generation: 2, cacheKey: 0xabcn, reason: "code-memory" });
    expect(jitHealthReconciles(jitHealthProfile(health))).toBe(true);
    expect(decodeJitHealthProfile(jitHealthProfile(health))).toEqual(jitHealthProfile(health));
  });

  it("records an explicit reason for a fault around the engine call", () => {
    const health = createJitHealth();
    expect(recordJitFailure(health, {
      ...failure("VMError", "out of memory"),
      reason: "module-abi",
    })).toMatchObject({ state: "disabled", reason: "module-abi" });
  });

  it("bounds the browser error it keeps", () => {
    const health = createJitHealth();
    recordJitFailure(health, failure("E".repeat(100), "m".repeat(1_000)));
    expect(health.firstFailure?.errorName).toHaveLength(64);
    expect(health.firstFailure?.message).toHaveLength(256);
    expect(() => decodeJitHealthProfile(jitHealthProfile(health))).not.toThrow();
  });

  it("starts active again for a new runtime generation", () => {
    const health = createJitHealth();
    recordJitFailure(health, failure("CompileError", "bad"));
    recordInterpretedCompile(health);
    recordParkedCompile(health);
    expect(health).toMatchObject({ interpretedCompiles: 1, parkedCompiles: 1 });
    resetJitHealth(health);
    expect(jitHealthProfile(health)).toEqual(jitHealthProfile(createJitHealth()));
  });

  it("describes a degradation for the console without guest data", () => {
    const health = createJitHealth();
    const degradation = recordJitFailure(health, failure("Error", "out of memory"));
    if (degradation === undefined) throw new Error("expected a degradation");
    expect(jitDegradationWarning("userspace", degradation)).toEqual({
      runtime: "userspace",
      state: "exhausted",
      reason: "code-memory",
      phase: "background-compile",
      cacheKey: "0xabc",
      error: "Error: out of memory",
      effect: "translated code already installed keeps running; new code runs on the interpreter",
    });
  });

  it("is not raised for SDK faults", () => {
    expect(new VMError("VM_FAULT", "x")).not.toBeInstanceOf(JitModuleFailure);
  });
});
