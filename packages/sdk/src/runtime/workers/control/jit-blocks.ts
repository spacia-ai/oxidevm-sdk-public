import { JIT_PROFILE_MODULE_IDS_OFFSET, type CoreJitAction } from "../../core-abi.js";
import { VMError } from "../../errors.js";
import { findContiguousJitSlots, JIT_DISPATCH_TABLE_ENTRIES } from "../../jit-cache.js";
import type { SystemJitEvictionReason } from "../../protocol.js";
import { decodeSystemJitModuleMap, type JitModuleTraceMap } from "../../protocol/system-trace-jit.js";
import {
  type Core,
  type JitBlock,
  type JitDispatchers,
  assertStatus,
  callNumber,
  readExportedView,
} from "./core.js";
import {
  clearDormantJitBlocks,
  jitBlockBytes,
  rememberDormantJitBlock,
  retireOldestDormantJitBlock,
  trimDormantJitBlocks,
  takeDormantJitBlock,
} from "./jit-dormant.js";
import { type JitCodeUnit, releaseJitCodeMember } from "./jit-code-budget.js";
import type { SystemJitCodeRefusalReason } from "../../protocol/system-trace-jit-code.js";
import { assertExecutableArtifactBytes, localJitBytes, retainProfileJitModule } from "./jit-runtime-helpers.js";
import { recordJitDistance } from "./telemetry.js";
import { engineJitCall } from "./jit-health.js";

/** The SDK's store of compiled JIT blocks for one core: dispatch slots, the shared dispatch
 * tables, artifact bindings and every byte the browser keeps alive for compiled code (live,
 * dormant and AOT pack bytes). Rust owns translation metadata and its own cache; this module
 * owns the compiled modules and is the only writer of the byte accounting on `Core`. */

export type CompiledJitAction = Extract<CoreJitAction, { readonly kind: "compile" | "install" }>;

/** The dispatcher module's entry points for `loaded`, instantiated once over its memory and
 * dispatch tables. Translated modules carry no dispatcher of their own. */
export function jitDispatchers(loaded: Core): JitDispatchers {
  if (loaded.jitDispatchers !== undefined) return loaded.jitDispatchers;
  const bytes = localJitBytes(readExportedView(loaded, "oxidevm_jit_dispatcher_module"));
  const module = engineJitCall("synchronous-compile", () => new WebAssembly.Module(bytes));
  const exports = engineJitCall("instantiation", () => new WebAssembly.Instance(module, {
    oxidevm: {
      memory: loaded.memory,
      dispatch_table: loaded.jitTable,
      record_dispatch_table: loaded.jitRecordingTable,
    },
  })).exports;
  const run = exports["run"];
  const record = exports["record"];
  const retirePrefix = exports["retire_prefix"];
  if (typeof run !== "function" || typeof record !== "function" || typeof retirePrefix !== "function") {
    throw new VMError("CORE_LOAD_FAILED", "the JIT dispatcher module exports are invalid");
  }
  loaded.jitDispatchers = { run, record, retirePrefix };
  return loaded.jitDispatchers;
}

/** Charges a compiled AOT pack against the shared byte budget; false when it does not fit. */
export function reserveAotPackBytes(loaded: Core, bytes: number): boolean {
  if (jitBlockBytes(loaded) + bytes > loaded.jitCacheBytes) return false;
  loaded.aotCacheBytes += bytes;
  loaded.aotCacheEntries += 1;
  recordJitCachePeaks(loaded);
  return true;
}

/** Forgets every AOT pack charge, when the catalog or the runtime that compiled them goes away. */
export function releaseAotPackBytes(loaded: Core): void {
  loaded.aotCacheBytes = 0;
  loaded.aotCacheEntries = 0;
}

/** Evicts every live block and drops the dormant tier, when cached translations may no longer
 * match the runtime's quarantine configuration. */
export function clearJitBlocks(loaded: Core, reason: SystemJitEvictionReason): void {
  for (const block of [...loaded.jitBlocks.values()]) {
    evictJitBlock(loaded, block, reason);
  }
  clearDormantJitBlocks(loaded);
}

/** Live-block evictions one admission may make; the rest wait for the next compile miss. */
const MAX_CODE_BUDGET_EVICTIONS = 4_096;

/**
 * Admits a compile of `incoming` estimated code bytes under the core's code budget
 * (`jit-code-budget.ts`). Returns null with the estimate reserved, or why the compile is refused.
 */
export function admitJitCode(loaded: Core, incoming: number): SystemJitCodeRefusalReason | null {
  if (loaded.jitCode.overBudget(incoming)) evictForCodeBudget(loaded, incoming);
  return loaded.jitCode.admit(incoming);
}

