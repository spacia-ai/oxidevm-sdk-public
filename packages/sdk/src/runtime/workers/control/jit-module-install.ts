import { VMError } from "../../errors.js";
import type { SystemTraceJitArtifact } from "../../protocol.js";
import {
  decodeSystemJitModuleMap,
  type JitModuleTraceMap,
} from "../../protocol/system-trace-jit.js";
import type { Core, JitBlock } from "./core.js";
import { type CompiledJitAction, installJitBlock, jitDispatchers } from "./jit-blocks.js";
import { nextGeneration, retainProfileJitModule } from "./jit-runtime-helpers.js";
import { engineJitCall } from "./jit-health.js";
import type { JitCodeUnit } from "./jit-code-budget.js";
import { recordJitDistance } from "./telemetry.js";
import { recordSystemTrace, systemTraceBase, systemTraceEnabled } from "./trace.js";


/** Turns the translated modules a Compile action stages into installed JIT blocks. The
 * synchronous compile path and the background one share every step after compilation. */

/** A Compile action's module, decoded before it is compiled. */
export interface PreparedJitModule {
  readonly action: CompiledJitAction;
  readonly moduleLength: number;
  readonly moduleMap: JitModuleTraceMap;
  /** The module's estimated executable memory standalone, which its compile reserves. */
  readonly codeBytes: number;
  readonly entry: Omit<Parameters<typeof installJitBlock>[3], "codeUnit"> & {
    readonly instructionCount: number;
  };
}

export function prepareJitModule(
  loaded: Core,
  action: CompiledJitAction,
  artifactKey: string,
  bindingKey: string,
  moduleBytes: Uint8Array,
): PreparedJitModule {
  const moduleMap = { ...decodeSystemJitModuleMap(moduleBytes), artifactIdentity: { cacheKey: action.artifactCacheKey, moduleLength: action.artifactModuleLength } };
  recordJitCandidate(loaded, action.instructionCount, moduleBytes.byteLength);
  return {
    action,
    moduleLength: moduleBytes.byteLength,
    moduleMap,
    codeBytes: loaded.jitCode.estimate(moduleBytes.byteLength),
    entry: {
      cacheKey: action.cacheKey,
      bindingKey,
      artifactCacheKey: action.artifactCacheKey,
      artifact: { kind: "dynamic" },
      key: artifactKey,
      tier: moduleMap.tier,
      instructionCount: action.instructionCount,
      instructions: moduleMap.instructions,
      profileModuleId: moduleMap.profileModuleId,
      bindingId: moduleMap.bindingIdentity?.id,
      compileGeneration: nextCompileGeneration(loaded),
      ...(action.artifactModuleLength < moduleBytes.byteLength ? {
        executableBytes: moduleBytes.slice(0, action.artifactModuleLength),
      } : {}),
    },
  };
}

/** How long a module took to compile and instantiate, as charged to one installed block. */
export interface JitInstallTiming {
  readonly compileMilliseconds: number;
  readonly instantiationMilliseconds: number;
}

/** Instantiates a compiled module and installs it as the block for its artifact. */
export function installCompiledJitModule(
  loaded: Core,
  prepared: PreparedJitModule,
  module: WebAssembly.Module,
  compileMilliseconds: number,
): JitBlock {
  const instantiateStarted = performance.now();
  const instance = instantiateCompiledJitModule(module, jitImports(loaded));
  const instantiationMilliseconds = performance.now() - instantiateStarted;
  loaded.traceProfile.worker.instantiateMilliseconds += instantiationMilliseconds;
  const codeUnit = loaded.jitCode.register(instance, prepared.codeBytes);
  return installJitModuleMember(
    loaded,
    prepared,
    {
      instance,
      codeUnit,
      trace: instance.exports["trace"],
      recordTrace: instance.exports["record_trace"],
    },
    { compileMilliseconds, instantiationMilliseconds },
  );
}

/** A linked module's instance: member `i`'s traces are entry `i` of its member tables. Every
 * installed member holds the one code unit; the instance's code is freed only after the last
 * member leaves the store. */
export interface LinkedJitInstance {
  readonly instance: WebAssembly.Instance;
  readonly codeUnit: JitCodeUnit;
  readonly memberTable: WebAssembly.Table;
  readonly recordMemberTable: WebAssembly.Table;
}

/** Instantiates a compiled linked module of `members` members once for all of them; its code
 * unit is estimated from the linked module's `linkedBytes`. */
