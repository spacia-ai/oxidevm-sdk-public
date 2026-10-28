import { describe, expect, it } from "vitest";

import { MAX_LINKED_JIT_MEMBERS } from "../../jit-cache.js";
import {
  decodeJitCodeProfile,
  emptyJitCodeProfile,
  jitCodeProfileReconciles,
} from "../../protocol/system-trace-jit-code.js";
import { CORE_API_VERSION } from "../../core-abi.js";
import { JIT_API_VERSION } from "../../core-abi/jit.js";
import { type Core, createCore, type JitBlock } from "./core.js";
import { admitJitCode, clearJitBlocks, evictJitBlock } from "./jit-blocks.js";
import { type JitCodeUnit, JitCodeBudget } from "./jit-code-budget.js";
import {
  DEFAULT_JIT_POLICY,
  detectJitEngineFamily,
  estimateJitCodeBytes,
  type JitEnginePolicy,
  jitEnginePolicy,
  SPIDERMONKEY_JIT_POLICY,
} from "./jit-engine-policy.js";

const KIB = 1024;
const MIB = 1024 * KIB;

/** A budget whose finalization and collector the test drives. */
function budget(policy: JitEnginePolicy = SPIDERMONKEY_JIT_POLICY, start = 0) {
  let reclaim: (unit: JitCodeUnit) => void = () => undefined;
  const requests: number[] = [];
  const clock = { now: start };
  const code = new JitCodeBudget(policy, {
    finalization: (onReclaimed) => {
      reclaim = onReclaimed;
      return { register: () => undefined };
    },
    collector: (bytes) => { requests.push(bytes); },
    now: () => clock.now,
  });
  return { code, requests, clock, reclaim: (unit: JitCodeUnit) => { reclaim(unit); } };
}

function smallPolicy(budgetBytes: number, evictionTargetBytes = budgetBytes / 2): JitEnginePolicy {
  const base = SPIDERMONKEY_JIT_POLICY.codeBudget;
  if (base === null) throw new Error("the SpiderMonkey policy has a budget");
  return {
    ...SPIDERMONKEY_JIT_POLICY,
    codeBudget: {
      ...base,
      budgetBytes,
      evictionTargetBytes,
      collectionThresholdBytes: 2 * MIB,
      unreclaimedSlackBytes: 4 * MIB,
      collectionRequestBytes: 64 * MIB,
      maximumCollectionRequestBytes: 256 * MIB,
      collectionIntervalMilliseconds: 100,
    },
  };
}

