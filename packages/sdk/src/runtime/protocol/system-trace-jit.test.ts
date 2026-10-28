import { describe, expect, it } from "vitest";

import {
  decodeSystemJitModuleMap,
  decodeSystemJitRipMap,
  readSystemJitContextDiagnostics,
  readSystemJitExecutionDiagnostics,
  readSystemJitLastDispatchSlot,
} from "./system-trace-jit.js";
import {
  JIT_CONTEXT_LENGTH,
} from "../core-abi/jit.js";
import {
  JIT_DISPATCH_TABLE_ENTRIES,
  JIT_REGION_MAX_INSTRUCTIONS,
} from "../jit-cache.js";

describe("system JIT trace protocol", () => {
  it("keeps process binding identity distinct from the shared executable name", () => {
    const artifact = withProfileName(generatedModule(16, false, 1, true),
      "oxidevm_tb_0123456789abcdef_r0000000000000010");
    for (const id of [7n, 8n]) {
      expect(decodeSystemJitModuleMap(withBindingIdentity(artifact, id, 3n))).toMatchObject({
        profileModuleId: id.toString(16).padStart(16, "0"),
        artifactProfileModuleId: "0123456789abcdef",
        bindingIdentity: { id, originBindingId: 3n },
      });
    }
  });

  it("rejects malformed or duplicate process binding identities", () => {
    const artifact = generatedModule(16, false, 1, true);
    for (const [id, origin] of [[0n, 0n], [7n, 0n], [7n, 8n]] as const) {
      expect(() => decodeSystemJitModuleMap(withBindingIdentity(artifact, id, origin))).toThrow();
    }
    const valid = withBindingIdentity(artifact, 7n, 3n);
    expect(() => decodeSystemJitModuleMap(withBindingIdentity(valid, 8n, 3n))).toThrow();
  });
  it("decodes the generated instruction map without compiling the module", () => {
    expect(decodeSystemJitRipMap(generatedModule(16, false, 1, true))).toEqual([
      { rip: 16n, semantic: 0, retired: 1, instructionForm: 0 },
    ]);
    expect(() =>
      decodeSystemJitRipMap(generatedModule(16, false, 1, true).subarray(0, 8)),
    ).toThrow(TypeError);
    expect(() =>
      decodeSystemJitRipMap(
        generatedModule(16, false, JIT_REGION_MAX_INSTRUCTIONS + 1, true),
      ),
    ).toThrow(TypeError);
    expect(decodeSystemJitRipMap(generatedModule(16, false, 1, true, 1))).toEqual([
      { rip: 16n, semantic: 0, retired: 1, instructionForm: 0 },
    ]);
    expect(() =>
      decodeSystemJitRipMap(generatedModule(16, false, 1, true, 2)),
    ).toThrow(TypeError);
    const memory = new WebAssembly.Memory({ initial: 1 });
    new DataView(memory.buffer).setUint32(
      23_400,
      JIT_DISPATCH_TABLE_ENTRIES,
      true,
    );
    expect(readSystemJitLastDispatchSlot(memory, 0)).toBeNull();
    expect(() =>
      readSystemJitLastDispatchSlot(memory, memory.buffer.byteLength),
    ).toThrow(TypeError);
  });

  it("decodes emitted IR disposition without erasing source identity", () => {
    expect(decodeSystemJitModuleMap(generatedModule(16, false, 1, true))).toEqual({
      profileModuleId: null,
      recordedProfileGeneration: null,
      runtimeIdentity: null,
      aotTrainingSource: null,
      loopPolicy: null,
      instructions: [{ rip: 16n, semantic: 0, retired: 1, instructionForm: 0 }],
      operations: [
        {
          instructionIndex: 0,
          sourceIndex: 0,
          disposition: "emitted",
          emittedStart: 0,
          emittedEnd: 1,
          wireStart: 281,
          wireEnd: 282,
          instructionForm: 0,
          operationKind: 0,
          proofCostClass: "unchanged-generated-work",
          span: "ordinary",
        },
      ],
      tier: "tier1",
      plan: {
        initialStateMask: 3n,
        dirtyStateMask: 5n,
        stateMaterializationBoundaries: 2,
        segmentGuards: 1,
      },
    });
  });

  it("decodes every documented profile trace function suffix", () => {
    for (const suffix of ["", "_record", "_profile"] as const) {
      expect(
        decodeSystemJitModuleMap(
          withProfileName(
            generatedModule(16, false, 1, true),
            `oxidevm_tb_0123456789abcdef_r0000000000000010${suffix}`,
          ),
        ).profileModuleId,
      ).toBe("0123456789abcdef");
    }
    expect(
      decodeSystemJitModuleMap(
        withProfileName(
          generatedModule(16, false, 1, true),
          "oxidevm_tb_0123456789abcdef_r0000000000000010_unknown",
        ),
      ).profileModuleId,
    ).toBeNull();
  });

  it("keeps specialized and guard spans attached to the original operation", () => {
    const bytes = generatedModule(16, false, 2, true, 0, 2, 1n, false, 0, false, 0, false, [0, 1, 8, 8, 13]);
    const decoded = decodeSystemJitModuleMap(bytes);
    expect(decoded.operations.slice(0, 5).map((operation) => operation.span)).toEqual(["ordinary", "specialized", "guard-page", "guard-page", "loop-control"]);
    expect(decoded.operations.slice(0, 5).every((operation) => operation.instructionIndex === 0 && operation.sourceIndex === 0)).toBe(true);
    expect(() => decodeSystemJitModuleMap(generatedModule(16, false, 2, true, 0, 2, 1n, false, 0, false, 0, false, [0, 14]))).toThrow();
    expect(() => decodeSystemJitModuleMap(generatedModule(16, false, 2, true, 0, 2, 1n, false, 0, false, 0, false, [1, 0]))).toThrow();
    const policy: number[] = [];
    name(policy, "oxidevm.loop-policy");
    policy.push(1, 0, 0, 0, 1, 10, 2, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 8, ...new Uint8Array(16));
    const selected = Array.from(bytes); section(selected, 0, policy);
    expect(decodeSystemJitModuleMap(new Uint8Array(selected)).loopPolicy?.decision).toBe("selected");
    const wrongTier = Array.from(generatedModule(16, false, 2, true, 0, 1, null, false, 0, false, 0, false, [0, 1]));
    section(wrongTier, 0, policy);
    expect(() => decodeSystemJitModuleMap(new Uint8Array(wrongTier))).toThrow("source spans");
    const missingBody = Array.from(generatedModule(16, false, 2, true, 0, 2, 1n, false, 0, false, 0, false, [0]));
    section(missingBody, 0, policy);
    expect(() => decodeSystemJitModuleMap(new Uint8Array(missingBody))).toThrow("source spans");
  });

  it("decodes exact Tier-2 profile-generation identity", () => {
    expect(
      decodeSystemJitModuleMap(
        generatedModule(16, false, 1, true, 0, 2, 0x1020_3040_5060_7080n),
      ),
    ).toMatchObject({
      tier: "tier2",
      recordedProfileGeneration: 0x1020_3040_5060_7080n,
    });
    expect(() =>
      decodeSystemJitModuleMap(generatedModule(16, false, 1, true, 0, 1, 1n))
    ).toThrow(TypeError);
  });

  it("decodes versioned exact Tier-2 source without admitting it as Tier-1", () => {
    const bytes = generatedModule(16, false, 256, true, 0, 2, 7n, true, 0, true);
    const decoded = decodeSystemJitModuleMap(bytes);
    expect(decoded.tier).toBe("tier2");
    expect(decoded.aotTrainingSource?.version).toBe(2);
    expect(decoded.aotTrainingSource?.instructions).toHaveLength(256);
    expect(decoded.aotTrainingSource?.instructions[0]).toMatchObject({
      rip: 16n, bytes: "90", semantic: 0, instructionForm: 0,
    });
    expect(decoded.instructions).toHaveLength(256);
  });

  it("decodes exact code-segment dependencies in runtime identity version 4", () => {
    const bytes = generatedModule(16, false, 1, true, 0, 1, null, true, 0, false, 0, true, undefined, true);
    expect(decodeSystemJitModuleMap(bytes).runtimeIdentity).toMatchObject({
      mode: "protected", codeSegmentBase: 0x1000n, codeSegmentLimit: 0x1234,
    });
  });

  it("decodes capability revisions and rejects malformed runtime identity", () => {
    const bytes = generatedModule(16, false, 1, true, 0, 1, null, true, 0, false, 0, true);
    const section = new Uint8Array(WebAssembly.Module.customSections(new WebAssembly.Module(bytes), "oxidevm.runtime-identity")[0] ?? new ArrayBuffer(0));
    const start = bytes.findIndex((_, index) => section.every((value, offset) => bytes[index + offset] === value));
    expect(start).toBeGreaterThan(0);
    new DataView(bytes.buffer).setUint32(start, 3, true);
    bytes[start + 10] = 1;
    expect(decodeSystemJitModuleMap(bytes).runtimeIdentity?.capabilityRevision).toBe(1);
    bytes[start + 10] = 0;
    expect(decodeSystemJitModuleMap(bytes).runtimeIdentity?.capabilityRevision).toBe(0);
    for (const revision of [2, 255]) {
      bytes[start + 10] = revision;
      expect(() => decodeSystemJitModuleMap(bytes)).toThrow(TypeError);
    }
    bytes[start + 10] = 1;
    bytes[start + 11] = 1;
    expect(() => decodeSystemJitModuleMap(bytes)).toThrow(TypeError);
  });

  it("decodes exact runtime CPU and physical-code identity", () => {
    expect(
      decodeSystemJitModuleMap(
        generatedModule(16, false, 1, true, 0, 1, null, true),
      ).runtimeIdentity,
    ).toEqual({
      mode: "long",
      cpl: 3,
      profile: "x86-64-v2",
      codeAttributes: 0x1234,
      codeSegmentBase: null,
      codeSegmentLimit: null,
      capabilityRevision: 0,
      addressSpaceId: null,
      addressSpaceScoped: false,
      codePages: [{
        linear: 0x1000n,
        physical: 0x9000n,
        generation: 17n,
        globalSupervisor: true,
      }],
    });
    expect(() =>
      decodeSystemJitModuleMap(
        generatedModule(16, false, 1, true, 0, 1, null, true, 1),
      )
    ).toThrow(TypeError);
  });

  it("decodes profile-only address-space identity without weakening page identity", () => {
    expect(
      decodeSystemJitModuleMap(
        generatedModule(16, false, 1, true, 0, 1, null, true, 0, false, 0, true),
      ).runtimeIdentity,
    ).toMatchObject({
      addressSpaceId: 0x1234_5000n,
      addressSpaceScoped: true,
    });
  });

  it("decodes exact AOT training bytes and regional edge identity", () => {
    expect(
      decodeSystemJitModuleMap(
        generatedModule(16, false, 1, true, 0, 1, null, true, 0, true),
      ).aotTrainingSource,
    ).toEqual({
      version: 1,
      instructions: [{
        rip: 16n,
        bytes: "90",
        semantic: 0,
        instructionForm: 0,
        edge: { kind: "direct", target: 32n },
      }],
    });
    expect(() =>
      decodeSystemJitModuleMap(
        generatedModule(16, false, 1, true, 0, 1, null, true, 0, true, 1),
      )
    ).toThrow(TypeError);
  });

  it("decodes cache epochs and pending writes at the Rust JIT boundary", () => {
    const bytes = new Uint8Array(JIT_CONTEXT_LENGTH);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(224, 1n, true);
    view.setUint32(232, 7, true);
    view.setUint32(236, 11, true);
    view.setBigUint64(22_768, 13n, true);
    view.setBigUint64(22_856, 0x1234_5000n, true);
    view.setUint32(23_400, 17, true);
    view.setUint32(23_404, 31, true);
    view.setBigUint64(23_408, 19n, true);
    view.setBigUint64(23_416, 23n, true);
    view.setBigUint64(140, 0x1234n, true);
    view.setUint8(156, 1);
    view.setBigUint64(208, 29n, true);

    expect(
      readSystemJitContextDiagnostics({ buffer: bytes.buffer }, 0),
    ).toEqual({
      cr3: 0x1234_5000n,
      forceExit: true,
      entryIndex: 7,
      readEpoch: 11,
      writeEpoch: 13n,
      lastDispatchSlot: 17,
      dispatchEpoch: 19n,
      pendingWrites: 23n,
    });
    expect(
      readSystemJitExecutionDiagnostics({ buffer: bytes.buffer }, 0),
    ).toEqual({
      rip: 0x1234n,
      retired: 29n,
      halted: true,
      lastDispatchSlot: 17,
      chainTransitions: 31,
    });
  });
});

