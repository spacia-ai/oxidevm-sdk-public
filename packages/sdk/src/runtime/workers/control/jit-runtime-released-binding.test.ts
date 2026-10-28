import { pruneRetiredJitBindings } from "./jit-blocks.js";
import { describe, expect, it } from "vitest";

import { JIT_CONTEXT_LENGTH } from "../../core-abi.js";
import { JIT_OWNER_ACTION_RECORD_VERSION } from "../../core-abi/jit.js";
import { JIT_CACHE_BYTES } from "../../jit-cache.js";
import { createCore, type JitBlock } from "./core.js";
import { recordingCore } from "./core.test-support.js";
import { JitRuntime } from "./jit-runtime.js";

describe("released shared executable bindings", () => {
  it.each(["live", "dormant"] as const)("reclaims retired %s binding metadata from its existing byte budget", location => {
    const { core, entry } = releasedBindingCore(location);
    entry.byteLength = 520;
    if (location === "live") core.jitBlockBytes = 520;
    else core.dormantJitBlockBytes = 520;
    entry.bindings.set("retired", { cacheKey: 1n, key: "retired", tier: "tier1", instructions: [], profileModuleId: "0000000000000003", compileGeneration: 1, bindingId: 3n, metadataBytes: 512 });
    pruneRetiredJitBindings(core, entry);
    expect(entry.bindings.size).toBe(0);
    expect(entry.byteLength).toBe(8);
    expect(location === "live" ? core.jitBlockBytes : core.dormantJitBlockBytes).toBe(8);
  });
  it.each(["live", "dormant"] as const)("recovers a missing %s binding without registering another binding's metadata", location => {
    for (const mode of ["system", "userspace"] as const) {
      for (const budget of [3, 200]) {
        const { core, calls, entry } = releasedBindingCore(location);
        const runtime = new JitRuntime();
        const result = mode === "system"
          ? runtime.runBlock(core, 1, budget, true, () => {})
          : runtime.runLinuxBlock(core, 1, budget, () => {});
        const steps = Math.min(budget, 100);

        expect(result).toEqual({ kind: "step-limit", steps: BigInt(steps) });
        expect(calls.filter(call => ["oxidevm_jit_forget_pending", "oxidevm_jit_complete", "oxidevm_run"].includes(call.name)))
          .toEqual([
            { name: "oxidevm_jit_forget_pending", args: [] },
            { name: "oxidevm_jit_complete", args: [1] },
            { name: "oxidevm_run", args: [steps] },
          ]);
        expect(calls.some(call => call.name === "oxidevm_jit_register")).toBe(false);
        expect(core.traceProfile.worker.interpreterReasons.guard.instructions).toBe(BigInt(steps));
        expect(core.runtimeStats.interpretedInstructions).toBe(BigInt(steps));
        expect(core.jitHealth.state).toBe("active");
        expect(entry.bindingKey).toBe("first");
        expect(entry.bindings.has("88:100")).toBe(false);
        expect(core.traceProfile.worker.dormantJitReactivations).toBe(0);
        expect((location === "live" ? core.jitBlocks : core.dormantJitBlocks).get(entry.key)).toBe(entry);
      }
    }
  });

  it("still rejects an inconsistent cached artifact before recovery", () => {
    const { core, calls, entry } = releasedBindingCore("live");
    core.jitBlocks.set(entry.key, { ...entry, artifactCacheKey: 0x99n });

    expect(() => new JitRuntime().runLinuxBlock(core, 1, 3, () => {}))
      .toThrow("JIT artifact identity changed before registration");
    expect(calls.some(call => call.name === "oxidevm_jit_forget_pending" || call.name === "oxidevm_run")).toBe(false);
  });
});

function releasedBindingCore(location: "live" | "dormant") {
  const { core: base, calls } = recordingCore();
  const action = new Uint8Array(base.memory.buffer, 0, 64);
  action.set(new TextEncoder().encode("OXJA"));
  const view = new DataView(base.memory.buffer);
  view.setUint16(4, JIT_OWNER_ACTION_RECORD_VERSION, true);
  view.setUint32(8, 52, true);
  view.setUint32(16, 100, true);
  view.setBigUint64(28, 0x88n, true);
  view.setUint32(36, 100, true);
  view.setUint32(40, JIT_CONTEXT_LENGTH, true);
  view.setUint32(44, 200, true);
  view.setBigUint64(48, 0x77n, true);
  view.setUint32(56, 80, true);
  const result = new Uint8Array(base.memory.buffer, 128, 48);
  result.set(new TextEncoder().encode("OXRR"));
  view.setUint16(132, 1, true);
  view.setUint32(136, 36, true);
  result[12] = 1;
  const overrides: Readonly<Record<string, unknown>> = {
    oxidevm_jit_action_ptr: () => 0,
    oxidevm_jit_action_len: () => 64,
    oxidevm_jit_context_len: () => JIT_CONTEXT_LENGTH,
    oxidevm_result_ptr: () => 128,
    oxidevm_result_len: () => 48,
    oxidevm_run: (steps: number) => {
      calls.push({ name: "oxidevm_run", args: [steps] });
      view.setBigUint64(144, BigInt(steps), true);
      return 0;
    },
  };
  const core = createCore(new Proxy(base.exports, {
    get: (target, key) => typeof key === "string" ? overrides[key] ?? target[key] : undefined,
  }), base.memory, "released-binding-test", JIT_CACHE_BYTES);
  const entry: JitBlock = {
    cacheKey: 1n, bindingKey: "first", artifactCacheKey: 0x77n,
    artifact: { kind: "dynamic" }, key: "77:80", slot: 0, byteLength: 8,
    instance: new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))),
    tier: "tier1", instructions: [], profileModuleId: null, compileGeneration: 1,
    bindings: new Map(), dispatchGeneration: 1, lastUse: 1, queuedUse: 1,
    dispatchRecentlyUsed: false, codeUnit: null, trace: () => undefined, recordTrace: () => undefined,
  };
  if (location === "live") {
    core.jitBlocks.set(entry.key, entry);
    core.jitBlockBytes = entry.byteLength;
  } else {
    core.dormantJitBlocks.set(entry.key, entry);
    core.dormantJitBlockBytes = entry.byteLength;
  }
  return { core, calls, entry };
}
