import {
  type BoundedRing,
  createBoundedRing,
} from "../../bounded-ring.js";
import { assertBrowserSupport } from "../../browser-support.js";
import { CORE_API_VERSION, createCoreEntropyImport, unsignedWasmPointer } from "../../core-abi.js";
import { JIT_API_VERSION } from "../../core-abi/jit.ts";
import { decodeCoreRuntimeProfile } from "../../core-abi/profile.js";
import { record } from "../../decode.js";
import {
  type DiskBridgeImports,
  unavailableDiskBridgeImports,
} from "../../disk-bridge.js";
import { VMError } from "../../errors.js";
import type { JitModuleTraceMap, JitTraceInstruction } from "../../protocol/system-trace-jit.js";
import { JIT_CACHE_BYTES, JIT_DISPATCH_TABLE_ENTRIES } from "../../jit-cache.js";
import type {
  CoreProbeExit,
  SystemTraceCpu,
  SystemTraceEvent,
  SystemTraceJitArtifact,
  SystemTraceJitOperationSample,
  SystemTraceJitEdgeSample,
  SystemTraceProfile,
  SystemTraceRipRange,
  SystemTraceSnapshot,
} from "../../protocol.js";
import {
  type MutableRuntimeStats,
  type MutableSystemTraceProfile,
  createSystemTraceProfile,
} from "./telemetry.js";
import { ProfileJitModuleStore } from "./jit-aot-training.js";
import { createJitHealth, type MutableJitHealth } from "./jit-health.js";
import { JitCodeBudget, type JitCodeUnit } from "./jit-code-budget.js";
import { jitEnginePolicy, type JitEnginePolicy } from "./jit-engine-policy.js";

export { CORE_API_VERSION };

export function withCoreSteps(exit: CoreProbeExit, steps: bigint): CoreProbeExit {
  switch (exit.kind) {
    case "halted":
    case "step-limit":
      return { kind: exit.kind, steps };
    case "exception":
      return { kind: exit.kind, steps, exception: exit.exception };
    case "reset":
      return { kind: exit.kind, steps, reason: exit.reason };
  }
}

