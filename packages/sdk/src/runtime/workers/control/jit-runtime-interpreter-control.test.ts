import { describe, expect, it } from "vitest";

import { JIT_CACHE_BYTES } from "../../jit-cache.js";
import { createCore } from "./core.js";
import { recordingCore } from "./core.test-support.js";
import { JitRuntime } from "./jit-runtime.js";

describe("system interpreter controls", () => {
  it("runs the existing bounded interpreter without preparing translated work", () => {
    for (const budget of [3, 200]) {
      const { core: base, calls } = recordingCore();
      const result = new Uint8Array(base.memory.buffer, 0, 48);
      result.set(new TextEncoder().encode("OXRR"));
      const view = new DataView(base.memory.buffer);
      view.setUint16(4, 1, true);
      view.setUint32(8, 36, true);
      result[12] = 1;
      const exports: Readonly<Record<string, unknown>> = {
        oxidevm_result_ptr: () => 0,
        oxidevm_result_len: () => 48,
        oxidevm_jit_next: () => { throw new Error("interpreter control prepared JIT work"); },
        oxidevm_run: (steps: number) => {
          calls.push({ name: "oxidevm_run", args: [steps] });
          view.setBigUint64(16, BigInt(steps), true);
          return 0;
        },
      };
      const core = createCore(new Proxy(base.exports, {
        get: (target, key) => typeof key === "string" ? exports[key] ?? target[key] : undefined,
      }), base.memory, "interpreter-control-test", JIT_CACHE_BYTES);
      core.traceInterpreterOnly = true;
      const steps = Math.min(budget, 64);

      expect(new JitRuntime().runBlock(core, 1, budget, true, () => {}))
        .toEqual({ kind: "step-limit", steps: BigInt(steps) });
      expect(calls).toEqual([{ name: "oxidevm_run", args: [steps] }]);
      expect(core.traceProfile.worker.prepareCalls).toBe(0);
      expect(core.traceProfile.worker.interpreterReasons.degraded.instructions).toBe(BigInt(steps));
      expect(core.runtimeStats.interpretedInstructions).toBe(BigInt(steps));
      expect(core.runtimeStats.jitInstructions).toBe(0n);
      expect(core.jitHealth.state).toBe("active");
    }
  });
});