describe("JIT engine family", () => {
  it("detects SpiderMonkey by its InternalError constructor and nothing else", () => {
    expect(detectJitEngineFamily({ InternalError: function InternalError() { return undefined; } }))
      .toBe("spidermonkey");
    expect(detectJitEngineFamily({})).toBe("other");
    expect(detectJitEngineFamily({ InternalError: "not a constructor" })).toBe("other");
    // Node's V8, like Chromium's and JavaScriptCore, has no InternalError.
    expect(detectJitEngineFamily()).toBe("other");
  });

  it("keeps the policy from before engine families for V8, JavaScriptCore and unknown engines", () => {
    expect(jitEnginePolicy("other")).toBe(DEFAULT_JIT_POLICY);
    expect(DEFAULT_JIT_POLICY.codeBudget).toBeNull();
    expect(DEFAULT_JIT_POLICY.batch).toEqual({
      sealMembers: MAX_LINKED_JIT_MEMBERS,
      sealWaitMilliseconds: 0,
    });
  });

  it("gives SpiderMonkey a code budget well inside its executable-memory reserve", () => {
    const policy = jitEnginePolicy("spidermonkey");
    expect(policy).toBe(SPIDERMONKEY_JIT_POLICY);
    const reserve = 2044 * MIB;
    // Stock Firefox 151 stopped compiling the Vite workload at 1,520 MiB committed: mixed
    // allocation sizes fragment the reserve before it is full.
    const fragmentedCeiling = 1520 * MIB;
    const coreCode = 64 * MIB;
    const budget = policy.codeBudget;
    if (budget === null) throw new Error("no budget");
    // Budget and slack, with the core's own code, stay below 60% of the reserve and 80% of the
    // point where fragmentation stopped compiles.
    expect(budget.budgetBytes + budget.unreclaimedSlackBytes + coreCode)
      .toBeLessThanOrEqual(0.6 * reserve);
    expect(budget.budgetBytes + budget.unreclaimedSlackBytes + coreCode)
      .toBeLessThanOrEqual(0.8 * fragmentedCeiling);
    expect(budget.evictionTargetBytes).toBeLessThan(budget.budgetBytes);
    expect(budget.collectionThresholdBytes).toBeLessThan(budget.unreclaimedSlackBytes);
    expect(policy.batch).toEqual({ sealMembers: 16, sealWaitMilliseconds: 100 });
  });

  it("estimates SpiderMonkey code at or just above the stock-Firefox fit", () => {
    const { estimate } = SPIDERMONKEY_JIT_POLICY;
    // Measured: 30 MiB for the core plus 76 KiB per module plus 2.84 bytes per Wasm byte.
    const fitted = (wasmBytes: number) => 76 * KIB + 2.84 * wasmBytes;
    // A tiny module still takes two 64 KiB allocations.
    expect(estimateJitCodeBytes(estimate, 106)).toBe(128 * KIB);
    // Mean unit sizes measured for batches of 1, 4, 16 and 64 members: the estimate stays
    // between the fit and 15% above it.
    for (const kib of [33.2, 98.4, 373.1, 1134.6]) {
      const wasmBytes = Math.round(kib * KIB);
      const ratio = estimateJitCodeBytes(estimate, wasmBytes) / fitted(wasmBytes);
      expect(ratio).toBeGreaterThanOrEqual(1);
      expect(ratio).toBeLessThanOrEqual(1.15);
    }
    // Linking amortizes the per-module allocations: 64 members of 8.8 KB cost less than half of
    // the 128 KiB each would take standalone.
    expect(estimateJitCodeBytes(estimate, 64 * 8_800) / 64).toBeLessThan(64 * KIB);
    expect(estimateJitCodeBytes(DEFAULT_JIT_POLICY.estimate, 34_000)).toBe(34_000);
  });
});

describe("JIT code units", () => {
  it("moves a unit from dead to live to dead to reclaimed and reconciles at each step", () => {
    const { code, reclaim } = budget();
    const unit = code.register({}, 256 * KIB);
    expect(code.profile()).toMatchObject({ units: 1, liveUnits: 0, deadUnits: 1, deadBytes: 256 * KIB });

    code.addMember(unit);
    code.addMember(unit);
    expect(code.profile()).toMatchObject({ liveUnits: 1, deadUnits: 0, deadBytes: 0, retainedBytes: 256 * KIB });
    code.releaseMember(unit);
    expect(unit.state).toBe("live");
    code.releaseMember(unit);
    expect(code.profile()).toMatchObject({ liveUnits: 0, deadUnits: 1, deadBytes: 256 * KIB });

    reclaim(unit);
    reclaim(unit);
    const profile = code.profile();
    expect(profile).toMatchObject({
      units: 1, liveUnits: 0, deadUnits: 0, reclaimedUnits: 1,
      retainedBytes: 0, deadBytes: 0, reclaimedBytes: 256 * KIB, peakRetainedBytes: 256 * KIB,
    });
    expect(jitCodeProfileReconciles(profile)).toBe(true);
    expect(decodeJitCodeProfile(profile)).toEqual(profile);
  });

  it("rejects corrupt membership", () => {
    const { code, reclaim } = budget();
    const unit = code.register({}, 128 * KIB);
    expect(() => { code.releaseMember(unit); }).toThrow("JIT code unit membership is corrupt");
    reclaim(unit);
    expect(() => { code.addMember(unit); }).toThrow("a reclaimed JIT code unit was installed");
    expect(() => { code.releaseReservation(1); }).toThrow("JIT code reservation accounting is corrupt");
  });
});

