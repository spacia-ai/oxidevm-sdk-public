import { describe, expect, it } from "vitest";
import { recordingCore } from "./core.test-support.js";

import {
  JIT_CONTEXT_LENGTH,
  JIT_EDGE_SAMPLE_DROPPED_OFFSET,
  JIT_DISPATCH_SLOT_GENERATIONS_OFFSET,
  JIT_OPERATION_SAMPLE_COUNT_OFFSET,
  JIT_OPERATION_SAMPLE_DROPPED_OFFSET,
  JIT_OPERATION_SAMPLE_TOTAL_OFFSET,
  JIT_OPERATION_SAMPLES_OFFSET,
  JIT_TRACE_RECORD_COUNT_OFFSET,
  JIT_TRACE_RECORD_DROPPED_OFFSET,
  JIT_TRACE_RECORD_TOTAL_OFFSET,
  JIT_TRACE_RECORDS_OFFSET,
} from "../../core-abi.js";
import {
  JIT_CACHE_BYTES,
  JIT_DISPATCH_TABLE_ENTRIES,
} from "../../jit-cache.js";
import { decodeJitOperationSamples } from "../../protocol.js";
import type { JitBlock } from "./core.js";
import { jitBlockBytes, reactivateDormantJitBlock, rememberDormantJitBlock, retireOldestDormantJitBlock } from "./jit-dormant.js";
import {
  byteCapacityVictim,
  evictJitBlock,
  installJitBlock,
  pruneRetiredJitBindings,
  retainJitBlockAlias,
  selectSecondChanceJitBlock,
  touchJitBlock,
  touchLastDispatchedJitBlock,
} from "./jit-blocks.js";
import {
  artifactTimingStart,
  drainJitProfileSamples,
  validatePreparedJitModuleLength,
} from "./jit-runtime.js";
import { instantiateJitModule, prepareJitModule, recordJitCompilation } from "./jit-module-install.js";
import {
  assertExecutableArtifactBytes,
  retainProfileJitModule,
  synchronizeJitDispatchGeneration,
  TraceRecordingCadence,
  TRACE_RECORDING_INVOCATION_PERIOD,
  validateResidentGuardExecution,
  jitRetiredInstructions,
} from "./jit-runtime-helpers.js";
import { createSystemTraceProfile } from "./telemetry.js";
import { JitCodeBudget } from "./jit-code-budget.js";
import { DEFAULT_JIT_POLICY } from "./jit-engine-policy.js";

/** Pages holding one JIT context plus slack, whatever the layout's length. */
const CONTEXT_PAGES = Math.ceil(JIT_CONTEXT_LENGTH / 65_536) + 8;

describe("worker-local JIT compilation", () => {
  it("accepts executable artifact aliases only after exact byte agreement", () => {
    const executable = new Uint8Array([1, 2, 3]);
    for (const binding of [4, 5]) {
      expect(() => assertExecutableArtifactBytes(executable,
        new Uint8Array([1, 2, 3, binding]), 3)).not.toThrow();
    }
    for (const [bytes, length] of [
      [new Uint8Array([1, 2, 9, 4]), 3],
      [new Uint8Array([1, 2]), 3],
      [new Uint8Array([1, 2, 3, 4]), 2],
    ] as const) {
      expect(() => assertExecutableArtifactBytes(executable, bytes, length))
        .toThrow("JIT executable artifact bytes differ from its binding");
    }
  });

  it("records every sixty-fourth outer JIT invocation", () => {
    expect(TRACE_RECORDING_INVOCATION_PERIOD).toBe(64);
    const cadence = new TraceRecordingCadence();
    for (let invocation = 1; invocation < TRACE_RECORDING_INVOCATION_PERIOD; invocation += 1) {
      expect(cadence.takeWindow()).toBe(false);
      cadence.advance(BigInt(invocation - 1), BigInt(invocation));
    }
    expect(cadence.takeWindow()).toBe(true);
    expect(cadence.takeWindow()).toBe(false);
    expect(() => cadence.advance(2n, 1n)).toThrow("retired count moved backwards");
    cadence.reset();
    expect(cadence.takeWindow()).toBe(false);
  });

  it("compiles and instantiates in immediate install mode without a promise or worker turn", () => {
    const instance = instantiateJitModule(moduleWithTraces(), {});

    expect(instance).toBeInstanceOf(WebAssembly.Instance);
    expect(instance.exports["trace"]).toBeTypeOf("function");
    expect(instance.exports["record_trace"]).toBeTypeOf("function");
  });

  it("rejects recording-free modules at every runtime boundary", () => {
    expect(() => instantiateJitModule(moduleWithoutRecording(), {})).toThrow(
      "compiled JIT block has invalid exports",
    );
  });

  it("uses the Rust-owned dispatch generation after registration", () => {
    const memory = new WebAssembly.Memory({ initial: CONTEXT_PAGES });
    const registered = block(emptyInstance(), "registered", 7);
    new DataView(memory.buffer).setUint32(
      JIT_DISPATCH_SLOT_GENERATIONS_OFFSET + registered.slot * 4,
      91,
      true,
    );

    synchronizeJitDispatchGeneration(
      {
        memory,
        exports: { oxidevm_jit_context_ptr: () => 0 },
      },
      registered,
    );

    expect(registered.dispatchGeneration).toBe(91);
  });

  it("distinguishes released bytes from malformed module lengths", () => {
    expect(validatePreparedJitModuleLength(128, 128)).toBe(true);
    expect(validatePreparedJitModuleLength(0, 128)).toBe(false);
    expect(() => validatePreparedJitModuleLength(127, 128)).toThrow(
      "JIT action lengths changed before execution",
    );
  });
});