/**
 * Retires dormant blocks, then evicts live ones (reason `code-budget`) until live code and
 * reservations fit the eviction target. A unit's code is freed only when every member has left,
 * so the victim is a unit: CLOCK picks the oldest block not used since it was queued, and its
 * unit is evicted whole unless another member was used since its own queueing, which gives the
 * victim a second chance instead. Evicting members one by one left linked units alive with a few
 * members each, holding all of their code.
 */
function evictForCodeBudget(loaded: Core, incoming: number): void {
  const code = loaded.jitCode;
  while (code.overEvictionTarget(incoming) && retireOldestDormantJitBlock(loaded));
  if (!code.overEvictionTarget(incoming)) return;
  const members = new Map<JitCodeUnit, JitBlock[]>();
  for (const block of loaded.jitBlocks.values()) {
    if (block.codeUnit === null) continue;
    const unitMembers = members.get(block.codeUnit);
    if (unitMembers === undefined) members.set(block.codeUnit, [block]);
    else unitMembers.push(block);
  }
  let evictions = 0;
  let secondChances = 0;
  while (
    code.overEvictionTarget(incoming)
    && evictions < MAX_CODE_BUDGET_EVICTIONS
    && loaded.jitBlocks.size !== 0
  ) {
    const victim = byteCapacityVictim(loaded);
    if (victim === undefined) throw new VMError("VM_FAULT", "JIT module cache is corrupt");
    const unitMembers = (victim.codeUnit === null ? undefined : members.get(victim.codeUnit))
      ?? [victim];
    if (
      secondChances < loaded.jitBlocks.size
      && unitMembers.some((member) => member.lastUse !== member.queuedUse)
    ) {
      secondChances += 1;
      requeueJitBlock(loaded, victim);
      continue;
    }
    for (const member of unitMembers) {
      if (loaded.jitBlocks.get(member.key) !== member) continue;
      evictJitBlock(loaded, member, "code-budget");
      evictions += 1;
    }
  }
}

/** Restarts the cache peaks from what the store holds now. */
export function resetJitCachePeaks(loaded: Core): void {
  loaded.traceProfile.worker.peakCacheBytes = jitBlockBytes(loaded);
  loaded.traceProfile.worker.peakLiveModules = loaded.jitBlocks.size + loaded.dormantJitBlocks.size;
}

function recordJitCachePeaks(loaded: Core): void {
  loaded.traceProfile.worker.peakCacheBytes = Math.max(
    loaded.traceProfile.worker.peakCacheBytes,
    jitBlockBytes(loaded),
  );
}

export function installJitBlock(
  loaded: Core,
  byteLength: number,
  instance: WebAssembly.Instance,
  entry: Pick<
    JitBlock,
    | "cacheKey" | "bindingKey" | "artifactCacheKey" | "artifact" | "key" | "tier" | "instructions"
    | "profileModuleId" | "compileGeneration" | "codeUnit" | "bindingId"
  > & Partial<Pick<JitBlock, "bindings" | "executableBytes">>,
  trace: unknown,
  recordTrace: unknown,
): JitBlock {
  if (typeof trace !== "function") {
    throw new VMError("VM_FAULT", "compiled JIT trace is invalid");
  }
  if (typeof recordTrace !== "function") {
    throw new VMError("VM_FAULT", "compiled JIT recording trace is invalid");
  }
  const initialBindingBytes = entry.bindings === undefined ? bindingMetadataBytes(entry.bindingKey, entry.bindingId) : 0;
  byteLength += initialBindingBytes;
  if (byteLength > loaded.jitCacheBytes) {
    throw new VMError("QUOTA_EXCEEDED", "compiled JIT module exceeds its cache");
  }
  const duplicate = loaded.jitBlocks.get(entry.key);
  if (duplicate !== undefined) {
    evictJitBlock(loaded, duplicate, "duplicate-install");
  }
  trimDormantJitBlocks(loaded, byteLength);
  while (
    jitBlockBytes(loaded) + byteLength > loaded.jitCacheBytes &&
    loaded.jitBlocks.size !== 0
  ) {
    const oldest = byteCapacityVictim(loaded);
    if (oldest === undefined) {
      throw new VMError("VM_FAULT", "JIT module cache is corrupt");
    }
    evictJitBlock(loaded, oldest, "byte-capacity");
  }
  const block: JitBlock = {
    ...entry,
    bindings: entry.bindings ?? new Map([
        [entry.bindingKey, {
          bindingId: entry.bindingId,
          metadataBytes: initialBindingBytes,
          cacheKey: entry.cacheKey,
          key: entry.bindingKey,
          tier: entry.tier,
          instructions: entry.instructions,
          profileModuleId: entry.profileModuleId,
          compileGeneration: entry.compileGeneration,
        }],
      ]),
    slot: reserveJitSlot(loaded),
    byteLength,
    instance,
    trace,
    recordTrace,
    dispatchGeneration: 0,
    lastUse: ++loaded.jitBlockUse,
    queuedUse: loaded.jitBlockUse,
    dispatchRecentlyUsed: true,
  };
  loaded.jitTable.set(block.slot, trace);
  loaded.jitRecordingTable.set(block.slot, recordTrace);
  loaded.jitBlocks.set(block.key, block);
  loaded.jitBlocksBySlot.set(block.slot, block);
  writeProfileModuleId(loaded, block.slot, block.profileModuleId);
  loaded.jitBlockBytes += byteLength;
  recordJitCachePeaks(loaded);
  loaded.traceProfile.worker.peakLiveModules = Math.max(
    loaded.traceProfile.worker.peakLiveModules,
    loaded.jitBlocks.size + loaded.dormantJitBlocks.size,
  );
  return block;
}

