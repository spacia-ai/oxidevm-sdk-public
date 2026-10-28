import { VMError } from "../../errors.js";
import type { JitPromotionDiscardReason } from "../../protocol/system-trace-jit-health.js";

/** Decode the core's DeferredTraceValidation (JIT ABI 88); null means all guards passed. */
export function decodeDeferredTraceValidation(value: number): JitPromotionDiscardReason | null {
  switch (value) {
    case 1: return null;
    case 2: return "not-in-flight";
    case 3: return "machine-unavailable";
    case 4: return "translation-unavailable";
    case 5: return "cpu-context-changed";
    case 6: return "already-bound";
    case 7: return "code-pages-changed";
    default: throw new VMError("VM_FAULT", "Invalid deferred trace validation boundary");
  }
}