describe("JIT artifact timing", () => {
  it("starts a compile measurement regardless of the sampled execution timing mode", () => {
    const before = performance.now();
    expect(artifactTimingStart()).toBeGreaterThanOrEqual(before);
  });
});

describe("JIT compilation profile", () => {
  it("records guest size and first versus repeated candidates", () => {
    const loaded = {
      traceProfile: createSystemTraceProfile(),
      compiledJitKeys: new Set<string>(),
      evictedJitKeys: new Map<string, number>([["one", 4]]),
      jitBlockUse: 20,
    };
    recordJitCompilation(loaded, "one", 7, 128);
    recordJitCompilation(loaded, "one", 11, 96);

    expect(loaded.traceProfile.worker).toMatchObject({
      synchronousCompiles: 0,
      compileModules: 2,
      firstCompileModules: 1,
      recompiledModules: 1,
      dispatchSubsequentRecompiles: 1,
      dispatchRecompileReuseDistance: { "16-63": 1 },
      compiledInstructions: 18n,
      compileBytes: 224,
    });
  });
});

describe("JIT block recency", () => {
  it("marks a chained block with one probe and no structural mutation", () => {
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(
        new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      ),
    );
    const entry = block(instance, "entry", 1);
    const chained = block(instance, "chained", 2);
    const cold = block(instance, "cold", 3);
    const blocks = new Map<string, JitBlock>([
      [chained.key, chained],
      [cold.key, cold],
      [entry.key, entry],
    ]);
    const blocksBySlot = new CountingJitSlotMap([
      [entry.slot, entry],
      [chained.slot, chained],
      [cold.slot, cold],
    ]);

    touchLastDispatchedJitBlock(
      {
        jitBlocksBySlot: blocksBySlot,
        jitBlockUse: 3,
      },
      entry.key,
      chained.slot,
    );

    expect(chained.lastUse).toBe(4);
    expect(chained.dispatchRecentlyUsed).toBe(true);
    expect(blocksBySlot.probes).toBe(1);
    expect([...blocks.keys()]).toEqual([chained.key, cold.key, entry.key]);
  });

  it("bounds a full CLOCK sweep and amortizes to two probes per eviction", () => {
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(
        new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      ),
    );
    const blocksBySlot = new CountingJitSlotMap();
    for (let slot = 0; slot < JIT_DISPATCH_TABLE_ENTRIES; slot += 1) {
      const resident = block(instance, "resident", slot);
      resident.dispatchRecentlyUsed = true;
      blocksBySlot.set(slot, resident);
    }
    const state = { jitBlocksBySlot: blocksBySlot, nextJitSlot: 0 };

    const first = selectSecondChanceJitBlock(state);
    expect(first.slot).toBe(0);
    expect(blocksBySlot.probes).toBe(JIT_DISPATCH_TABLE_ENTRIES + 1);
    expect(state.nextJitSlot).toBe(1);

    first.dispatchRecentlyUsed = true;
    for (
      let eviction = 1;
      eviction < JIT_DISPATCH_TABLE_ENTRIES;
      eviction += 1
    ) {
      selectSecondChanceJitBlock(state).dispatchRecentlyUsed = true;
    }
    expect(blocksBySlot.probes).toBe(JIT_DISPATCH_TABLE_ENTRIES * 2);
    expect(state.nextJitSlot).toBe(0);
  });

  it("evicts the oldest unused block at byte capacity and re-queues a used one", () => {
    const instance = emptyInstance();
    const first = block(instance, "first", 1);
    const second = block(instance, "second", 2);
    const third = block(instance, "third", 3);
    const jitBlocks = new Map([first, second, third].map((entry) => [entry.key, entry]));
    const state = { jitBlocks, jitBlockUse: 3 };

    touchJitBlock(state, first);

    expect(byteCapacityVictim(state)).toBe(second);
    expect([...jitBlocks.keys()]).toEqual([second.key, third.key, first.key]);
    jitBlocks.delete(second.key);
    expect(byteCapacityVictim(state)).toBe(third);
    jitBlocks.delete(third.key);
    expect(byteCapacityVictim(state)).toBe(first);
  });

  it("ignores an unbound terminal slot", () => {
    const state = {
      jitBlocksBySlot: new Map<number, JitBlock>(),
      jitBlockUse: 0,
    };

    touchLastDispatchedJitBlock(state, "entry", null);
    touchLastDispatchedJitBlock(state, "entry", 7);

    expect(state.jitBlockUse).toBe(0);
  });
});