const COMPILE_LATENCY_BUCKETS = 1_001;
const CORE_FUNCTIONS = [
  "oxidevm_api_version",
  "oxidevm_reset",
  "oxidevm_staging_resize",
  "oxidevm_staging_ptr",
  "oxidevm_load_memory",
  "oxidevm_read_memory",
  "oxidevm_load_cpu_state",
  "oxidevm_run",
  "oxidevm_entropy_capture",
  "oxidevm_entropy_record",
  "oxidevm_entropy_replay",
  "oxidevm_entropy_live",
  "oxidevm_system_create",
  "oxidevm_system_cpu_count",
  "oxidevm_system_select_cpu",
  "oxidevm_system_parallel_enable",
  "oxidevm_system_parallel_disable",
  "oxidevm_system_parallel_generation",
  "oxidevm_system_run_vcpu",
  "oxidevm_system_vcpu_result_ptr",
  "oxidevm_system_vcpu_result_len",
  "oxidevm_system_service_devices",
  "oxidevm_system_pending_block_requests",
  "oxidevm_system_seed_rtc",
  "oxidevm_system_load_asset",
  "oxidevm_system_use_host_disk",
  "oxidevm_system_boot",
  "oxidevm_system_sync_clock",
  "oxidevm_system_snapshot",
  "oxidevm_system_dirty_ram_chunks",
  "oxidevm_system_read_ram_chunk",
  "oxidevm_system_snapshot_commit_ram",
  "oxidevm_system_mark_ram_dirty",
  "oxidevm_system_dirty_disk_chunks",
  "oxidevm_system_read_disk_chunk",
  "oxidevm_system_restore_validate",
  "oxidevm_system_restore_begin",
  "oxidevm_system_restore_ram_chunk",
  "oxidevm_system_restore_disk_chunk",
  "oxidevm_system_restore_finish",
  "oxidevm_system_restore_abort",
  "oxidevm_system_clock_mode",
  "oxidevm_system_console_input",
  "oxidevm_system_console_output",
  "oxidevm_system_console_input_selected",
  "oxidevm_system_console_output_selected",
  "oxidevm_system_console_resize",
  "oxidevm_system_agent_input",
  "oxidevm_system_agent_output",
  "oxidevm_system_network_attach",
  "oxidevm_system_network_take",
  "oxidevm_system_network_give",
  "oxidevm_system_network_counters",
  "oxidevm_jit_api_version",
  "oxidevm_jit_quarantine_clear",
  "oxidevm_jit_quarantine_add",
  "oxidevm_jit_quarantine_range_add",
  "oxidevm_jit_next",
  "oxidevm_jit_chain",
  "oxidevm_jit_register",
  "oxidevm_jit_unregister",
  "oxidevm_jit_memory_access",
  "oxidevm_jit_floating_point",
  "oxidevm_jit_invalidate_page",
  "oxidevm_jit_timestamp_counter",
  "oxidevm_jit_stack_frame",
  "oxidevm_jit_enter_frame",
  "oxidevm_jit_stack_registers",
  "oxidevm_jit_segment_load",
  "oxidevm_jit_cpuid",
  "oxidevm_jit_msr",
  "oxidevm_jit_control_register",
  "oxidevm_jit_descriptor",
  "oxidevm_jit_tlb",
  "oxidevm_jit_far_control",
  "oxidevm_jit_random_word",
  "oxidevm_jit_io_instruction",
  "oxidevm_jit_complete",
  "oxidevm_jit_completion_failure",
  "oxidevm_jit_action_ptr",
  "oxidevm_jit_action_len",
  "oxidevm_jit_module_ptr",
  "oxidevm_jit_module_len",
  "oxidevm_jit_dispatcher_module_ptr",
  "oxidevm_jit_dispatcher_module_len",
  "oxidevm_jit_forget_pending",
  "oxidevm_jit_binding_is_live",
  "oxidevm_jit_defer",
  "oxidevm_jit_compile_settled",
  "oxidevm_jit_link_modules",
  "oxidevm_jit_linked_module_ptr",
  "oxidevm_jit_linked_module_len",
  "oxidevm_jit_aot_catalog_install",
  "oxidevm_jit_aot_catalog_clear",
  "oxidevm_jit_aot_pending_ptr",
  "oxidevm_jit_aot_pending_len",
  "oxidevm_jit_aot_decline",
  "oxidevm_jit_aot_register",
  "oxidevm_jit_context_ptr",
  "oxidevm_jit_context_len",
  "oxidevm_jit_interpreted_steps",
  "oxidevm_vcpu_jit_next",
  "oxidevm_vcpu_jit_chain",
  "oxidevm_vcpu_jit_register",
  "oxidevm_vcpu_jit_unregister",
  "oxidevm_vcpu_jit_memory_access",
  "oxidevm_vcpu_jit_floating_point",
  "oxidevm_vcpu_jit_invalidate_page",
  "oxidevm_vcpu_jit_timestamp_counter",
  "oxidevm_vcpu_jit_stack_frame",
  "oxidevm_vcpu_jit_enter_frame",
  "oxidevm_vcpu_jit_stack_registers",
  "oxidevm_vcpu_jit_segment_load",
  "oxidevm_vcpu_jit_cpuid",
  "oxidevm_vcpu_jit_msr",
  "oxidevm_vcpu_jit_control_register",
  "oxidevm_vcpu_jit_io_instruction",
  "oxidevm_vcpu_jit_complete",
  "oxidevm_vcpu_jit_completion_failure",
  "oxidevm_vcpu_jit_action_ptr",
  "oxidevm_vcpu_jit_action_len",
  "oxidevm_vcpu_jit_module_ptr",
  "oxidevm_vcpu_jit_module_len",
  "oxidevm_vcpu_jit_forget_pending",
  "oxidevm_vcpu_jit_context_ptr",
  "oxidevm_vcpu_jit_context_len",
  "oxidevm_vcpu_jit_interpreted_steps",
  "oxidevm_vcpu_jit_result_ptr",
  "oxidevm_vcpu_jit_result_len",
  "oxidevm_result_ptr",
  "oxidevm_result_len",
  "oxidevm_cpu_state_ptr",
  "oxidevm_cpu_state_len",
  "oxidevm_runtime_profile_ptr",
  "oxidevm_runtime_profile_len",
] as const;

export function readCoreRuntimeProfile(
  loaded: Core,
): SystemTraceProfile["worker"]["core"] {
  return decodeCoreRuntimeProfile(
    readExportedBytes(loaded, "oxidevm_runtime_profile"),
  );
}