export function instantiateLinkedJitModule(
  loaded: Core,
  module: WebAssembly.Module,
  members: number,
  linkedBytes: number,
): LinkedJitInstance & { readonly instantiationMilliseconds: number } {
  const started = performance.now();
  const imports = jitImports(loaded);
  const instance = engineJitCall(
    "instantiation",
    () => new WebAssembly.Instance(module, imports),
  );
  const instantiationMilliseconds = performance.now() - started;
  loaded.traceProfile.worker.instantiateMilliseconds += instantiationMilliseconds;
  const memberTable: unknown = instance.exports["member_table"];
  const recordMemberTable: unknown = instance.exports["record_member_table"];
  if (
    !(memberTable instanceof WebAssembly.Table) ||
    !(recordMemberTable instanceof WebAssembly.Table) ||
    memberTable.length !== members ||
    recordMemberTable.length !== members
  ) {
    throw new VMError("VM_FAULT", "linked JIT module member tables are invalid");
  }
  const codeUnit = loaded.jitCode.register(instance, loaded.jitCode.estimate(linkedBytes));
  return { instance, codeUnit, memberTable, recordMemberTable, instantiationMilliseconds };
}

/** Installs member `memberIndex` of a linked module as the block for its artifact. */
export function installLinkedJitMember(
  loaded: Core,
  prepared: PreparedJitModule,
  linked: LinkedJitInstance,
  artifact: Extract<SystemTraceJitArtifact, { readonly kind: "linked" }>,
  timing: JitInstallTiming,
): JitBlock {
  const trace: unknown = linked.memberTable.get(artifact.memberIndex);
  const recordTrace: unknown = linked.recordMemberTable.get(artifact.memberIndex);
  return installJitModuleMember(
    loaded,
    { ...prepared, entry: { ...prepared.entry, artifact } },
    { instance: linked.instance, codeUnit: linked.codeUnit, trace, recordTrace },
    timing,
  );
}

/** Installs one compiled translation and records its compile in the worker profile. */
function installJitModuleMember(
  loaded: Core,
  prepared: PreparedJitModule,
  code: {
    readonly instance: WebAssembly.Instance;
    readonly codeUnit: JitCodeUnit;
    readonly trace: unknown;
    readonly recordTrace: unknown;
  },
  { compileMilliseconds, instantiationMilliseconds }: JitInstallTiming,
): JitBlock {
  const worker = loaded.traceProfile.worker;
  const installStarted = performance.now();
  const block = installJitBlock(
    loaded,
    prepared.moduleLength + (prepared.entry.executableBytes?.byteLength ?? 0),
    code.instance,
    { ...prepared.entry, codeUnit: code.codeUnit },
    code.trace,
    code.recordTrace,
  );
  loaded.jitCode.addMember(code.codeUnit);
  const installationMilliseconds = performance.now() - installStarted;
  worker.installMilliseconds += installationMilliseconds;
  const { moduleMap } = prepared;
  recordJitCompilation(
    loaded,
    prepared.entry.key,
    prepared.entry.instructionCount,
    prepared.moduleLength,
  );
  for (const operation of moduleMap.operations) {
    worker[`${operation.disposition}IrOperations`] += 1;
  }
  worker.initialStateMask |= moduleMap.plan.initialStateMask;
  worker.dirtyStateMask |= moduleMap.plan.dirtyStateMask;
  worker.stateMaterializationBoundaries += moduleMap.plan.stateMaterializationBoundaries;
  worker.segmentGuards += moduleMap.plan.segmentGuards;
  retainProfileJitModule(loaded, moduleMap, prepared.action.cacheKey, {
    emissions: 1,
    emittedBytes: prepared.moduleLength,
    compilationMilliseconds: compileMilliseconds,
    instantiationMilliseconds,
    installationMilliseconds,
    outerEntries: 0,
    outerRetired: 0n,
  });
  if (systemTraceEnabled(loaded)) {
    recordSystemTrace(loaded, {
      kind: "compile",
      ...systemTraceBase(loaded),
      startRip: prepared.action.startRip,
      cacheKey: prepared.action.cacheKey,
      dispatchSlot: block.slot,
      moduleBytes: prepared.moduleLength,
      compileMilliseconds,
      instructions: moduleMap.instructions,
    });
  }
  return block;
}

function recordJitCandidate(
  loaded: Core,
  instructionCount: number,
  byteLength: number,
): void {
  const profile = loaded.traceProfile.worker;
  profile.maximumCandidateInstructions = Math.max(
    profile.maximumCandidateInstructions,
    instructionCount,
  );
  profile.maximumCandidateBytes = Math.max(
    profile.maximumCandidateBytes,
    byteLength,
  );
}

/** Counts one compiled module, wherever it was compiled. */
export function recordJitCompilation(
  loaded: Pick<
    Core,
    "traceProfile" | "compiledJitKeys" | "evictedJitKeys" | "jitBlockUse"
  >,
  key: string,
  instructionCount: number,
  byteLength: number,
): void {
  const profile = loaded.traceProfile.worker;
  profile.compileModules += 1;
  profile.compiledInstructions += BigInt(instructionCount);
  profile.compileBytes += byteLength;
  const evictedAt = loaded.evictedJitKeys.get(key);
  if (evictedAt !== undefined) {
    profile.dispatchSubsequentRecompiles += 1;
    recordJitDistance(
      profile.dispatchRecompileReuseDistance,
      Math.max(0, loaded.jitBlockUse - evictedAt),
    );
    loaded.evictedJitKeys.delete(key);
  }
  if (loaded.compiledJitKeys.has(key)) {
    profile.recompiledModules += 1;
  } else {
    loaded.compiledJitKeys.add(key);
    profile.firstCompileModules += 1;
  }
}