describe("JIT code admission", () => {
  it("admits everything and never asks for a collection without a budget", () => {
    const { code, requests } = budget(DEFAULT_JIT_POLICY);
    for (let index = 0; index < 100; index += 1) {
      const unit = code.register({}, 1 << 30);
      code.addMember(unit);
      code.releaseMember(unit);
      expect(code.admit(1 << 30)).toBeNull();
    }
    expect(requests).toEqual([]);
    expect(code.profile()).toMatchObject({ budgetBytes: null, family: "other", collectionRequests: 0 });
  });

  it("refuses for the live budget, then for unreclaimed dead code, with typed reasons", () => {
    const { code, reclaim } = budget(smallPolicy(8 * MIB));
    const live = code.register({}, 7 * MIB);
    code.addMember(live);
    expect(code.overEvictionTarget(MIB)).toBe(true);
    expect(code.overBudget(MIB)).toBe(false);
    expect(code.admit(2 * MIB)).toBe("live-budget");

    code.releaseMember(live);
    // Live code is gone, but 7 MiB of dead code plus 6 MiB exceeds budget and slack (12 MiB).
    expect(code.admit(6 * MIB)).toBe("unreclaimed-code");
    expect(code.admit(MIB)).toBeNull();
    reclaim(live);
    expect(code.admit(6 * MIB)).toBeNull();
    expect(code.reservedBytes).toBe(7 * MIB);
    expect(code.profile().refusals).toEqual({ "live-budget": 1, "unreclaimed-code": 1 });
  });

  it("asks for collections past the threshold at most once per interval, doubling unanswered ones", () => {
    const { code, requests, clock, reclaim } = budget(smallPolicy(64 * MIB), 1_000);
    const units = Array.from({ length: 4 }, () => code.register({}, MIB));
    expect(code.admit(0)).toBeNull();
    expect(requests).toEqual([64 * MIB]);
    expect(code.admit(0)).toBeNull();
    expect(requests).toHaveLength(1);
    clock.now += 100;
    expect(code.admit(0)).toBeNull();
    expect(requests).toEqual([64 * MIB, 128 * MIB]);
    const [first, second] = units;
    if (first === undefined || second === undefined) throw new Error("no units");
    reclaim(first);
    clock.now += 100;
    expect(code.admit(0)).toBeNull();
    expect(requests).toEqual([64 * MIB, 128 * MIB, 128 * MIB]);
    clock.now += 100;
    code.admit(0);
    clock.now += 100;
    code.admit(0);
    expect(requests.at(-1)).toBe(256 * MIB);
    // Below the threshold nothing is requested.
    reclaim(second);
    for (const unit of units.slice(2)) reclaim(unit);
    clock.now += 1_000;
    code.admit(0);
    expect(requests).toHaveLength(5);
    expect(code.profile().collectionRequests).toBe(5);
  });
});

describe("JIT code profile decoding", () => {
  it("rejects a profile that does not reconcile or names an unknown family", () => {
    const valid = { ...emptyJitCodeProfile(), family: "spidermonkey", budgetBytes: 1024 };
    expect(decodeJitCodeProfile(valid)).toEqual(valid);
    expect(() => decodeJitCodeProfile({ ...valid, family: "v8" })).toThrow("JIT engine family is invalid");
    expect(() => decodeJitCodeProfile({ ...valid, units: 1 })).toThrow("does not reconcile");
    expect(() => decodeJitCodeProfile({ ...valid, deadBytes: 1 })).toThrow("does not reconcile");
    expect(() => decodeJitCodeProfile({ ...emptyJitCodeProfile(), collectionRequests: 1 }))
      .toThrow("does not reconcile");
    expect(() => decodeJitCodeProfile({ ...valid, extra: 0 })).toThrow();
  });
});

/** A core whose exports accept every call; the store's own maps and tables are real. */
function stubCore(policy: JitEnginePolicy): Core {
  const exports = new Proxy({}, {
    get: (_target, name) => {
      if (name === "oxidevm_api_version") return () => CORE_API_VERSION;
      if (name === "oxidevm_jit_api_version") return () => JIT_API_VERSION;
      return () => 0;
    },
  });
  return createCore(exports, new WebAssembly.Memory({ initial: 1 }), "stub", 1 << 30, policy);
}

