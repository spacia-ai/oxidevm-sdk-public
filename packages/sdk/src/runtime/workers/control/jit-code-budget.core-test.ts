import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { decodeSystemTraceProfile } from "../../protocol/system-trace-profile.js";
import { decodeJitCodeProfile } from "../../protocol/system-trace-jit-code.js";
import type { Core } from "./core.js";
import { evictJitBlock } from "./jit-blocks.js";
import { type JitEnginePolicy, SPIDERMONKEY_JIT_POLICY } from "./jit-engine-policy.js";
import { JitRuntime } from "./jit-runtime.js";
import {
  ITERATIONS,
  LOOP_SUM,
  deferredRuntime,
  loadStagedCore,
  rax,
  runToHalt,
  summingLoops,
} from "./jit-runtime.test-support.js";
import { NetworkLink } from "./network-link.js";
import { readSystemTrace } from "./trace.js";

// The code budget and batch policy against the real core: these drive the Rust core through the
// real JitRuntime, as `jit-runtime.core-test.ts` does.

const KIB = 1024;
/** Every small Tier-1 module is estimated at 128 KiB under the SpiderMonkey model. */
const UNIT = 128 * KIB;

/** The SpiderMonkey policy with a budget of `units` small modules. */
function tinyBudget(units: number, overrides: Partial<NonNullable<JitEnginePolicy["codeBudget"]>> = {}): JitEnginePolicy {
  const budget = SPIDERMONKEY_JIT_POLICY.codeBudget;
  if (budget === null) throw new Error("the SpiderMonkey policy has a code budget");
  return {
    ...SPIDERMONKEY_JIT_POLICY,
    codeBudget: {
      ...budget,
      budgetBytes: units * UNIT,
      evictionTargetBytes: (units - 1) * UNIT,
      collectionThresholdBytes: UNIT,
      unreclaimedSlackBytes: 64 * units * UNIT,
      collectionIntervalMilliseconds: 0,
      ...overrides,
    },
  };
}

function loopsRetired(loops: number): bigint {
  return 2n + BigInt(loops) * (1n + 3n * BigInt(ITERATIONS));
}

function decodedTrace(loaded: Core) {
  const value = readSystemTrace(loaded, undefined, "", {
    kind: "disabled", reason: "no-catalog", catalogSha256: null, indexSha256: null,
    keyId: null, signatureVerified: false, encounters: 0, instantiateMilliseconds: 0, packs: [],
  }, { active: false, paused: false, stopping: false, awaitingConsoleAck: false, waiting: "none" }, NetworkLink.absent(loaded));
  return decodeSystemTraceProfile(value.profile, value.schemaVersion);
}

/** V8's collector, exposed for this test process. */
function collector(): () => void {
  setFlagsFromString("--expose-gc");
  const gc: unknown = runInNewContext("gc");
  if (typeof gc !== "function") throw new Error("gc is not exposed");
  return () => { Reflect.apply(gc, undefined, []); };
}

/** The oldest installed block's key and a weak reference to its instance; no strong reference to
 * the block outlives the call. */
function weaklyHeldOldestBlock(loaded: Core): { key: string; instance: WeakRef<WebAssembly.Instance> } {
  const block = [...loaded.jitBlocks.values()][0];
  if (block === undefined) throw new Error("no translation was installed");
  return { key: block.key, instance: new WeakRef(block.instance) };
}

async function settleFinalizers(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
}

