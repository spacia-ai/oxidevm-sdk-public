import { decodeJitAliasEvents } from "../../core-abi.js";
import { VMError } from "../../errors.js";
import { type Core, assertStatus, callNumber, readExportedView } from "./core.js";
import { retainJitBlockAliasEvent } from "./jit-blocks.js";

/** Publish in-Wasm binding identities before their profile samples reach consumers. */
export function drainJitAliasBindings(loaded: Core): void {
  if (typeof loaded.exports["oxidevm_jit_aliases_ack"] !== "function") return;
  const bytes = readExportedView(loaded, "oxidevm_jit_aliases");
  if (bytes.byteLength === 0) return;
  const events = decodeJitAliasEvents(bytes);
  const resolved = events.map(event => {
    const key = `${event.artifactCacheKey.toString(16)}:${event.artifactModuleLength}`;
    const block = loaded.jitBlocks.get(key) ?? loaded.dormantJitBlocks.get(key);
    if (block?.executableBytes === undefined || block.executableBytes.byteLength !== event.artifactModuleLength) {
      throw new VMError("VM_FAULT", "JIT alias references an unavailable installed artifact");
    }
    return { event, block };
  });
  for (const { event, block } of resolved) {
    retainJitBlockAliasEvent(loaded, block, event);
  }
  const last = events.at(-1);
  if (last === undefined) throw new VMError("VM_FAULT", "empty JIT alias batch");
  assertStatus(callNumber(loaded, "oxidevm_jit_aliases_ack", [last.sequence]));
}