describe("dormant JIT blocks", () => {
  it("does not retain an AOT member as a dormant dynamic module", () => {
    const dynamic = block(emptyInstance(), "aot-member", 7);
    const resident: JitBlock = {
      ...dynamic,
      artifact: {
        kind: "aot",
        packSha256: "00".repeat(32),
        memberIndex: 0,
        memberEntryOffset: 0x1000n,
        imageBase: 0x400000n,
        codePages: [],
      },
    };
    const state = {
      dormantJitBlocks: new Map<string, JitBlock>(),
      dormantJitBlockBytes: 0,
      jitBlockBytes: 0,
      aotCacheBytes: 8,
      jitCacheBytes: JIT_CACHE_BYTES,
      jitCode: new JitCodeBudget(DEFAULT_JIT_POLICY),
    };

    rememberDormantJitBlock(state, resident);

    expect(state.dormantJitBlocks).toHaveLength(0);
    expect(state.dormantJitBlockBytes).toBe(0);
  });

  it("reactivates the same compiled instance without recompilation", () => {
    const instance = emptyInstance();
    const resident = block(instance, "resident", 7, "tier2");
    const state = {
      dormantJitBlocks: new Map<string, JitBlock>(),
      dormantJitBlockBytes: 0,
      jitBlockBytes: 0,
      aotCacheBytes: 0,
      jitCacheBytes: JIT_CACHE_BYTES,
      jitCode: new JitCodeBudget(DEFAULT_JIT_POLICY),
      traceProfile: createSystemTraceProfile(),
    };

    rememberDormantJitBlock(state, resident);
    const reactivated = reactivateDormantJitBlock(state, resident.key);

    expect(reactivated).toBe(resident);
    expect(reactivated?.instance).toBe(instance);
    expect(reactivated?.tier).toBe("tier2");
    expect(state.dormantJitBlocks).toHaveLength(0);
    expect(state.dormantJitBlockBytes).toBe(0);
    expect(state.traceProfile.worker).toMatchObject({
      dormantJitReactivations: 1,
      dormantJitReactivationBytes: resident.byteLength,
    });
  });

  it("evicts only the oldest dormant block at the shared byte bound", () => {
    const instance = emptyInstance();
    const first = block(instance, "first", 1);
    const second = block(instance, "second", 2);
    const state = {
      dormantJitBlocks: new Map<string, JitBlock>(),
      dormantJitBlockBytes: 0,
      jitBlockBytes: JIT_CACHE_BYTES - 12,
      aotCacheBytes: 0,
      jitCacheBytes: JIT_CACHE_BYTES,
      jitCode: new JitCodeBudget(DEFAULT_JIT_POLICY),
    };

    rememberDormantJitBlock(state, first);
    rememberDormantJitBlock(state, second);

    expect([...state.dormantJitBlocks.keys()]).toEqual([second.key]);
    expect(state.dormantJitBlockBytes).toBe(second.byteLength);
    expect(
      state.jitBlockBytes + state.dormantJitBlockBytes,
    ).toBeLessThanOrEqual(JIT_CACHE_BYTES);
  });

  it("bounds dormant blocks by the core's own JIT cache budget", () => {
    const instance = emptyInstance();
    const first = block(instance, "first", 1);
    const second = block(instance, "second", 2);
    const state = {
      dormantJitBlocks: new Map<string, JitBlock>(),
      dormantJitBlockBytes: 0,
      jitBlockBytes: 32 - 12,
      aotCacheBytes: 0,
      jitCacheBytes: 32,
      jitCode: new JitCodeBudget(DEFAULT_JIT_POLICY),
    };

    rememberDormantJitBlock(state, first);
    rememberDormantJitBlock(state, second);

    expect([...state.dormantJitBlocks.keys()]).toEqual([second.key]);
    expect(state.jitBlockBytes + state.dormantJitBlockBytes).toBeLessThanOrEqual(32);
  });
});