export function selectJitBlockBinding(
  loaded: Core,
  block: JitBlock,
  action: Extract<CoreJitAction, { readonly kind: "compile" | "install" }>,
  bindingKey: string,
  moduleLength: number,
): boolean {
  if (
    block.artifactCacheKey !== action.artifactCacheKey ||
    block.key !== `${action.artifactCacheKey.toString(16)}:${action.artifactModuleLength}`
  ) {
    throw new VMError("VM_FAULT", "JIT artifact identity changed before registration");
  }
  let binding = block.bindings.get(bindingKey);
  if (binding === undefined) {
    if (moduleLength === 0) {
      // A released binding can outlive this executable's eviction/recompilation.
      // Recover through the core before validating and registering that binding.
      return false;
    }
    const moduleBytes = localJitBytes(
      readExportedView(loaded, "oxidevm_jit_module"),
    );
    if (!retainJitBlockAlias(loaded, block, action, bindingKey, moduleBytes)) {
      if (loaded.jitBlocks.get(block.key) === block) evictJitBlock(loaded, block, "byte-capacity");
      else {
        const dormant = takeDormantJitBlock(loaded, block.key);
        if (dormant !== undefined) releaseJitCodeMember(loaded.jitCode, dormant.codeUnit);
      }
      return false;
    }
    binding = block.bindings.get(bindingKey);
  }
  if (binding === undefined) throw new VMError("VM_FAULT", "JIT alias metadata was not retained");
  if (binding.cacheKey !== action.cacheKey) {
    throw new VMError("VM_FAULT", "JIT binding cache identity changed");
  }
  block.bindingId = binding.bindingId;
  block.cacheKey = binding.cacheKey;
  block.bindingKey = binding.key;
  block.tier = binding.tier;
  block.instructions = binding.instructions;
  block.profileModuleId = binding.profileModuleId;
  block.compileGeneration = binding.compileGeneration;
  writeProfileModuleId(loaded, block.slot, binding.profileModuleId);
  return true;
}

