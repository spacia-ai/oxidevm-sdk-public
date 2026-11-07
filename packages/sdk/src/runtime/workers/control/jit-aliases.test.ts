import { expect, it, vi } from "vitest";
import { type JitBlock, createCore } from "./core.js";
import { recordingCore } from "./core.test-support.js";
import { drainJitAliasBindings } from "./jit-aliases.js";
import * as jitProtocol from "../../protocol/system-trace-jit.js";
import { prepareJitModule } from "./jit-module-install.js";
import { retainProfileJitModule } from "./jit-runtime-helpers.js";
import { selectJitBlockBinding } from "./jit-blocks.js";
import { EMPTY_JIT_AOT_TRAINING_STATS } from "../../protocol/system-trace-jit-aot.js";
import { JIT_CONTEXT_LENGTH } from "../../core-abi.js";
import { JIT_CACHE_BYTES } from "../../jit-cache.js";

it.each([false, true])("retains resident alias provenance before acknowledging, with full cache=%s", full => {
  const { core, block, acknowledgments } = fixture();
  if (full) core.jitBlockBytes = core.jitCacheBytes;
  drainJitAliasBindings(core);
  expect(acknowledgments).toEqual([1n]);
  expect(core.profileJitModules.get("0000000000000007")).toMatchObject({
    bindingIdentity: { id: 7n, originBindingId: 3n },
    runtimeIdentity: { addressSpaceId: 2n, addressSpaceScoped: true },
    artifactIdentity: { cacheKey: 9n, moduleLength: block.executableBytes?.byteLength },
  });
  expect(block.bindingId).toBe(3n);
  expect(core.jitBlocks.get(block.key)).toBe(block);
  expect(block.bindings.size).toBe(full ? 0 : 1);
});

it("rejects an unknown artifact before acknowledging its aliases", () => {
  const { core, acknowledgments } = fixture();
  core.jitBlocks.clear();
  expect(() => drainJitAliasBindings(core)).toThrow("unavailable installed artifact");
  expect(acknowledgments).toEqual([]);
});

function fixture() {
  const { core: base } = recordingCore(0, Math.ceil(JIT_CONTEXT_LENGTH / 65_536) + 8);
  const executable = executableModule();
  const suffix: number[] = [];
  const identity = new Uint8Array(56), runtime = new DataView(identity.buffer);
  runtime.setUint32(0, 2, true); identity.set([3, 3, 1, 1], 4);
  runtime.setUint32(12, 1, true); runtime.setBigUint64(16, 2n, true);
  runtime.setBigUint64(32, 0x4000n, true);
  custom(suffix, "oxidevm.runtime-identity", identity);
  const binding = new Uint8Array(20), bindingView = new DataView(binding.buffer);
  bindingView.setUint32(0, 1, true); bindingView.setBigUint64(4, 7n, true); bindingView.setBigUint64(12, 3n, true);
  custom(suffix, "oxidevm.binding-identity", binding);
  let batch = aliasBatch(executable.byteLength, new Uint8Array(suffix), 11n, 1n);
  new Uint8Array(base.memory.buffer).set(batch);
  const acknowledgments: bigint[] = [];
  let stagedModuleLength = 0;
  const overrides: Readonly<Record<string, unknown>> = {
    oxidevm_jit_aliases_ptr: () => 0, oxidevm_jit_aliases_len: () => batch.length,
    oxidevm_jit_module_ptr: () => 4096, oxidevm_jit_module_len: () => stagedModuleLength,
    oxidevm_jit_binding_is_live: () => 1,
    oxidevm_jit_aliases_ack: (sequence: bigint) => { acknowledgments.push(sequence); return 0; },
  };
  const core = createCore(new Proxy(base.exports, {
    get: (target, key) => typeof key === "string" ? overrides[key] ?? target[key] : undefined,
  }), base.memory, "alias-test", JIT_CACHE_BYTES);
  const block: JitBlock = {
    cacheKey: 3n, bindingId: 3n, bindingKey: "source", artifactCacheKey: 9n,
    artifact: { kind: "dynamic" }, key: `9:${executable.length}`, slot: 3, byteLength: executable.length,
    executableBytes: executable, instance: new WebAssembly.Instance(new WebAssembly.Module(executable)),
    tier: "tier1", instructions: jitProtocol.decodeSystemJitModuleMap(executable).instructions,
    profileModuleId: null, compileGeneration: 1, bindings: new Map(), dispatchGeneration: 1,
    lastUse: 1, queuedUse: 1, dispatchRecentlyUsed: false, codeUnit: null,
    trace: () => undefined, recordTrace: () => undefined,
  };
  core.jitBlocks.set(block.key, block); core.jitBlockBytes = block.byteLength;
  return { core, block, acknowledgments, executable, suffix: new Uint8Array(suffix),
    stageModule: (bytes: Uint8Array) => {
      stagedModuleLength = bytes.byteLength;
      new Uint8Array(core.memory.buffer, 4096, bytes.byteLength).set(bytes);
    },
    publishJournal: (entries: readonly AliasFixtureEvent[]) => {
      batch = aliasJournal(executable.byteLength, entries);
      new Uint8Array(core.memory.buffer).set(batch);
    },
    publish: (next: Uint8Array, cacheKey = 13n, sequence = 2n) => {
      batch = aliasBatch(executable.byteLength, next, cacheKey, sequence);
      new Uint8Array(core.memory.buffer).set(batch);
    } };

}