describe("resident guard completion", () => {
  it("counts the committed prefix when a translated fault charges an attempted step", () => {
    const execution = {
      kind: "exception" as const,
      steps: 4n,
      exception: {
        vector: { name: "#PF", number: 14 },
        class: "fault" as const,
        instructionRip: 0x400100n,
        errorCode: 6,
        faultAddress: 0x7fffffff0000n,
      },
    };
    expect(jitRetiredInstructions(execution, 3n, 0n)).toBe(3n);
    expect(jitRetiredInstructions({ ...execution, steps: 1n }, 0n, 0n)).toBe(0n);
    expect(jitRetiredInstructions({ kind: "step-limit", steps: 7n }, 7n, 3n)).toBe(4n);
    expect(() => jitRetiredInstructions(execution, 2n, 0n)).toThrow("retirement boundary");
    expect(() => jitRetiredInstructions({ kind: "step-limit", steps: 4n }, 3n, 0n))
      .toThrow("retirement boundary");
    expect(() => jitRetiredInstructions(execution, 3n, 4n)).toThrow("retirement boundary");
  });

  it("returns only a validated already-completed resident prefix", () => {
    const execution = {
      kind: "step-limit" as const,
      steps: 7n,
    };

    expect(validateResidentGuardExecution(execution, 3n, 10)).toBe(execution);
    expect(validateResidentGuardExecution(execution, 0n, 10)).toBeUndefined();
    expect(() =>
      validateResidentGuardExecution(execution, 8n, 10),
    ).toThrow("invalid resident guard execution");
  });
});