function withBindingIdentity(module: Uint8Array, id: bigint, origin: bigint): Uint8Array<ArrayBuffer> {
  const bytes = Array.from(module);
  const identity: number[] = [];
  name(identity, "oxidevm.binding-identity");
  littleU32(identity, 1);
  littleU64(identity, id);
  littleU64(identity, origin);
  section(bytes, 0, identity);
  return new Uint8Array(bytes);
}

function generatedModule(
  result: number,
  withShaHelper = false,
  instructionCount = 1,
  withIrMap = false,
  nameSections = 0,
  tier: 1 | 2 = 1,
  recordedProfileGeneration: bigint | null = null,
  withRuntimeIdentity = false,
  runtimeReserved = 0,
  withAotTrainingSource = false,
  aotReserved = 0,
  runtimeIdentityV2 = false,
  spans?: readonly number[],
  runtimeIdentityV4 = false,
): Uint8Array<ArrayBuffer> {
  const module = [0, 97, 115, 109, 1, 0, 0, 0];
  section(module, 1, [
    7,
    0x60, 2, 0x7f, 0x7e, 1, 0x7f,
    0x60, 6, 0x7f, 0x7e, 0x7f, 0x7e, 0x7e, 0x7e, 1, 0x7f,
    0x60, 4, 0x7f, 0x7f, 0x7e, 0x7e, 1, 0x7e,
    0x60, 5, 0x7f, 0x7f, 0x7e, 0x7e, 0x7e, 1, 0x7f,
    0x60, 2, 0x7e, 0x7e, 1, 0x7f,
    0x60, 3, 0x7f, 0x7e, 0x7f, 1, 0x7f,
    0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 0,
  ]);
  const imports: number[] = [];
  u32(imports, 8);
  imported(imports, "memory", [2, 0, 0]);
  imported(imports, "dispatch_table", [1, 0x70, 0, 0x80, 0x40]);
  imported(imports, "memory_access", [0, 1]);
  imported(imports, "port_input", [0, 2]);
  imported(imports, "port_output", [0, 3]);
  imported(imports, "invalidate_page", [0, 4]);
  imported(imports, "timestamp_counter", [0, 4]);
  imported(imports, "side_exit", [0, 5]);
  section(module, 2, imports);
  section(module, 3, withShaHelper ? [3, 0, 0, 6] : [2, 0, 0]);
  const exports: number[] = [];
  u32(exports, 2);
  name(exports, "run");
  exports.push(0, 7);
  name(exports, "trace");
  exports.push(0, 6);
  section(module, 7, exports);
  const code: number[] = [];
  u32(code, withShaHelper ? 3 : 2);
  sized(
    code,
    withShaHelper
      ? [0, 0x41, 0, 0x41, 0, 0x41, 0, 0x41, 0, 0x10, 8, 0x41, result, 0x0b]
      : [0, 0x41, result, 0x0b],
  );
  sized(code, [0, 0x41, 0, 0x0b]);
  if (withShaHelper) sized(code, [0, 0x0b]);
  section(module, 10, code);
  for (let index = 0; index < nameSections; index += 1) {
    const names: number[] = [];
    name(names, "name");
    section(module, 0, names);
  }
  const ripMap: number[] = [];
  name(ripMap, "oxidevm.rip-map");
  littleU32(ripMap, 2);
  littleU32(ripMap, instructionCount);
  for (let index = 0; index < instructionCount; index += 1) {
    littleU64(ripMap, BigInt(result + index));
    ripMap.push(0, 0, 0, 0, 1, 0, 0);
  }
  section(module, 0, ripMap);
  if (withIrMap) {
    const irMap: number[] = [];
    name(irMap, "oxidevm.ir-map");
    littleU32(irMap, spans === undefined ? 5 : 6);
    littleU32(irMap, instructionCount * (spans?.length ?? 1));
    littleU32(irMap, 3);
    littleU32(irMap, 0);
    littleU32(irMap, 5);
    littleU32(irMap, 0);
    littleU32(irMap, 2);
    littleU32(irMap, 1);
    irMap.push(tier, 0, 0, 0);
    for (let index = 0; index < instructionCount; index += 1) {
      for (const [spanIndex, span] of (spans ?? [0]).entries()) {
      irMap.push(index & 0xff, index >> 8, 0, 0);
      littleU32(irMap, spanIndex);
      littleU32(irMap, spanIndex + 1);
      irMap.push(0, 0, 0, 0, 7, span);
      }
    }
    section(module, 0, irMap);
  }
  if (recordedProfileGeneration !== null) {
    const identity: number[] = [];
    name(identity, "oxidevm.tier2-profile");
    littleU32(identity, 1);
    littleU64(identity, recordedProfileGeneration);
    section(module, 0, identity);
  }
  if (withRuntimeIdentity) {
    const identity: number[] = [];
    name(identity, "oxidevm.runtime-identity");
    littleU32(identity, runtimeIdentityV4 ? 4 : runtimeIdentityV2 ? 2 : 1);
    identity.push(runtimeIdentityV4 ? 1 : 3, 3, 1, runtimeIdentityV2 ? 1 : runtimeReserved, 0x34, 0x12, 0, 0);
    littleU32(identity, 1);
    if (runtimeIdentityV2) littleU64(identity, 0x1234_5000n);
    if (runtimeIdentityV4) {
      littleU64(identity, 0x1000n);
      littleU32(identity, 0x1234);
      littleU32(identity, 0);
    }
    littleU64(identity, 0x1000n);
    littleU64(identity, 0x9000n);
    littleU64(identity, 17n);
    identity.push(1, 0, 0, 0, 0, 0, 0, 0);
    section(module, 0, identity);
  }
  if (withAotTrainingSource) {
    const training: number[] = [];
    name(training, "oxidevm.aot-training");
    littleU32(training, tier);
    littleU32(training, instructionCount);
    for (let index = 0; index < instructionCount; index += 1) {
      littleU64(training, BigInt(result + index));
      training.push(1, 0x90, ...Array.from({ length: 14 }, () => 0));
      training.push(1, 0, 0, 0, 0, 0, 0, aotReserved);
      littleU64(training, 32n);
      littleU64(training, 0n);
    }
    section(module, 0, training);
  }
  return new Uint8Array(module);
}