function executableModule(): Uint8Array<ArrayBuffer> {
  const bytes = [0, 97, 115, 109, 1, 0, 0, 0,
    1, 5, 1, 0x60, 0, 1, 0x7f, 3, 2, 1, 0, 10, 6, 1, 4, 0, 0x41, 0, 0x0b];
  const rip = new Uint8Array(23), rv = new DataView(rip.buffer);
  rv.setUint32(0, 2, true); rv.setUint32(4, 1, true); rip[20] = 1;
  custom(bytes, "oxidevm.rip-map", rip);
  const ir = new Uint8Array(54), iv = new DataView(ir.buffer);
  iv.setUint32(0, 5, true); iv.setUint32(4, 1, true); ir[32] = 1;
  iv.setUint32(44, 1, true); ir[52] = 7;
  custom(bytes, "oxidevm.ir-map", ir);
  return new Uint8Array(bytes);
}

function custom(output: number[], name: string, contents: Uint8Array): void {
  const encoded = new TextEncoder().encode(name), payload = [encoded.length, ...encoded, ...contents];
  output.push(0);
  let length = payload.length;
  do { const byte = length & 127; length >>>= 7; output.push(byte | (length === 0 ? 0 : 128)); } while (length !== 0);
  output.push(...payload);
}


it.each([false, true])("reuses certified arrays before acknowledgement, with full cache=%s", full => {
  const state = certifiedFixture();
  if (full) state.core.jitBlockBytes = state.core.jitCacheBytes;
  const decode = observeFullDecode();
  const legacyDecode = vi.spyOn(jitProtocol, "decodeSystemJitModuleMap");
  try {
    drainJitAliasBindings(state.core);
    expect(decode).not.toHaveBeenCalled();
    expect(legacyDecode).not.toHaveBeenCalled();
    const alias = state.core.profileJitModules.get("0000000000000007");
    expect(alias?.instructions).toBe(state.baseMap.instructions);
    expect(alias?.operations).toBe(state.baseMap.operations);
    expect(alias?.artifactProfileModuleId).toBeNull();
    expect(alias?.bindingIdentity).toEqual({ id: 7n, originBindingId: 3n });
    expect(state.acknowledgments).toEqual([1n]);
    expect(state.block.bindings.size).toBe(full ? 0 : 1);
  } finally { legacyDecode.mockRestore(); decode.mockRestore(); }
});

it.each(["uncertified", "missing", "evicted", "colliding", "artifact key", "artifact length", "foreign instructions"] as const)("uses full decoding for %s prefix evidence", reason => {
  const state = certifiedFixture();
  if (reason === "uncertified") Reflect.deleteProperty(state.block, "executablePrefixReusable");
  else if (reason === "missing") state.core.profileJitModules.clear();
  else if (reason === "evicted") state.core.profileJitModules.delete(state.baseMap.profileModuleId);
  else if (reason === "colliding") retainProfileJitModule(state.core,
    { ...state.baseMap, plan: { ...state.baseMap.plan, dirtyStateMask: 1n } }, state.baseMap.cacheKey);
  else state.core.profileJitModules.retain({ ...state.baseMap,
    ...(reason === "artifact key" ? { artifactIdentity: { cacheKey: 99n, moduleLength: state.executable.byteLength } } : {}),
    ...(reason === "artifact length" ? { artifactIdentity: { cacheKey: 9n, moduleLength: state.executable.byteLength + 1 } } : {}),
    ...(reason === "foreign instructions" ? { instructions: [...state.baseMap.instructions] } : {}),
  });
  const decode = observeFullDecode();
  try {
    drainJitAliasBindings(state.core);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(state.acknowledgments).toEqual([1n]);
    expect(state.block.executablePrefixReusable).toBe(reason === "uncertified" ? undefined : true);
    expect(state.core.profileJitModules.get("0000000000000007")?.bindingIdentity?.id).toBe(7n);
  } finally { decode.mockRestore(); }
});