export interface Core {
  readonly exports: Readonly<Record<string, unknown>>;
  readonly memory: WebAssembly.Memory;
  readonly runtimeKey: string;
  readonly jitBlocks: Map<string, JitBlock>;
  readonly jitBlocksBySlot: Map<number, JitBlock>;
  readonly dormantJitBlocks: Map<string, JitBlock>;
  readonly compiledJitKeys: Set<string>;
  readonly evictedJitKeys: Map<string, number>;
  readonly jitTable: WebAssembly.Table;
  readonly jitRecordingTable: WebAssembly.Table;
  /** `run`/`record` of the dispatcher module over this core's memory and tables, instantiated
   * on first JIT use (`jitDispatchers`). */
  jitDispatchers: JitDispatchers | undefined;
  readonly runtimeStats: MutableRuntimeStats;
  readonly traceSystemEvents: BoundedRing<SystemTraceEvent>;
  readonly traceApplicationEvents: BoundedRing<SystemTraceEvent>;
  readonly traceApplicationSamples: BoundedRing<SystemTraceEvent>;
  readonly traceSharedLibraryEvents: BoundedRing<SystemTraceEvent>;
  readonly traceAotEvents: BoundedRing<SystemTraceEvent>;
  readonly traceProfile: MutableSystemTraceProfile;
  readonly profileJitModules: ProfileJitModuleStore;
  readonly profileJitOperationSamples: Map<string, SystemTraceJitOperationSample>;
  readonly profileJitEdgeSamples: Map<string, SystemTraceJitEdgeSample>;
  readonly collidingProfileJitModuleIds: Set<string>;
  droppedProfileJitModules: number;
  collidingProfileJitModules: number;
  profileJitOperationSampleTotal: number;
  droppedProfileJitOperationSamples: number;
  profileJitEdgeSampleTotal: number;
  droppedProfileJitEdgeSamples: number;
  /** The compiled-module byte budget of this core's JIT cache. */
  readonly jitCacheBytes: number;
  jitBlockBytes: number;
  dormantJitBlockBytes: number;
  aotCacheBytes: number;
  aotCacheEntries: number;
  jitBlockUse: number;
  nextJitCompileGeneration: number;
  /** Whether this core's JIT still compiles, and its typed failures (`jit-health.ts`). */
  readonly jitHealth: MutableJitHealth;
  /** The estimated executable memory of this core's compiled translations and its code budget
   * (`jit-code-budget.ts`). */
  readonly jitCode: JitCodeBudget;
  nextJitSlot: number;
  runtimeEpoch: number;
  traceCapacity: number;
  traceApplicationSequence: number;
  traceSequence: number;
  traceCheckpoint: FrozenSystemTrace | undefined;
  traceFreeze: FrozenSystemTrace | undefined;
  traceInterpreterOnly: boolean;
  traceCheckpointPolicy: "faults-and-stderr" | "faults-only";
  readonly traceInterpretedSemantics: Set<number>;
  readonly traceInterpretedRipRanges: SystemTraceRipRange[];
}

export interface PreparedSharedCore {
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  initialize(): Core;
}

export interface FrozenSystemTrace {
  readonly capturedAt: number;
  readonly trigger: Exclude<SystemTraceSnapshot["trigger"], null>;
  readonly checkpointPolicy: NonNullable<SystemTraceSnapshot["checkpointPolicy"]>;
  readonly runtime: SystemTraceSnapshot["runtime"];
  readonly profile: SystemTraceProfile;
  readonly state: SystemTraceCpu;
  readonly consoleTail: string;
  readonly dropped: number;
  readonly events: readonly SystemTraceEvent[];
  readonly jitModules: SystemTraceSnapshot["jitModules"];
  readonly droppedJitModules: number;
  readonly collidingJitModules: number;
  readonly jitOperationSamples: SystemTraceSnapshot["jitOperationSamples"];
  readonly jitOperationSampleTotal: number;
  readonly droppedJitOperationSamples: number;
  readonly jitEdgeSamples: SystemTraceSnapshot["jitEdgeSamples"];
  readonly jitEdgeSampleTotal: number;
  readonly droppedJitEdgeSamples: number;
}