function littleU32(output: number[], value: number): void {
  output.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24);
}

function withProfileName(module: Uint8Array, functionName: string): Uint8Array<ArrayBuffer> {
  const output = Array.from(module);
  const functionNames: number[] = [];
  u32(functionNames, 1);
  u32(functionNames, 7);
  name(functionNames, functionName);
  const nameSection = [1];
  sized(nameSection, functionNames);
  const payload: number[] = [];
  name(payload, "name");
  payload.push(...nameSection);
  section(output, 0, payload);
  return new Uint8Array(output);
}

function littleU64(output: number[], value: bigint): void {
  for (let shift = 0n; shift < 64n; shift += 8n) {
    output.push(Number(value >> shift & 0xffn));
  }
}

function imported(output: number[], field: string, descriptor: readonly number[]): void {
  name(output, "oxidevm");
  name(output, field);
  output.push(...descriptor);
}

function section(output: number[], id: number, payload: readonly number[]): void {
  output.push(id);
  sized(output, payload);
}

function sized(output: number[], payload: ArrayLike<number>): void {
  u32(output, payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    const value = payload[index];
    if (value === undefined) throw new TypeError("invalid test Wasm bytes");
    output.push(value);
  }
}

function name(output: number[], value: string): void {
  sized(output, new TextEncoder().encode(value));
}

function u32(output: number[], value: number): void {
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    output.push(byte | (value === 0 ? 0 : 0x80));
  } while (value !== 0);
}