/** Retain an already installed alias without selecting it as the outer invocation. */
export function retainJitBlockAlias(
  loaded: Core, block: JitBlock, action: CompiledJitAction,
  bindingKey: string, moduleBytes: Uint8Array,
  decoded?: JitModuleTraceMap,
): boolean {
  if (block.artifactCacheKey !== action.artifactCacheKey ||
      block.key !== `${action.artifactCacheKey.toString(16)}:${action.artifactModuleLength}`) {
    throw new VMError("VM_FAULT", "JIT artifact identity changed before registration");
  }
  const existing = block.bindings.get(bindingKey);
  if (existing !== undefined) {
    if (existing.cacheKey !== action.cacheKey) throw new VMError("VM_FAULT", "JIT binding cache identity changed");
    return true;
  }
  if (moduleBytes.byteLength !== action.moduleLength) {
    throw new VMError("VM_FAULT", "JIT alias module length changed before registration");
  }
  assertExecutableArtifactBytes(block.executableBytes, moduleBytes, action.artifactModuleLength);
  const moduleMap = { ...(decoded ?? decodeSystemJitModuleMap(moduleBytes)), artifactIdentity: { cacheKey: action.artifactCacheKey, moduleLength: action.artifactModuleLength } };
  if (
    moduleMap.tier !== block.tier ||
    moduleMap.instructions.length !== action.instructionCount
  ) {
    throw new VMError("VM_FAULT", "JIT artifact alias has incompatible executable metadata");
  }
  pruneRetiredJitBindings(loaded, block);
  const metadataBytes = bindingMetadataBytes(bindingKey, moduleMap.bindingIdentity?.id);
  const previousMap = block.profileModuleId === null ? undefined : loaded.profileJitModules.get(block.profileModuleId);
  retainProfileJitModule(loaded, { ...moduleMap, instructions: block.instructions, operations: previousMap?.operations ?? moduleMap.operations }, action.cacheKey);
  if (loaded.jitBlocks.get(block.key) !== block && loaded.dormantJitBlocks.get(block.key) !== block) return false;
  if (jitBlockBytes(loaded) + metadataBytes > loaded.jitCacheBytes) {
    // Resident aliases already ran. Their caller must keep the active slot until completion.
    return false;
  }
  const binding = {
    bindingId: moduleMap.bindingIdentity?.id,
    metadataBytes,
    cacheKey: action.cacheKey,
    key: bindingKey,
    tier: moduleMap.tier,
    instructions: block.instructions,
    profileModuleId: moduleMap.profileModuleId,
    compileGeneration: block.compileGeneration,
  };
  block.bindings.set(bindingKey, binding);
  adjustBindingBytes(loaded, block, metadataBytes);
  return true;
}

/** The engine owns binding lifetime. Query it only when another binding enters this artifact. */
export function pruneRetiredJitBindings(loaded: Core, block: JitBlock): void {
  for (const [key, binding] of block.bindings) {
    if (binding.bindingId === undefined) continue;
    const live = callNumber(loaded, "oxidevm_jit_binding_is_live", [binding.bindingId]);
    if (live !== 0 && live !== 1) throw new VMError("VM_FAULT", "invalid JIT binding liveness");
    if (live === 0) {
      block.bindings.delete(key);
      adjustBindingBytes(loaded, block, -(binding.metadataBytes ?? 0));
    }
  }
}

function bindingMetadataBytes(key: string, id: bigint | undefined): number {
  // Includes the record, scalar identities and key strings; instruction/IR maps are shared.
  return id === undefined ? 0 : 512 + key.length * 2;
}

function adjustBindingBytes(loaded: Core, block: JitBlock, delta: number): void {
  block.byteLength += delta;
  if (loaded.jitBlocks.get(block.key) === block) loaded.jitBlockBytes += delta;
  else if (loaded.dormantJitBlocks.get(block.key) === block) loaded.dormantJitBlockBytes += delta;
  else throw new VMError("VM_FAULT", "JIT binding has no artifact owner");
  if (delta > 0) recordJitCachePeaks(loaded);
}

export function writeProfileModuleId(
  loaded: Core,
  slot: number,
  profileModuleId: string | null,
): void {
  const contextPointer = callNumber(loaded, "oxidevm_jit_context_ptr");
  const offset = contextPointer + JIT_PROFILE_MODULE_IDS_OFFSET + slot * 8;
  const view = new DataView(loaded.memory.buffer);
  view.setBigUint64(
    offset,
    profileModuleId === null ? 0n : BigInt(`0x${profileModuleId}`),
    true,
  );
}

export function touchJitBlock(
  loaded: Pick<Core, "jitBlockUse">,
  block: JitBlock,
): void {
  block.lastUse = ++loaded.jitBlockUse;
  block.dispatchRecentlyUsed = true;
}

export function touchLastDispatchedJitBlock(
  loaded: Pick<Core, "jitBlocksBySlot" | "jitBlockUse">,
  entryKey: string,
  lastDispatchSlot: number | null,
): void {
  if (lastDispatchSlot === null) return;
  const block = loaded.jitBlocksBySlot.get(lastDispatchSlot);
  if (block === undefined || block.key === entryKey) return;
  touchJitBlock(loaded, block);
}

/** The byte-capacity victim, CLOCK over install order: the oldest block not used since it
 * entered the queue. A block used since then moves to the back with a second chance, so a
 * touch stays a field write and an eviction is amortized O(1). */
export function byteCapacityVictim(loaded: Pick<Core, "jitBlocks">): JitBlock | undefined {
  for (let passes = loaded.jitBlocks.size; passes > 0; passes -= 1) {
    const oldest = loaded.jitBlocks.values().next().value;
    if (oldest === undefined || oldest.lastUse === oldest.queuedUse) return oldest;
    requeueJitBlock(loaded, oldest);
  }
  return loaded.jitBlocks.values().next().value;
}