it("keeps a suffix-added artifact name out of the next canonical alias", () => {
  const state = certifiedFixture();
  const named = namedAliasSuffix(state.suffix);
  state.publish(named, 11n, 1n);
  drainJitAliasBindings(state.core);
  expect(state.core.profileJitModules.get("0000000000000007")?.artifactProfileModuleId).toBe("0123456789abcdef");
  expect(state.block.executablePrefixReusable).toBe(false);
  expect(selectJitBlockBinding(state.core, state.block, aliasAction(state.executable, named, 11n), `b:${String(state.executable.byteLength + named.byteLength)}`, 0)).toBe(true);
  const next = state.suffix.slice();
  new DataView(next.buffer).setBigUint64(next.byteLength - 16, 9n, true);
  state.publish(next);
  const decode = observeFullDecode();
  try {
    drainJitAliasBindings(state.core);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(state.core.profileJitModules.get("0000000000000009")?.artifactProfileModuleId).toBeNull();
    expect(state.block.executablePrefixReusable).toBe(false);
    const third = next.slice();
    new DataView(third.buffer).setBigUint64(third.byteLength - 16, 10n, true);
    state.publish(third, 17n, 3n);
    drainJitAliasBindings(state.core);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(state.block.executablePrefixReusable).toBe(false);
    expect(state.acknowledgments).toEqual([1n, 2n, 3n]);
  } finally { decode.mockRestore(); }
});

it("keeps malformed suffix rejection ahead of acknowledgement on a certified block", () => {
  const state = certifiedFixture();
  const duplicate = new Uint8Array(state.suffix.byteLength * 2);
  duplicate.set(state.suffix); duplicate.set(state.suffix, state.suffix.byteLength);
  state.publish(duplicate, 11n, 1n);
  expect(() => drainJitAliasBindings(state.core)).toThrow(TypeError);
  expect(state.block.executablePrefixReusable).toBe(true);
  expect(state.acknowledgments).toEqual([]);
});

it("owns a certified prefix independently of transferred module bytes and grown guest memory", () => {
  const state = fixture(), bytes = joinAlias(state.executable, state.suffix);
  const prepared = prepareJitModule(state.core, aliasAction(state.executable, state.suffix, 11n), state.block.key, "initial", bytes);
  const prefix = prepared.entry.executableBytes;
  if (prefix === undefined) throw new Error("Owned prefix missing");
  const expected = prefix.slice();
  expect(prepared.entry.executablePrefixReusable).toBe(true);
  const transferred: unknown = structuredClone(bytes, { transfer: [bytes.buffer] });
  expect(bytes.byteLength).toBe(0);
  if (!(transferred instanceof Uint8Array)) throw new Error("Transferred fixture bytes missing");
  transferred.fill(0);
  state.core.memory.grow(1);
  expect(prefix).toEqual(expected);
});

it("keeps prefix and fresh suffix identities valid across guest memory growth", () => {
  const state = certifiedFixture(), expected = state.executable.slice();
  state.core.memory.grow(1);
  drainJitAliasBindings(state.core);
  expect(state.block.executableBytes).toEqual(expected);
  expect(state.core.profileJitModules.get("0000000000000007")?.runtimeIdentity?.addressSpaceId).toBe(2n);
  expect(state.acknowledgments).toEqual([1n]);
});

it("requires the artifact owner even when a retired block's profile map remains", () => {
  const state = certifiedFixture();
  state.core.jitBlocks.clear(); state.core.dormantJitBlocks.clear();
  expect(state.core.profileJitModules.get(state.baseMap.profileModuleId)).toBeDefined();
  expect(() => drainJitAliasBindings(state.core)).toThrow("unavailable installed artifact");
  expect(state.acknowledgments).toEqual([]);
});

function certifiedFixture() {
  const state = fixture(), initial = state.suffix.slice();
  new DataView(initial.buffer).setBigUint64(initial.byteLength - 16, 3n, true);
  const decoded = jitProtocol.decodeSystemJitModuleMap(joinAlias(state.executable, initial));
  const profileModuleId = decoded.profileModuleId;
  if (profileModuleId === null) throw new Error("Initial binding ID missing");
  const baseMap = { ...decoded, profileModuleId, instructions: state.block.instructions,
    artifactIdentity: { cacheKey: 9n, moduleLength: state.executable.byteLength }, cacheKey: 3n, aotTraining: EMPTY_JIT_AOT_TRAINING_STATS };
  state.core.profileJitModules.retain(baseMap);
  state.block.profileModuleId = profileModuleId;
  Object.defineProperty(state.block, "executablePrefixReusable", { configurable: true, writable: true, value: true });
  return { ...state, baseMap };
}