/** Compiles `moduleBytes` on the calling thread; the engine's refusal is a `JitModuleFailure`. */
export function compileJitModule(moduleBytes: Uint8Array<ArrayBuffer>): WebAssembly.Module {
  return engineJitCall("synchronous-compile", () => new WebAssembly.Module(moduleBytes));
}

/** Compiles and instantiates `moduleBytes` on the calling thread (immediate install). */
export function instantiateJitModule(
  moduleBytes: Uint8Array<ArrayBuffer>,
  imports: WebAssembly.Imports,
): WebAssembly.Instance {
  return instantiateCompiledJitModule(compileJitModule(moduleBytes), imports);
}

export function instantiateCompiledJitModule(
  module: WebAssembly.Module,
  imports: WebAssembly.Imports,
): WebAssembly.Instance {
  const instance = engineJitCall("instantiation", () => new WebAssembly.Instance(module, imports));
  if (
    typeof instance.exports["trace"] !== "function" ||
    typeof instance.exports["record_trace"] !== "function"
  ) {
    throw new VMError(
      "VM_FAULT",
      "compiled JIT block has invalid exports",
    );
  }
  return instance;
}

export function jitImports(loaded: Core): WebAssembly.Imports {
  const memoryAccess = loaded.exports["oxidevm_jit_memory_access"];
  const floatingPoint = loaded.exports["oxidevm_jit_floating_point"];
  const invalidatePage = loaded.exports["oxidevm_jit_invalidate_page"];
  const timestampCounter = loaded.exports["oxidevm_jit_timestamp_counter"];
  const stackFrame = loaded.exports["oxidevm_jit_stack_frame"];
  const enterFrame = loaded.exports["oxidevm_jit_enter_frame"];
  const stackRegisters = loaded.exports["oxidevm_jit_stack_registers"];
  const segmentLoad = loaded.exports["oxidevm_jit_segment_load"];
  const cpuid = loaded.exports["oxidevm_jit_cpuid"];
  const msr = loaded.exports["oxidevm_jit_msr"];
  const controlRegister = loaded.exports["oxidevm_jit_control_register"];
  const descriptorQuery = loaded.exports["oxidevm_jit_descriptor"];
  const tlb = loaded.exports["oxidevm_jit_tlb"];
  const farControl = loaded.exports["oxidevm_jit_far_control"];
  const randomWord = loaded.exports["oxidevm_jit_random_word"];
  const ioInstruction = loaded.exports["oxidevm_jit_io_instruction"];
  const sideExit = loaded.exports["oxidevm_jit_chain"];
  if (
    typeof memoryAccess !== "function" ||
    typeof floatingPoint !== "function" ||
    typeof invalidatePage !== "function" ||
    typeof timestampCounter !== "function" ||
    typeof stackFrame !== "function" ||
    typeof enterFrame !== "function" ||
    typeof stackRegisters !== "function" ||
    typeof segmentLoad !== "function" ||
    typeof cpuid !== "function" ||
    typeof msr !== "function" ||
    typeof controlRegister !== "function" ||
    typeof descriptorQuery !== "function" ||
    typeof tlb !== "function" ||
    typeof farControl !== "function" ||
    typeof randomWord !== "function" ||
    typeof ioInstruction !== "function" ||
    typeof sideExit !== "function"
  ) {
    throw new VMError(
      "CORE_LOAD_FAILED",
      "compiled JIT boundary is missing",
    );
  }
  return {
    oxidevm: {
      memory: loaded.memory,
      memory_access: memoryAccess,
      floating_point: floatingPoint,
      retirement_prefix: jitDispatchers(loaded).retirePrefix,
      invalidate_page: invalidatePage,
      timestamp_counter: timestampCounter,
      stack_frame: stackFrame,
      enter_frame: enterFrame,
      stack_registers: stackRegisters,
      segment_load: segmentLoad,
      cpuid: cpuid,
      msr: msr,
      control_register: controlRegister,
      descriptor: descriptorQuery,
      tlb: tlb,
      far_control: farControl,
      random_word: randomWord,
      io_instruction: ioInstruction,
      side_exit: sideExit,
      dispatch_table: loaded.jitTable,
      record_dispatch_table: loaded.jitRecordingTable,
    },
  };
}

export function nextCompileGeneration(loaded: Core): number {
  loaded.nextJitCompileGeneration = nextGeneration(loaded.nextJitCompileGeneration);
  return loaded.nextJitCompileGeneration;
}
