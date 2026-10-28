import { expect, it } from "vitest";
import { type JitBlock, createCore } from "./core.js";
import { recordingCore } from "./core.test-support.js";
import { drainJitAliasBindings } from "./jit-aliases.js";
import { decodeSystemJitModuleMap } from "../../protocol/system-trace-jit.js";
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
  const { core: base } = recordingCore();
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
  const batch = new Uint8Array(52 + suffix.length), view = new DataView(batch.buffer);
  batch.set(new TextEncoder().encode("OXJB")); view.setUint16(4, 1, true);
  view.setUint32(8, batch.length - 12, true); view.setUint32(12, 1, true);
  view.setBigUint64(16, 1n, true); view.setBigUint64(24, 9n, true);
  view.setUint32(32, executable.length, true); view.setBigUint64(36, 11n, true);
  view.setUint32(44, executable.length + suffix.length, true); view.setUint32(48, suffix.length, true);
  batch.set(suffix, 52);
  new Uint8Array(base.memory.buffer).set(batch);
  const acknowledgments: bigint[] = [];
  const overrides: Readonly<Record<string, unknown>> = {
    oxidevm_jit_aliases_ptr: () => 0, oxidevm_jit_aliases_len: () => batch.length,
    oxidevm_jit_aliases_ack: (sequence: bigint) => { acknowledgments.push(sequence); return 0; },
  };
  const core = createCore(new Proxy(base.exports, {
    get: (target, key) => typeof key === "string" ? overrides[key] ?? target[key] : undefined,
  }), base.memory, "alias-test", JIT_CACHE_BYTES);
  const block: JitBlock = {
    cacheKey: 3n, bindingId: 3n, bindingKey: "source", artifactCacheKey: 9n,
    artifact: { kind: "dynamic" }, key: `9:${executable.length}`, slot: 3, byteLength: executable.length,
    executableBytes: executable, instance: new WebAssembly.Instance(new WebAssembly.Module(executable)),
    tier: "tier1", instructions: decodeSystemJitModuleMap(executable).instructions,
    profileModuleId: null, compileGeneration: 1, bindings: new Map(), dispatchGeneration: 1,
    lastUse: 1, queuedUse: 1, dispatchRecentlyUsed: false, codeUnit: null,
    trace: () => undefined, recordTrace: () => undefined,
  };
  core.jitBlocks.set(block.key, block); core.jitBlockBytes = block.byteLength;
  return { core, block, acknowledgments };
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