export interface JitBlock {
  bindingId?: bigint | undefined;
  cacheKey: bigint;
  bindingKey: string;
  readonly artifactCacheKey: bigint;
  readonly artifact: SystemTraceJitArtifact;
  readonly key: string;
  tier: JitModuleTraceMap["tier"];
  readonly slot: number;
  byteLength: number;
  readonly executableBytes?: Uint8Array;
  readonly instance: WebAssembly.Instance;
  /** The compiled unit whose code this block runs; null for AOT pack members, which the AOT
   * runtime accounts for. */
  readonly codeUnit: JitCodeUnit | null;
  /** The block's normal and recording traces: entry `slot` of the dispatch tables while it is
   * live, kept so a dormant block reinstalls without knowing its module's layout. */
  readonly trace: CallableFunction;
  readonly recordTrace: CallableFunction;
  instructions: readonly JitTraceInstruction[];
  profileModuleId: string | null;
  compileGeneration: number;
  readonly bindings: Map<string, JitBlockBinding>;
  dispatchGeneration: number;
  lastUse: number;
  /** `lastUse` when the block last entered the byte-capacity queue (`jitBlocks` order); a
   * later use gives it a second chance before eviction. */
  queuedUse: number;
  dispatchRecentlyUsed: boolean;
}

/** The entry points of the dispatcher module: `run` enters translated code at a dispatch slot and
 * chains through the normal table; `record` does the same through the recording table. */
export interface JitDispatchers {
  readonly run: CallableFunction;
  readonly record: CallableFunction;
  readonly retirePrefix: CallableFunction;
}

export interface JitBlockBinding {
  readonly bindingId?: bigint | undefined;
  readonly metadataBytes?: number;
  readonly cacheKey: bigint;
  readonly key: string;
  readonly tier: JitModuleTraceMap["tier"];
  readonly instructions: readonly JitTraceInstruction[];
  readonly profileModuleId: string | null;
  readonly compileGeneration: number;
}

export async function loadCore(
  url: string,
  hostDiskImports: DiskBridgeImports = unavailableDiskBridgeImports,
): Promise<Core> {
  assertBrowserSupport();
  const response = await fetch(url);
  if (!response.ok) {
    throw new VMError(
      "CORE_LOAD_FAILED",
      `failed to fetch core: ${response.status}`,
    );
  }
  const runtimeKey = hashResponse(response.clone());

  let instance: WebAssembly.Instance;
  const entropySource: { memory?: WebAssembly.Memory } = {};
  const entropyFill = createCoreEntropyImport(() => entropySource.memory);
  try {
    ({ instance } = await WebAssembly.instantiateStreaming(response.clone(), {
      oxidevm_host: { ...hostDiskImports, entropy_fill: entropyFill },
    }));
  } catch {
    ({ instance } = await WebAssembly.instantiate(
      await response.arrayBuffer(),
      { oxidevm_host: { ...hostDiskImports, entropy_fill: entropyFill } },
    ));
  }
  const exports = record(instance.exports, "Wasm exports");
  const memory = exports["memory"];
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new VMError("CORE_LOAD_FAILED", "Wasm memory export is missing");
  }
  entropySource.memory = memory;
  for (const name of CORE_FUNCTIONS) {
    if (typeof exports[name] !== "function") {
      throw new VMError(
        "CORE_LOAD_FAILED",
        `Wasm function export ${name} is missing`,
      );
    }
  }
  return createCore(exports, memory, await runtimeKey, JIT_CACHE_BYTES);
}