/** Moves `block` to the back of the byte-capacity queue, as used now. */
function requeueJitBlock(loaded: Pick<Core, "jitBlocks">, block: JitBlock): void {
  loaded.jitBlocks.delete(block.key);
  block.queuedUse = block.lastUse;
  loaded.jitBlocks.set(block.key, block);
}

export function evictJitBlock(
  loaded: Core,
  block: JitBlock,
  reason: SystemJitEvictionReason,
): void {
  if (loaded.jitBlockBytes < block.byteLength) {
    throw new VMError("VM_FAULT", "JIT block accounting is corrupt");
  }
  assertStatus(
    callNumber(loaded, "oxidevm_jit_unregister", [block.artifactCacheKey, block.slot]),
  );
  loaded.jitBlocks.delete(block.key);
  if (loaded.jitBlocksBySlot.get(block.slot) === block) {
    loaded.jitBlocksBySlot.delete(block.slot);
    loaded.jitTable.set(block.slot, null);
    loaded.jitRecordingTable.set(block.slot, null);
  }
  loaded.jitBlockBytes -= block.byteLength;
  // A dispatch-slot victim keeps its code in the dormant tier; anything else releases it.
  if (reason === "dispatch-slot") rememberDormantJitBlock(loaded, block);
  else releaseJitCodeMember(loaded.jitCode, block.codeUnit);
  loaded.runtimeStats.evictions += 1n;
  loaded.traceProfile.worker.moduleEvictions += 1;
  const reasonProfile = loaded.traceProfile.worker.evictionReasons[reason];
  reasonProfile.modules += 1;
  reasonProfile.bytes += block.byteLength;
  if (reason === "dispatch-slot") {
    recordJitDistance(
      loaded.traceProfile.worker.dispatchVictimAge,
      Math.max(0, loaded.jitBlockUse - block.lastUse),
    );
    if (
      !loaded.evictedJitKeys.has(block.key) &&
      loaded.evictedJitKeys.size >= 65_536
    ) {
      const oldest = loaded.evictedJitKeys.keys().next().value;
      if (oldest !== undefined) loaded.evictedJitKeys.delete(oldest);
      loaded.traceProfile.worker.dispatchEvictionTrackingDropped += 1;
    }
    loaded.evictedJitKeys.set(block.key, loaded.jitBlockUse);
  }
}

export function rollbackStagedJitBlock(loaded: Core, block: JitBlock): void {
  if (loaded.jitBlocks.get(block.key) !== block) {
    throw new VMError("VM_FAULT", "staged AOT block is no longer current");
  }
  if (loaded.jitBlockBytes < block.byteLength) {
    throw new VMError("VM_FAULT", "staged AOT block accounting is corrupt");
  }
  loaded.jitBlocks.delete(block.key);
  if (loaded.jitBlocksBySlot.get(block.slot) === block) {
    loaded.jitBlocksBySlot.delete(block.slot);
    loaded.jitTable.set(block.slot, null);
    loaded.jitRecordingTable.set(block.slot, null);
  }
  loaded.jitBlockBytes -= block.byteLength;
}

function reserveJitSlot(loaded: Core): number {
  const reusable = findContiguousJitSlots(
    loaded.jitBlocksBySlot,
    1,
    loaded.nextJitSlot,
    JIT_DISPATCH_TABLE_ENTRIES,
  );
  if (reusable !== null) {
    loaded.nextJitSlot = (reusable + 1) % JIT_DISPATCH_TABLE_ENTRIES;
    return reusable;
  }
  const victim = selectSecondChanceJitBlock(loaded);
  evictJitBlock(loaded, victim, "dispatch-slot");
  return victim.slot;
}

export function selectSecondChanceJitBlock(
  loaded: Pick<Core, "jitBlocksBySlot" | "nextJitSlot">,
): JitBlock {
  // ponytail: CLOCK trades exact LRU for constant-work hits; use an intrusive
  // list only if victim/recompile profiles justify its extra hot-path writes.
  for (let probes = 0; probes <= JIT_DISPATCH_TABLE_ENTRIES; probes += 1) {
    const slot = loaded.nextJitSlot;
    loaded.nextJitSlot = (slot + 1) % JIT_DISPATCH_TABLE_ENTRIES;
    const block = loaded.jitBlocksBySlot.get(slot);
    if (block === undefined) {
      throw new VMError("VM_FAULT", "JIT dispatch slot cache is corrupt");
    }
    if (!block.dispatchRecentlyUsed) return block;
    block.dispatchRecentlyUsed = false;
  }
  throw new VMError("VM_FAULT", "JIT dispatch clock has no victim");
}