describe("profile edge sampling", () => {
  it("bounds operation identities to the wire contract and reconciles dropped samples", () => {
    const memory = new WebAssembly.Memory({ initial: CONTEXT_PAGES });
    const state: Parameters<typeof drainJitProfileSamples>[0] = {
      memory,
      profileJitOperationSampleTotal: 0,
      droppedProfileJitOperationSamples: 0,
      profileJitEdgeSampleTotal: 0,
      droppedProfileJitEdgeSamples: 0,
      profileJitOperationSamples: new Map(),
      profileJitEdgeSamples: new Map(),
      jitBlocksBySlot: new Map(),
      collidingProfileJitModuleIds: new Set(),
    };
    const view = new DataView(memory.buffer);
    const record = (instruction: number, span = 0): void => {
      view.setUint32(JIT_OPERATION_SAMPLE_COUNT_OFFSET, 1, true);
      view.setBigUint64(JIT_OPERATION_SAMPLE_TOTAL_OFFSET, 1n, true);
      view.setBigUint64(JIT_OPERATION_SAMPLES_OFFSET, 1n, true);
      view.setUint16(JIT_OPERATION_SAMPLES_OFFSET + 8, instruction, true);
      view.setUint8(JIT_OPERATION_SAMPLES_OFFSET + 11, span);
      drainJitProfileSamples(state, 0);
    };
    record(0);
    expect([...state.profileJitOperationSamples.values()].map((sample) => sample.span)).toEqual(["ordinary"]);
    expect(() => record(0, 1)).toThrow("sample reserved byte is invalid");
    state.profileJitOperationSamples.clear(); state.profileJitOperationSampleTotal = 0;
    for (let instruction = 0; instruction <= 16_384; instruction += 1) record(instruction);
    record(0); // Existing identities still accumulate after the bound is reached.
    const samples = decodeJitOperationSamples([...state.profileJitOperationSamples.values()], true);
    expect(samples).toHaveLength(16_384);
    expect(samples[0]?.samples).toBe(2);
    expect(state.droppedProfileJitOperationSamples).toBe(1);
    expect(samples.reduce((sum, sample) => sum + sample.samples, 0)
      + state.droppedProfileJitOperationSamples).toBe(state.profileJitOperationSampleTotal);
    // The Wasm ring totals count retained entries. Its overflow counters are separate.
    view.setBigUint64(JIT_OPERATION_SAMPLE_DROPPED_OFFSET, 7n, true);
    view.setBigUint64(JIT_EDGE_SAMPLE_DROPPED_OFFSET, 2n, true);
    view.setUint32(JIT_TRACE_RECORD_DROPPED_OFFSET, 3, true);
    drainJitProfileSamples(state, 0);
    expect(state.droppedProfileJitOperationSamples).toBe(8);
    expect(samples.reduce((sum, sample) => sum + sample.samples, 0)
      + state.droppedProfileJitOperationSamples).toBe(state.profileJitOperationSampleTotal);
    expect(state.profileJitEdgeSampleTotal).toBe(5);
    expect(state.droppedProfileJitEdgeSamples).toBe(5);
  });

  it("joins slots to exact generations and rejects a reused source slot", () => {
    const memory = new WebAssembly.Memory({ initial: CONTEXT_PAGES });
    const source = {
      ...block(emptyInstance(), "source", 2),
      profileModuleId: "0123456789abcdef",
      cacheKey: 11n,
      instructions: [{ rip: 0x1000n, semantic: 7, retired: 1, instructionForm: 3 }],
    };
    const target = {
      ...block(emptyInstance(), "target", 3),
      profileModuleId: "fedcba9876543210",
      cacheKey: 12n,
      instructions: [{ rip: 0x2000n, semantic: 8, retired: 1, instructionForm: 4 }],
    };
    const state = {
      memory,
      profileJitOperationSampleTotal: 0,
      droppedProfileJitOperationSamples: 0,
      profileJitEdgeSampleTotal: 0,
      droppedProfileJitEdgeSamples: 0,
      profileJitOperationSamples: new Map(),
      profileJitEdgeSamples: new Map(),
      jitBlocksBySlot: new Map([[source.slot, source], [target.slot, target]]),
      collidingProfileJitModuleIds: new Set<string>(),
    };
    const view = new DataView(memory.buffer);
    const writeEdge = (sourceDispatchGeneration: number): void => {
      view.setUint32(JIT_TRACE_RECORD_COUNT_OFFSET, 1, true);
      view.setUint32(JIT_TRACE_RECORD_DROPPED_OFFSET, 0, true);
      view.setBigUint64(JIT_TRACE_RECORD_TOTAL_OFFSET, 1n, true);
      view.setUint16(JIT_TRACE_RECORDS_OFFSET, source.slot, true);
      view.setUint16(JIT_TRACE_RECORDS_OFFSET + 2, target.slot, true);
      view.setUint16(JIT_TRACE_RECORDS_OFFSET + 4, 0, true);
      view.setUint16(JIT_TRACE_RECORDS_OFFSET + 6, 0, true);
      view.setUint8(JIT_TRACE_RECORDS_OFFSET + 8, 1);
      view.setUint32(JIT_TRACE_RECORDS_OFFSET + 12, 1, true);
      view.setBigUint64(JIT_TRACE_RECORDS_OFFSET + 16, 0x2000n, true);
      view.setUint32(JIT_TRACE_RECORDS_OFFSET + 24, sourceDispatchGeneration, true);
      view.setUint32(
        JIT_TRACE_RECORDS_OFFSET + 28,
        target.dispatchGeneration,
        true,
      );
      drainJitProfileSamples(state, 0);
    };

    writeEdge(source.dispatchGeneration + 1);
    expect(state.profileJitEdgeSamples).toHaveLength(0);
    expect(state.droppedProfileJitEdgeSamples).toBe(1);

    writeEdge(source.dispatchGeneration);
    expect([...state.profileJitEdgeSamples.values()]).toEqual([{
      sourceProfileModuleId: source.profileModuleId,
      targetProfileModuleId: target.profileModuleId,
      sourceCacheKey: source.cacheKey,
      targetCacheKey: target.cacheKey,
      sourceCompileGeneration: source.compileGeneration,
      targetCompileGeneration: target.compileGeneration,
      sourceDispatchGeneration: source.dispatchGeneration,
      targetDispatchGeneration: target.dispatchGeneration,
      sourceDispatchSlot: source.slot,
      targetDispatchSlot: target.slot,
      sourceInstructionIndex: 0,
      targetEntryIndex: 0,
      sourceTier: "tier1",
      targetTier: "tier1",
      sourceRip: 0x1000n,
      targetRip: 0x2000n,
      sourceSemantic: 7,
      targetSemantic: 8,
      kind: "conditional",
      samples: 1,
      retired: 1n,
    }]);
    expect(view.getUint32(JIT_TRACE_RECORD_COUNT_OFFSET, true)).toBe(1);
    expect(view.getUint32(JIT_TRACE_RECORD_DROPPED_OFFSET, true)).toBe(0);
    expect(view.getBigUint64(JIT_TRACE_RECORD_TOTAL_OFFSET, true)).toBe(1n);
    expect(state.profileJitEdgeSampleTotal).toBe(2);
    expect(state.droppedProfileJitEdgeSamples).toBe(1);
    expect(state.profileJitEdgeSamples).toHaveLength(1);
    // The resident dispatcher can run a different binding without a host selection.
    source.bindings.set("source-binding", { ...source, key: "source-binding", profileModuleId: "0000000000000003" });
    target.bindings.set("target-binding", { ...target, key: "target-binding", profileModuleId: "0000000000000004" });
    source.profileModuleId = "0000000000000005";
    target.profileModuleId = "0000000000000006";
    view.setBigUint64(JIT_TRACE_RECORDS_OFFSET + 32, 3n, true);
    view.setBigUint64(JIT_TRACE_RECORDS_OFFSET + 40, 4n, true);
    state.profileJitEdgeSamples.clear();
    writeEdge(source.dispatchGeneration);
    expect([...state.profileJitEdgeSamples.values()]).toMatchObject([{
      sourceProfileModuleId: "0000000000000003",
      targetProfileModuleId: "0000000000000004",
    }]);
  });

  it("retains more exact edge identities than the dispatch table capacity", () => {
    const memory = new WebAssembly.Memory({ initial: CONTEXT_PAGES });
    const source = {
      ...block(emptyInstance(), "source", 2),
      profileModuleId: "0123456789abcdef",
      cacheKey: 11n,
      instructions: Array.from({ length: 16_385 }, (_, index) => ({
        rip: BigInt(index),
        semantic: 7,
        retired: 1,
        instructionForm: 3,
      })),
    };
    const target = {
      ...block(emptyInstance(), "target", 3),
      profileModuleId: "fedcba9876543210",
      cacheKey: 12n,
      instructions: [{ rip: 0x2000n, semantic: 8, retired: 1, instructionForm: 4 }],
    };
    const state = {
      memory,
      profileJitOperationSampleTotal: 0,
      droppedProfileJitOperationSamples: 0,
      profileJitEdgeSampleTotal: 0,
      droppedProfileJitEdgeSamples: 0,
      profileJitOperationSamples: new Map(),
      profileJitEdgeSamples: new Map(),
      jitBlocksBySlot: new Map([[source.slot, source], [target.slot, target]]),
      collidingProfileJitModuleIds: new Set<string>(),
    };
    const view = new DataView(memory.buffer);
    for (let index = 0; index < source.instructions.length; index += 1) {
      const offset = JIT_TRACE_RECORDS_OFFSET;
      view.setUint32(JIT_TRACE_RECORD_COUNT_OFFSET, 1, true);
      view.setUint32(JIT_TRACE_RECORD_DROPPED_OFFSET, 0, true);
      view.setBigUint64(JIT_TRACE_RECORD_TOTAL_OFFSET, 1n, true);
      view.setUint16(offset, source.slot, true);
      view.setUint16(offset + 2, target.slot, true);
      view.setUint16(offset + 4, index, true);
      view.setUint16(offset + 6, 0, true);
      view.setUint8(offset + 8, 0);
      view.setUint32(offset + 12, 1, true);
      view.setBigUint64(offset + 16, 0x2000n, true);
      view.setUint32(offset + 24, source.dispatchGeneration, true);
      view.setUint32(offset + 28, target.dispatchGeneration, true);
      drainJitProfileSamples(state, 0);
    }

    expect(state.profileJitEdgeSamples).toHaveLength(16_385);
    expect(state.droppedProfileJitEdgeSamples).toBe(0);
  });
});