export async function prepareSharedCore(
  url: string,
  hostDiskImports: DiskBridgeImports = unavailableDiskBridgeImports,
): Promise<PreparedSharedCore> {
  assertBrowserSupport();
  const response = await fetch(url);
  if (!response.ok) {
    throw new VMError(
      "CORE_LOAD_FAILED",
      `failed to fetch shared core: ${response.status}`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (hasStartSection(bytes)) {
    throw new VMError(
      "CORE_LOAD_FAILED",
      "shared core contains an unexpected start function",
    );
  }
  let module: WebAssembly.Module;
  let memory: WebAssembly.Memory;
  let instance: WebAssembly.Instance;
  try {
    module = await WebAssembly.compile(bytes);
    const importedMemory = WebAssembly.Module.imports(module).some(
      (entry) =>
        entry.kind === "memory" && entry.module === "env" && entry.name === "memory",
    );
    if (!importedMemory) throw new Error("shared memory import is missing");
    memory = new WebAssembly.Memory({
      initial: 256,
      maximum: 65_536,
      shared: true,
    });
    instance = await WebAssembly.instantiate(module, {
      env: { memory },
      oxidevm_host: { ...hostDiskImports, entropy_fill: createCoreEntropyImport(() => memory) },
    });
    setSharedStack(instance, 2 * 1024 * 1024);
  } catch (error) {
    throw new VMError(
      "CORE_LOAD_FAILED",
      `failed to instantiate shared core: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const runtimeKey = await hashBytes(bytes);
  let initialized = false;
  return {
    module,
    memory,
    initialize() {
      if (initialized) {
        throw new VMError("CORE_LOAD_FAILED", "shared core is already initialized");
      }
      initialized = true;
      const initialize = instance.exports["oxidevm_shared_initialize"];
      if (typeof initialize !== "function") {
        throw new VMError("CORE_LOAD_FAILED", "shared core initializer is missing");
      }
      Reflect.apply(initialize, undefined, []);
      const exports = record(instance.exports, "Wasm exports");
      if (exports["memory"] !== memory) {
        throw new VMError("CORE_LOAD_FAILED", "shared core memory export is invalid");
      }
      return createCore(exports, memory, runtimeKey, JIT_CACHE_BYTES);
    },
  };
}

export function createCore(
  exports: Readonly<Record<string, unknown>>,
  memory: WebAssembly.Memory,
  runtimeKey: string,
  jitCacheBytes: number,
  jitPolicy: JitEnginePolicy = jitEnginePolicy(),
): Core {
  for (const name of CORE_FUNCTIONS) {
    if (typeof exports[name] !== "function") {
      throw new VMError(
        "CORE_LOAD_FAILED",
        `Wasm function export ${name} is missing`,
      );
    }
  }
  const loaded: Core = {
    exports,
    memory,
    runtimeKey,
    jitBlocks: new Map(),
    jitBlocksBySlot: new Map(),
    dormantJitBlocks: new Map(),
    compiledJitKeys: new Set(),
    evictedJitKeys: new Map(),
    jitTable: new WebAssembly.Table({
      element: "anyfunc",
      initial: JIT_DISPATCH_TABLE_ENTRIES,
      maximum: JIT_DISPATCH_TABLE_ENTRIES,
    }),
    jitRecordingTable: new WebAssembly.Table({
      element: "anyfunc",
      initial: JIT_DISPATCH_TABLE_ENTRIES,
      maximum: JIT_DISPATCH_TABLE_ENTRIES,
    }),
    jitDispatchers: undefined,
    runtimeStats: {
      jitInstructions: 0n,
      interpretedInstructions: 0n,
      cacheHits: 0n,
      moduleLoads: 0n,
      compileSamples: 0,
      compileMaximumMilliseconds: 0,
      compileLatency: new Uint32Array(COMPILE_LATENCY_BUCKETS),
      guardExits: 0n,
      evictions: 0n,
    },
    traceSystemEvents: createBoundedRing(),
    traceApplicationEvents: createBoundedRing(),
    traceApplicationSamples: createBoundedRing(),
    traceSharedLibraryEvents: createBoundedRing(),
    traceAotEvents: createBoundedRing(),
    traceProfile: createSystemTraceProfile(),
    profileJitModules: new ProfileJitModuleStore(),
    profileJitOperationSamples: new Map(),
    profileJitEdgeSamples: new Map(),
    collidingProfileJitModuleIds: new Set(),
    droppedProfileJitModules: 0,
    collidingProfileJitModules: 0,
    profileJitOperationSampleTotal: 0,
    droppedProfileJitOperationSamples: 0,
    profileJitEdgeSampleTotal: 0,
    droppedProfileJitEdgeSamples: 0,
    jitCacheBytes,
    jitBlockBytes: 0,
    dormantJitBlockBytes: 0,
    aotCacheBytes: 0,
    aotCacheEntries: 0,
    jitBlockUse: 0,
    nextJitCompileGeneration: 0,
    jitHealth: createJitHealth(),
    jitCode: new JitCodeBudget(jitPolicy),
    nextJitSlot: 0,
    runtimeEpoch: 0,
    traceCapacity: 0,
    traceApplicationSequence: 0,
    traceSequence: 0,
    traceCheckpoint: undefined,
    traceFreeze: undefined,
    traceInterpreterOnly: false,
    traceCheckpointPolicy: "faults-and-stderr",
    traceInterpretedSemantics: new Set(),
    traceInterpretedRipRanges: [],
  };
  if (callNumber(loaded, "oxidevm_api_version") !== CORE_API_VERSION) {
    throw new VMError("CORE_LOAD_FAILED", "unsupported core ABI version");
  }
  const jitApiVersion = callNumber(loaded, "oxidevm_jit_api_version");
  if (jitApiVersion !== JIT_API_VERSION) {
    throw new VMError(
      "CORE_LOAD_FAILED",
      `unsupported JIT ABI version ${String(jitApiVersion)}; expected ${String(JIT_API_VERSION)}`,
    );
  }
  return loaded;
}

function setSharedStack(instance: WebAssembly.Instance, value: number): void {
  const stack = instance.exports["__stack_pointer"];
  if (!(stack instanceof WebAssembly.Global)) {
    throw new Error("shared core stack pointer is missing");
  }
  stack.value = value;
}

function hasStartSection(bytes: Uint8Array): boolean {
  if (
    bytes.byteLength < 8 ||
    bytes[0] !== 0 ||
    bytes[1] !== 0x61 ||
    bytes[2] !== 0x73 ||
    bytes[3] !== 0x6d
  ) {
    throw new VMError("CORE_LOAD_FAILED", "shared core is not a Wasm binary");
  }
  let cursor = 8;
  while (cursor < bytes.byteLength) {
    const id = bytes[cursor++];
    const decoded = readWasmU32(bytes, cursor);
    cursor = decoded.next + decoded.value;
    if (cursor > bytes.byteLength) {
      throw new VMError("CORE_LOAD_FAILED", "shared core is truncated");
    }
    if (id === 8) return true;
  }
  return false;
}

function readWasmU32(
  bytes: Uint8Array,
  start: number,
): { readonly value: number; readonly next: number } {
  let value = 0;
  for (let shift = 0, cursor = start; shift < 35; shift += 7, cursor += 1) {
    const byte = bytes[cursor];
    if (byte === undefined) break;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: cursor + 1 };
  }
  throw new VMError("CORE_LOAD_FAILED", "shared core has invalid section lengths");
}
async function hashResponse(response: Response): Promise<string> {
  return hashBytes(new Uint8Array(await response.arrayBuffer()));
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", copy.buffer),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function stage(loaded: Core, bytes: Uint8Array): void {
  assertStatus(
    callNumber(loaded, "oxidevm_staging_resize", [bytes.byteLength]),
  );
  const pointer = callNumber(loaded, "oxidevm_staging_ptr");
  const target = memorySlice(loaded.memory, pointer, bytes.byteLength);
  target.set(bytes);
}

export function readRecord(
  loaded: Core,
  recordName: "result" | "cpu-state",
): Uint8Array<ArrayBuffer> {
  const prefix =
    recordName === "result" ? "oxidevm_result" : "oxidevm_cpu_state";
  return readExportedView(loaded, prefix);
}

export function readExportedView(
  loaded: Core,
  prefix: string,
): Uint8Array<ArrayBuffer> {
  const pointer = callNumber(loaded, `${prefix}_ptr`);
  const length = callNumber(loaded, `${prefix}_len`);
  return memorySlice(loaded.memory, pointer, length);
}

export function readExportedBytes(
  loaded: Core,
  prefix: string,
): Uint8Array<ArrayBuffer> {
  return readExportedView(loaded, prefix).slice();
}

export function memorySlice(
  memory: WebAssembly.Memory,
  pointer: number,
  length: number,
): Uint8Array<ArrayBuffer> {
  const unsignedPointer = unsignedWasmPointer(pointer);
  if (
    !Number.isSafeInteger(pointer) ||
    pointer < -0x8000_0000 ||
    pointer > 0xffff_ffff ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    unsignedPointer + length > memory.buffer.byteLength
  ) {
    throw new VMError(
      "VM_FAULT",
      `Wasm record is outside memory (pointer=${String(pointer)}, unsigned=${String(unsignedPointer)}, length=${String(length)}, memory=${String(memory.buffer.byteLength)})`,
    );
  }
  return new Uint8Array(memory.buffer, unsignedPointer, length);
}

export function callNumber(
  loaded: Pick<Core, "exports">,
  name: string,
  args: readonly unknown[] = [],
): number {
  const operation = loaded.exports[name];
  if (typeof operation !== "function") {
    throw new VMError("CORE_LOAD_FAILED", `missing Wasm export ${name}`);
  }
  const result: unknown = Reflect.apply(operation, undefined, args);
  if (typeof result !== "number") {
    throw new VMError("VM_FAULT", `Wasm export ${name} returned invalid data`);
  }
  return result;
}

export function assertStatus(status: number): void {
  if (status !== 0) {
    throw new VMError(
      "VM_FAULT",
      `core operation failed with status ${status}`,
    );
  }
}

export function loadSystemAsset(
  loaded: Core,
  kind: number,
  bytes: Uint8Array,
): void {
  stage(loaded, bytes);
  assertStatus(
    callNumber(loaded, "oxidevm_system_load_asset", [kind, bytes.byteLength]),
  );
}
