import { decodeJitAliasEvents, JIT_CONTEXT_LENGTH } from "../../core-abi.js";
import { VMError } from "../../errors.js";
import { decodeSystemJitModuleMap } from "../../protocol/system-trace-jit.js";
import { type Core, assertStatus, callNumber, readExportedView } from "./core.js";
import { retainJitBlockAlias } from "./jit-blocks.js";

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
    return { event, block, executable: block.executableBytes };
  });
  for (const { event, block, executable } of resolved) {
    const module = new Uint8Array(event.moduleLength);
    module.set(executable);
    module.set(event.suffix, event.artifactModuleLength);
    const map = decodeSystemJitModuleMap(module);
    const first = map.instructions[0];
    if (map.bindingIdentity === undefined || map.runtimeIdentity === null || first === undefined) {
      throw new VMError("VM_FAULT", "JIT alias lacks binding, instruction or runtime identity");
    }
    retainJitBlockAlias(loaded, block, {
      kind: "compile", instructionCount: map.instructions.length, startRip: first.rip,
      cacheKey: event.cacheKey, moduleLength: event.moduleLength,
      artifactCacheKey: event.artifactCacheKey, artifactModuleLength: event.artifactModuleLength,
      contextLength: JIT_CONTEXT_LENGTH, maximumInstructions: map.instructions.length,
    }, `${event.cacheKey.toString(16)}:${event.moduleLength}`, module, map);
  }
  const last = events.at(-1);
  if (last === undefined) throw new VMError("VM_FAULT", "empty JIT alias batch");
  assertStatus(callNumber(loaded, "oxidevm_jit_aliases_ack", [last.sequence]));
}