function block(
  instance: WebAssembly.Instance,
  name: string,
  slot: number,
  tier: JitBlock["tier"] = "tier1",
): JitBlock {
  const cacheKey = BigInt(slot);
  const bindingKey = `${name}:${String(slot)}`;
  const compileGeneration = slot + 1;
  return {
    cacheKey,
    bindingKey,
    artifactCacheKey: cacheKey,
    artifact: { kind: "dynamic" },
    key: bindingKey,
    slot,
    byteLength: 8,
    instance,
    trace: () => undefined,
    recordTrace: () => undefined,
    tier,
    instructions: [],
    profileModuleId: null,
    compileGeneration,
    codeUnit: null,
    bindings: new Map([
      [bindingKey, {
        cacheKey,
        key: bindingKey,
        tier,
        instructions: [],
        profileModuleId: null,
        compileGeneration,
      }],
    ]),
    dispatchGeneration: slot + 1,
    lastUse: slot,
    queuedUse: slot,
    dispatchRecentlyUsed: false,
  };
}

function emptyInstance(): WebAssembly.Instance {
  return new WebAssembly.Instance(
    new WebAssembly.Module(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    ),
  );
}

class CountingJitSlotMap extends Map<number, JitBlock> {
  probes = 0;

  override get(slot: number): JitBlock | undefined {
    this.probes += 1;
    return super.get(slot);
  }
}