function joinAlias(prefix: Uint8Array, suffix: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(prefix.byteLength + suffix.byteLength);
  bytes.set(prefix); bytes.set(suffix, prefix.byteLength); return bytes;
}

interface AliasFixtureEvent {
  readonly suffix: Uint8Array;
  readonly cacheKey: bigint;
  readonly sequence: bigint;
}

function aliasBatch(prefixLength: number, suffix: Uint8Array, cacheKey: bigint, sequence: bigint): Uint8Array<ArrayBuffer> {
  return aliasJournal(prefixLength, [{ suffix, cacheKey, sequence }]);
}

function aliasJournal(prefixLength: number, entries: readonly AliasFixtureEvent[]): Uint8Array<ArrayBuffer> {
  const byteLength = entries.reduce((length, entry) => length + 36 + entry.suffix.byteLength, 16);
  const batch = new Uint8Array(byteLength);
  const view = new DataView(batch.buffer);
  batch.set(new TextEncoder().encode("OXJB"));
  view.setUint16(4, 1, true);
  view.setUint32(8, byteLength - 12, true);
  view.setUint32(12, entries.length, true);
  let offset = 16;
  for (const entry of entries) {
    view.setBigUint64(offset, entry.sequence, true);
    view.setBigUint64(offset + 8, 9n, true);
    view.setUint32(offset + 16, prefixLength, true);
    view.setBigUint64(offset + 20, entry.cacheKey, true);
    view.setUint32(offset + 28, prefixLength + entry.suffix.byteLength, true);
    view.setUint32(offset + 32, entry.suffix.byteLength, true);
    batch.set(entry.suffix, offset + 36);
    offset += 36 + entry.suffix.byteLength;
  }
  return batch;
}

function aliasAction(prefix: Uint8Array, suffix: Uint8Array, cacheKey: bigint) {
  return { kind: "compile" as const, instructionCount: 1, startRip: 0n, cacheKey,
    moduleLength: prefix.byteLength + suffix.byteLength, artifactCacheKey: 9n, artifactModuleLength: prefix.byteLength,
    contextLength: JIT_CONTEXT_LENGTH, maximumInstructions: 1 };
}


it.each([false, true])("revokes eligibility before retaining a noncanonical alias, with full cache=%s", full => {
  const state = certifiedFixture();
  if (full) state.core.jitBlockBytes = state.core.jitCacheBytes;
  state.publish(namedAliasSuffix(state.suffix), 11n, 1n);
  drainJitAliasBindings(state.core);
  expect(state.block.executablePrefixReusable).toBe(false);
  expect(state.core.profileJitModules.get("0000000000000007")?.artifactProfileModuleId).toBe("0123456789abcdef");
  expect(state.block.bindings.size).toBe(full ? 0 : 1);
  expect(state.acknowledgments).toEqual([1n]);
});

it("revokes eligibility on the full-module selected-binding path before profile publication", () => {
  const state = certifiedFixture(), suffix = namedAliasSuffix(state.suffix);
  const bytes = joinAlias(state.executable, suffix);
  state.stageModule(bytes);
  expect(selectJitBlockBinding(state.core, state.block, aliasAction(state.executable, suffix, 11n), `b:${String(bytes.byteLength)}`, bytes.byteLength)).toBe(true);
  expect(state.block.executablePrefixReusable).toBe(false);
  expect(state.core.profileJitModules.get("0000000000000007")?.artifactProfileModuleId).toBe("0123456789abcdef");
});

function namedAliasSuffix(suffix: Uint8Array): Uint8Array<ArrayBuffer> {
  const extra: number[] = [], encoded = new TextEncoder().encode("oxidevm_tb_0123456789abcdef_r0000000000000010");
  const functionNames = [1, 0, encoded.byteLength, ...encoded];
  custom(extra, "name", new Uint8Array([1, functionNames.length, ...functionNames]));
  const named = new Uint8Array(suffix.byteLength + extra.length);
  named.set(suffix); named.set(extra, suffix.byteLength); return named;
}


