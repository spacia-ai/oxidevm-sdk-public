import { resetBoundedRing } from "../../bounded-ring.js";
import { type DiskBridgeClient } from "../../disk-bridge.js";
import { type SystemTraceRipRange } from "../../protocol.js";
import { assertStatus, callNumber, type Core } from "./core.js";
import { clearJitBlocks } from "./jit-blocks.js";
import { createSystemTraceProfile } from "./telemetry.js";

export function configureSystemTrace(
  loaded: Core,
  diskBridge: DiskBridgeClient | undefined,
  capacity: number,
  interpreterOnly: boolean,
  interpretedSemantics: readonly number[],
  interpretedRipRanges: readonly SystemTraceRipRange[],
  checkpointPolicy: "faults-and-stderr" | "faults-only",
): void {
  const previousSemantics = loaded.traceInterpretedSemantics;
  const quarantineChanged =
    previousSemantics.size !== interpretedSemantics.length ||
    interpretedSemantics.some((semantic) => !previousSemantics.has(semantic)) ||
    !sameRipRanges(loaded.traceInterpretedRipRanges, interpretedRipRanges);
  loaded.traceInterpreterOnly = capacity !== 0 && interpreterOnly;
  loaded.traceCheckpointPolicy = checkpointPolicy;
  loaded.traceInterpretedSemantics.clear();
  if (capacity !== 0) {
    for (const semantic of interpretedSemantics) {
      loaded.traceInterpretedSemantics.add(semantic);
    }
  }
  loaded.traceInterpretedRipRanges.length = 0;
  if (capacity !== 0) {
    loaded.traceInterpretedRipRanges.push(...interpretedRipRanges);
  }
  if (quarantineChanged) {
    loaded.runtimeEpoch += 1;
    clearJitBlocks(loaded, "trace-reconfiguration");
    assertStatus(callNumber(loaded, "oxidevm_jit_quarantine_clear"));
    for (const semantic of loaded.traceInterpretedSemantics) {
      assertStatus(
        callNumber(loaded, "oxidevm_jit_quarantine_add", [semantic]),
      );
    }
    for (const range of loaded.traceInterpretedRipRanges) {
      assertStatus(
        callNumber(loaded, "oxidevm_jit_quarantine_range_add", [
          Number(range.start & 0xffff_ffffn),
          Number(range.start >> 32n),
          Number(range.end & 0xffff_ffffn),
          Number(range.end >> 32n),
        ]),
      );
    }
  }
  loaded.traceCapacity = capacity;
  loaded.traceApplicationSequence = 0;
  loaded.traceSequence = 0;
  loaded.traceCheckpoint = undefined;
  loaded.traceFreeze = undefined;
  loaded.evictedJitKeys.clear();
  loaded.profileJitModules.clear();
  loaded.collidingProfileJitModuleIds.clear();
  loaded.droppedProfileJitModules = 0;
  loaded.collidingProfileJitModules = 0;
  resetBoundedRing(loaded.traceSystemEvents);
  resetBoundedRing(loaded.traceApplicationEvents);
  resetBoundedRing(loaded.traceApplicationSamples);
  resetBoundedRing(loaded.traceSharedLibraryEvents);
  resetBoundedRing(loaded.traceAotEvents);
  const profile = createSystemTraceProfile();
  // Execution counters share the core and compiler lifetime. Resetting only the SDK
  // side loses pending submissions and contradicts native retirement and latency counters.
  // Reconfigure capture without changing that lifetime or the compiler's work.
  Object.assign(loaded.traceProfile.agent, profile.agent);
  diskBridge?.configureProfiling(capacity !== 0);
}

function sameRipRanges(
  left: readonly SystemTraceRipRange[],
  right: readonly SystemTraceRipRange[],
): boolean {
  return (
    left.length === right.length &&
    left.every((range, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        range.start === candidate.start &&
        range.end === candidate.end
      );
    })
  );
}