/** Installs a block of `unit` at the back of the store's queue; `hot` marks a use since then. */
function installMember(loaded: Core, unit: JitCodeUnit, slot: number, hot = false): JitBlock {
  const key = `member:${String(slot)}`;
  const block: JitBlock = {
    cacheKey: BigInt(slot), bindingKey: key, artifactCacheKey: BigInt(slot),
    artifact: { kind: "dynamic" }, key, tier: "tier1", slot, byteLength: 8,
    instance: new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))),
    codeUnit: unit, trace: () => undefined, recordTrace: () => undefined, instructions: [],
    profileModuleId: null, compileGeneration: 1, bindings: new Map(), dispatchGeneration: 0,
    lastUse: hot ? slot + 1_000 : slot, queuedUse: slot, dispatchRecentlyUsed: hot,
  };
  loaded.jitBlocks.set(key, block);
  loaded.jitBlocksBySlot.set(slot, block);
  loaded.jitBlockBytes += block.byteLength;
  loaded.jitCode.addMember(unit);
  return block;
}

describe("code budget evictions in the block store", () => {
  const unitBytes = MIB;

  it("evicts the oldest cold unit whole, skipping a unit with a recently used member", () => {
    // Budget of 4 units: admitting a fifth evicts until it fits the target of 2, leaving one.
    const loaded = stubCore(smallPolicy(4 * unitBytes));
    const warm = loaded.jitCode.register({}, unitBytes);
    const cold = loaded.jitCode.register({}, unitBytes);
    const later = loaded.jitCode.register({}, unitBytes);
    const last = loaded.jitCode.register({}, unitBytes);
    const warmCold = installMember(loaded, warm, 1);
    installMember(loaded, warm, 2, true);
    installMember(loaded, cold, 3);
    installMember(loaded, cold, 4);
    installMember(loaded, later, 5);
    installMember(loaded, last, 6);

    expect(admitJitCode(loaded, unitBytes)).toBeNull();

    // The warm unit had a member used since queueing: it survives although its other member is
    // the oldest block, and the cold units after it go whole.
    expect(warm.state).toBe("live");
    expect(loaded.jitBlocks.has(warmCold.key)).toBe(true);
    for (const unit of [cold, later, last]) expect(unit).toMatchObject({ state: "dead", members: 0 });
    expect(loaded.traceProfile.worker.evictionReasons["code-budget"].modules).toBe(4);
    expect(loaded.jitTable.get(3)).toBeNull();
    expect(loaded.jitBlocksBySlot.has(3)).toBe(false);
    expect(loaded.jitCode.profile()).toMatchObject({
      liveUnits: 1, deadUnits: 3, reservedBytes: unitBytes,
    });
  });

  it("retires dormant blocks before evicting live ones", () => {
    const loaded = stubCore(smallPolicy(2 * unitBytes, 1.5 * unitBytes));
    const dormant = loaded.jitCode.register({}, unitBytes);
    const live = loaded.jitCode.register({}, unitBytes);
    const sleeping = installMember(loaded, dormant, 1);
    installMember(loaded, live, 2);
    evictJitBlock(loaded, sleeping, "dispatch-slot");
    expect(loaded.dormantJitBlocks.has(sleeping.key)).toBe(true);
    expect(dormant.state).toBe("live");

    expect(admitJitCode(loaded, 0.5 * unitBytes)).toBeNull();

    expect(loaded.dormantJitBlocks.size).toBe(0);
    expect(dormant.state).toBe("dead");
    expect(live.state).toBe("live");
    expect(loaded.traceProfile.worker.evictionReasons["code-budget"].modules).toBe(0);
  });

  it("evicts nothing for a family without a budget", () => {
    const loaded = stubCore(DEFAULT_JIT_POLICY);
    for (let slot = 1; slot <= 8; slot += 1) {
      installMember(loaded, loaded.jitCode.register({}, 1 << 30), slot);
    }
    expect(admitJitCode(loaded, 1 << 30)).toBeNull();
    expect(loaded.jitBlocks.size).toBe(8);
  });

  it("releases every member when bindings are cleared", () => {
    const loaded = stubCore(smallPolicy(64 * unitBytes));
    const unit = loaded.jitCode.register({}, unitBytes);
    installMember(loaded, unit, 1);
    const sleeping = installMember(loaded, unit, 2);
    evictJitBlock(loaded, sleeping, "dispatch-slot");
    clearJitBlocks(loaded, "trace-reconfiguration");
    expect(unit).toMatchObject({ state: "dead", members: 0 });
    expect(loaded.dormantJitBlocks.size).toBe(0);
  });
});