it("validates a malformed replay even when its binding key already exists", () => {
  const state = certifiedFixture();
  drainJitAliasBindings(state.core);
  const retained = state.core.profileJitModules.get("0000000000000007");
  const retainedBytes = state.block.byteLength;
  const bindingKey = `b:${String(state.executable.byteLength + state.suffix.byteLength)}`;
  expect(state.block.bindings.has(bindingKey)).toBe(true);
  const replay = state.suffix.slice();
  new DataView(replay.buffer).setBigUint64(replay.byteLength - 16, 0n, true);
  state.publish(replay, 11n, 2n);
  expect(() => drainJitAliasBindings(state.core)).toThrow(TypeError);
  expect(state.acknowledgments).toEqual([1n]);
  expect(state.block.byteLength).toBe(retainedBytes);
  expect(state.block.bindings.size).toBe(1);
  expect(state.block.executablePrefixReusable).toBe(true);
  expect(state.core.profileJitModules.get("0000000000000007")).toBe(retained);
});

it("preserves partial publication and validates the existing first binding on journal replay", () => {
  const state = certifiedFixture();
  const malformed = state.suffix.slice();
  new DataView(malformed.buffer).setBigUint64(malformed.byteLength - 16, 0n, true);
  state.publishJournal([
    { suffix: state.suffix, cacheKey: 11n, sequence: 1n },
    { suffix: malformed, cacheKey: 13n, sequence: 2n },
  ]);
  expect(() => drainJitAliasBindings(state.core)).toThrow(TypeError);
  const first = state.core.profileJitModules.get("0000000000000007");
  const retainedBytes = state.block.byteLength;
  expect(first?.bindingIdentity?.id).toBe(7n);
  expect(state.block.bindings.size).toBe(1);
  expect(state.acknowledgments).toEqual([]);
  expect(state.block.executablePrefixReusable).toBe(true);

  expect(() => drainJitAliasBindings(state.core)).toThrow(TypeError);
  expect(state.core.profileJitModules.get("0000000000000007")).toBe(first);
  expect(state.block.byteLength).toBe(retainedBytes);
  expect(state.block.bindings.size).toBe(1);
  expect(state.acknowledgments).toEqual([]);

  const second = state.suffix.slice();
  new DataView(second.buffer).setBigUint64(second.byteLength - 16, 9n, true);
  state.publishJournal([
    { suffix: malformed, cacheKey: 11n, sequence: 1n },
    { suffix: second, cacheKey: 13n, sequence: 2n },
  ]);
  expect(() => drainJitAliasBindings(state.core)).toThrow(TypeError);
  expect(state.core.profileJitModules.get("0000000000000009")).toBeUndefined();
  expect(state.core.profileJitModules.get("0000000000000007")).toBe(first);
  expect(state.block.byteLength).toBe(retainedBytes);
  expect(state.acknowledgments).toEqual([]);
  expect(state.block.executablePrefixReusable).toBe(true);

  state.publishJournal([
    { suffix: state.suffix, cacheKey: 11n, sequence: 1n },
    { suffix: second, cacheKey: 13n, sequence: 2n },
  ]);
  drainJitAliasBindings(state.core);
  expect(state.core.profileJitModules.get("0000000000000007")).toBe(first);
  expect(state.core.profileJitModules.get("0000000000000009")?.bindingIdentity?.id).toBe(9n);
  expect(state.block.bindings.size).toBe(2);
  expect(state.acknowledgments).toEqual([2n]);
});


it.each(["runtime", "binding"] as const)("preserves the owner rejection when a fresh suffix omits %s identity", missing => {
  const state = certifiedFixture();
  const payload = new Uint8Array(20), view = new DataView(payload.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, 7n, true);
  view.setBigUint64(12, 3n, true);
  const encoded: number[] = [];
  custom(encoded, "oxidevm.binding-identity", payload);
  const binding = new Uint8Array(encoded);
  const suffix = missing === "runtime" ? binding : state.suffix.subarray(0, state.suffix.byteLength - binding.byteLength);
  state.publish(suffix, 11n, 1n);
  expect(() => drainJitAliasBindings(state.core)).toThrow(expect.objectContaining({ code: "VM_FAULT" }));
  expect(state.acknowledgments).toEqual([]);
  expect(state.block.executablePrefixReusable).toBe(true);
  expect(state.block.bindings.size).toBe(0);
  expect(state.core.profileJitModules.get("0000000000000007")).toBeUndefined();
});

function observeFullDecode() {
  const proposed: unknown = Reflect.get(jitProtocol, "decodeSystemJitModuleForInstall");
  return typeof proposed === "function"
    ? vi.spyOn(jitProtocol, "decodeSystemJitModuleForInstall")
    : vi.spyOn(jitProtocol, "decodeSystemJitModuleMap");
}