/** Exports `trace` and `record_trace`, as every translated module does since JIT ABI 56. */
function moduleWithTraces(): Uint8Array<ArrayBuffer> {
  const source = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x03, 0x02, 0x00, 0x00,
    0x07, 0x18, 0x02,
    0x05, 0x74, 0x72, 0x61, 0x63, 0x65, 0x00, 0x00,
    0x0c, 0x72, 0x65, 0x63, 0x6f, 0x72, 0x64, 0x5f, 0x74, 0x72, 0x61, 0x63, 0x65, 0x00, 0x01,
    0x0a, 0x07, 0x02, 0x02, 0x00, 0x0b, 0x02, 0x00, 0x0b,
  ];
  const bytes = new Uint8Array(new ArrayBuffer(source.length));
  bytes.set(source);
  return bytes;
}


it.each(["live eviction", "dormant retirement"] as const)("keeps the 16-byte eligibility charge with its artifact through %s", release => {
  const { core } = recordingCore(0, CONTEXT_PAGES);
  const prefix = accountingPrefix(), initialSuffix = accountingSuffix(3n);
  const initial = accountingJoin(prefix, initialSuffix);
  const initialAction = accountingAction(prefix, initialSuffix, 3n);
  const prepared = prepareJitModule(core, initialAction, `9:${String(prefix.byteLength)}`, `3:${String(initial.byteLength)}`, initial);
  const instance = instantiateJitModule(prefix, {});
  const payloadBytes = initial.byteLength + prefix.byteLength;
  const fresh = installJitBlock(core, payloadBytes, instance, { ...prepared.entry, codeUnit: null }, instance.exports["trace"], instance.exports["record_trace"]);
  retainProfileJitModule(core, prepared.moduleMap, 3n);
  const bindingBytes = (entry: JitBlock) => [...entry.bindings.values()].reduce((sum, binding) => sum + (binding.metadataBytes ?? 0), 0);
  expect(fresh.executablePrefixReusable).toBe(true);
  expect(fresh.byteLength - payloadBytes - bindingBytes(fresh)).toBe(16);
  expect(core.jitBlockBytes).toBe(fresh.byteLength);
  const chargedBytes = fresh.byteLength;

  evictJitBlock(core, fresh, "dispatch-slot");
  expect(core.jitBlockBytes).toBe(0);
  expect(core.dormantJitBlockBytes).toBe(chargedBytes);
  const dormant = reactivateDormantJitBlock(core, fresh.key);
  if (dormant === undefined) throw new Error("Dormant accounting fixture missing");
  const live = installJitBlock(core, dormant.byteLength, dormant.instance, dormant, dormant.trace, dormant.recordTrace);
  expect(live.byteLength).toBe(chargedBytes);
  expect(live.executablePrefixReusable).toBe(true);
  expect(core.jitBlockBytes).toBe(chargedBytes);
  expect(core.dormantJitBlockBytes).toBe(0);

  const suffix = accountingSuffix(7n, true), alias = accountingJoin(prefix, suffix);
  expect(retainJitBlockAlias(core, live, accountingAction(prefix, suffix, 7n), `7:${String(alias.byteLength)}`, alias)).toBe(true);
  expect(live.executablePrefixReusable).toBe(false);
  expect(live.byteLength - payloadBytes - bindingBytes(live)).toBe(16);
  expect(core.jitBlockBytes).toBe(live.byteLength);
  pruneRetiredJitBindings(core, live);
  expect(live.bindings.size).toBe(0);
  expect(live.byteLength).toBe(payloadBytes + 16);
  expect(core.jitBlockBytes).toBe(payloadBytes + 16);
  expect(live.executablePrefixReusable).toBe(false);

  if (release === "live eviction") evictJitBlock(core, live, "byte-capacity");
  else {
    evictJitBlock(core, live, "dispatch-slot");
    expect(core.jitBlockBytes).toBe(0);
    expect(core.dormantJitBlockBytes).toBe(payloadBytes + 16);
    expect(retireOldestDormantJitBlock(core)).toBe(true);
  }
  expect(core.jitBlocks.size).toBe(0);
  expect(core.dormantJitBlocks.size).toBe(0);
  expect(core.jitBlockBytes).toBe(0);
  expect(core.dormantJitBlockBytes).toBe(0);
  expect(jitBlockBytes(core)).toBe(0);
});