describe("the JIT code budget", () => {
  it("evicts live translations for the budget and keeps every result", async () => {
    const loaded = await loadStagedCore(tinyBudget(3));
    const runtime = new JitRuntime();
    runtime.initialize();
    const loops = 8;

    const retired = runToHalt(loaded, runtime, summingLoops(loops));

    expect(retired).toBe(loopsRetired(loops));
    expect(rax(loaded)).toBe(BigInt(loops) * LOOP_SUM);
    const profile = decodedTrace(loaded);
    const code = profile.worker.jitCode;
    expect(code).toMatchObject({ family: "spidermonkey", budgetBytes: 3 * UNIT });
    expect(profile.worker.evictionReasons["code-budget"].modules).toBeGreaterThan(0);
    expect(code.liveUnits).toBeLessThanOrEqual(3);
    // Each live block holds its own unit; every evicted one's unit is dead or reclaimed.
    expect(code.liveUnits).toBe(loaded.jitBlocks.size);
    expect(code.deadUnits + code.reclaimedUnits).toBe(code.units - code.liveUnits);
    expect(code.reservedBytes).toBe(0);
    expect(profile.worker.jitHealth.state).toBe("active");
    expect(decodeJitCodeProfile(JSON.parse(JSON.stringify(code)))).toEqual(code);
  });

  it("leaves an evicted translation's instance to the collector, which reclaims its unit", async () => {
    const gc = collector();
    const loaded = await loadStagedCore(tinyBudget(2, { collectionThresholdBytes: 1 << 30 }));
    const runtime = new JitRuntime();
    runtime.initialize();
    runToHalt(loaded, runtime, summingLoops(2));
    const { key, instance } = weaklyHeldOldestBlock(loaded);

    runToHalt(loaded, runtime, summingLoops(6));
    expect(loaded.jitBlocks.has(key)).toBe(false);
    expect(loaded.dormantJitBlocks.has(key)).toBe(false);
    const dead = loaded.jitCode.profile().deadUnits;
    expect(dead).toBeGreaterThan(0);

    // A WeakRef keeps its target alive until the job that created it ends.
    await settleFinalizers();
    gc();
    await settleFinalizers();

    expect(instance.deref()).toBeUndefined();
    const code = loaded.jitCode.profile();
    expect(code.reclaimedUnits).toBeGreaterThan(0);
    expect(code.deadUnits).toBeLessThan(dead);
    expect(code.liveUnits).toBe(loaded.jitBlocks.size);
  });

  it("refuses compiles while dead code is not collected and interprets their sites", async () => {
    const loaded = await loadStagedCore(tinyBudget(2, {
      unreclaimedSlackBytes: UNIT,
      collectionThresholdBytes: 1 << 30,
    }));
    const runtime = new JitRuntime();
    runtime.initialize();
    const loops = 8;

    const retired = runToHalt(loaded, runtime, summingLoops(loops));

    expect(retired).toBe(loopsRetired(loops));
    expect(rax(loaded)).toBe(BigInt(loops) * LOOP_SUM);
    const profile = decodedTrace(loaded);
    expect(profile.worker.jitCode.refusals["unreclaimed-code"]).toBeGreaterThan(0);
    expect(profile.worker.interpreterReasons["code-budget"].batches).toBeGreaterThan(0);
    expect(profile.worker.jitHealth.state).toBe("active");
    expect(profile.worker.jitCode.retainedBytes)
      .toBeLessThanOrEqual(3 * UNIT + profile.worker.jitCode.deadBytes);
  });

  it("requests a collection once dead code passes the threshold", async () => {
    const policy = tinyBudget(2);
    const loaded = await loadStagedCore(policy);
    const runtime = new JitRuntime();
    runtime.initialize();

    runToHalt(loaded, runtime, summingLoops(6));

    const code = loaded.jitCode.profile();
    expect(code.collectionRequests).toBeGreaterThan(0);
    expect(code.collectionRequestBytes)
      .toBeGreaterThanOrEqual(policy.codeBudget?.collectionRequestBytes ?? Number.POSITIVE_INFINITY);
  });

  it("keeps every translation of a family without a budget", async () => {
    const loaded = await loadStagedCore();
    const runtime = new JitRuntime();
    runtime.initialize();

    runToHalt(loaded, runtime, summingLoops(8));

    const profile = decodedTrace(loaded);
    expect(profile.worker.jitCode).toMatchObject({
      family: "other", budgetBytes: null, collectionRequests: 0,
      refusals: { "live-budget": 0, "unreclaimed-code": 0 },
    });
    expect(profile.worker.evictionReasons["code-budget"].modules).toBe(0);
    expect(profile.worker.jitCode.liveUnits).toBe(loaded.jitBlocks.size);
  });
});

describe("linked batches under a batch policy", () => {
  it("keeps a linked unit live until its last member leaves, evicting members one by one", async () => {
    const loaded = await loadStagedCore(tinyBudget(64));
    const { runtime, compilers } = deferredRuntime("batched", undefined, {
      sealMembers: 3,
      sealWaitMilliseconds: 60_000,
    });
    runToHalt(loaded, runtime, summingLoops(3), () => {
      compilers.at(-1)?.release();
    });
    const linked = [...loaded.jitBlocks.values()].filter((block) => block.artifact.kind === "linked");
    expect(linked).toHaveLength(3);
    const unit = linked[0]?.codeUnit;
    if (unit === undefined || unit === null) throw new Error("the batch has no code unit");
    const live = loaded.jitCode.profile().liveUnits;

    // Changed code at one member's site: that member's registration goes stale and leaves the
    // store alone; the others keep running from the same unit.
    const [victim, ...rest] = linked;
    if (victim === undefined) throw new Error("no member");
    evictJitBlock(loaded, victim, "stale-registration");
    expect(unit.members).toBe(2);
    expect(unit.state).toBe("live");
    expect(loaded.jitCode.profile().liveUnits).toBe(live);
    for (const member of rest) evictJitBlock(loaded, member, "code-budget");
    expect(unit.members).toBe(0);
    expect(unit.state).toBe("dead");
    expect(loaded.jitCode.profile().liveUnits).toBe(live - 1);

    // The same program recompiles what it needs and keeps its results.
    expect(runToHalt(loaded, runtime, summingLoops(3), () => {
      compilers.at(-1)?.release();
    })).toBe(loopsRetired(3));
    expect(rax(loaded)).toBe(3n * LOOP_SUM);
    await runtime.dispose();
  });
});