function accountingPrefix(): Uint8Array<ArrayBuffer> {
  const output = Array.from(moduleWithTraces());
  const rip = new Uint8Array(23), ripView = new DataView(rip.buffer);
  ripView.setUint32(0, 2, true);
  ripView.setUint32(4, 1, true);
  rip[20] = 1;
  accountingCustomSection(output, "oxidevm.rip-map", rip);
  const ir = new Uint8Array(54), irView = new DataView(ir.buffer);
  irView.setUint32(0, 5, true);
  irView.setUint32(4, 1, true);
  ir[32] = 1;
  irView.setUint32(44, 1, true);
  ir[52] = 7;
  accountingCustomSection(output, "oxidevm.ir-map", ir);
  return new Uint8Array(output);
}

function accountingSuffix(bindingId: bigint, withName = false): Uint8Array<ArrayBuffer> {
  const output: number[] = [];
  const runtime = new Uint8Array(56), runtimeView = new DataView(runtime.buffer);
  runtimeView.setUint32(0, 2, true);
  runtime.set([3, 3, 1, 1], 4);
  runtimeView.setUint32(12, 1, true);
  runtimeView.setBigUint64(16, 2n, true);
  runtimeView.setBigUint64(32, 0x4000n, true);
  runtimeView.setBigUint64(40, 1n, true);
  accountingCustomSection(output, "oxidevm.runtime-identity", runtime);
  const binding = new Uint8Array(20), bindingView = new DataView(binding.buffer);
  bindingView.setUint32(0, 1, true);
  bindingView.setBigUint64(4, bindingId, true);
  bindingView.setBigUint64(12, 3n, true);
  accountingCustomSection(output, "oxidevm.binding-identity", binding);
  if (withName) {
    const name = new TextEncoder().encode("oxidevm_tb_0123456789abcdef_r0000000000000000");
    const functions = [1, 0, name.byteLength, ...name];
    accountingCustomSection(output, "name", new Uint8Array([1, functions.length, ...functions]));
  }
  return new Uint8Array(output);
}

function accountingCustomSection(output: number[], name: string, payload: Uint8Array): void {
  const encoded = new TextEncoder().encode(name);
  output.push(0, 1 + encoded.byteLength + payload.byteLength, encoded.byteLength, ...encoded, ...payload);
}

function accountingJoin(prefix: Uint8Array, suffix: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(prefix.byteLength + suffix.byteLength);
  output.set(prefix);
  output.set(suffix, prefix.byteLength);
  return output;
}

function accountingAction(prefix: Uint8Array, suffix: Uint8Array, cacheKey: bigint) {
  return { kind: "compile" as const, instructionCount: 1, startRip: 0n, cacheKey,
    moduleLength: prefix.byteLength + suffix.byteLength, artifactCacheKey: 9n, artifactModuleLength: prefix.byteLength,
    contextLength: JIT_CONTEXT_LENGTH, maximumInstructions: 1 };
}

function moduleWithoutRecording(): Uint8Array<ArrayBuffer> {
  const source = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x09, 0x01,
    0x05, 0x74, 0x72, 0x61, 0x63, 0x65, 0x00, 0x00,
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
  ];
  const bytes = new Uint8Array(new ArrayBuffer(source.length));
  bytes.set(source);
  return bytes;
}
