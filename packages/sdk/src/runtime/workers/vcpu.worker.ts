/// <reference lib="webworker" />

import {
  CORE_API_VERSION,
  createCoreEntropyImport,
  decodeJitAction,
  decodeRunResult,
  isJitGuardExit,
  JIT_EXIT_PERFORMANCE_BOUNDARY,
} from "../core-abi.js";
import { JIT_API_VERSION } from "../core-abi/jit.js";
import { record } from "../decode.js";
import {
  JIT_CACHE_BYTES,
  JIT_DISPATCH_TABLE_ENTRIES,
} from "../jit-cache.js";

const JIT_EXIT_GUARD = 1;
const INTERPRETER_FALLBACK_STEPS = 64;
const CONTROL_GENERATION = 0;
const CONTROL_BARRIER = 1;
const CONTROL_CANCELLATION = 2;
const CONTROL_STOPPED = 3;
const CONTROL_ACK_BASE = 4;

interface JitBlock {
  readonly key: string;
  readonly cacheKey: bigint;
  readonly slot: number;
  readonly bytes: number;
  readonly instance: WebAssembly.Instance;
}

type VcpuRunResult =
  | {
      readonly record: Uint8Array<ArrayBuffer>;
      readonly tier: "interpreter";
    }
  | {
      readonly record: Uint8Array<ArrayBuffer>;
      readonly tier: "jit";
      readonly residentInterpreted: number;
    };

let instance: WebAssembly.Instance | undefined;
let memory: WebAssembly.Memory | undefined;
let control: Int32Array<SharedArrayBuffer> | undefined;
let dispatchTable: WebAssembly.Table | undefined;
let recordingDispatchTable: WebAssembly.Table | undefined;
let vcpu = 0;
let nextSlot = 0;
// TODO: background JIT compile and batched translations (docs/baselines/jit-background-compile.md)
// are not used by application processors yet: this worker still compiles one module per
// translation synchronously, and each AP keeps its own JIT_CACHE_BYTES (2 GiB) budget.
let cacheBytes = 0;
let jitDispatcher: { readonly run: CallableFunction; readonly retirePrefix: CallableFunction } | undefined;
const blocks = new Map<string, JitBlock>();
const blocksBySlot = new Map<number, JitBlock>();

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  receive(event.data);
});

function receive(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const request = record(value, "vCPU request");
  const requestId = request["requestId"];
  if (!Number.isInteger(requestId) || Number(requestId) < 1) return;
  try {
    let result: VcpuRunResult | undefined;
    switch (request["type"]) {
      case "instantiate":
        instantiate(request);
        break;
      case "initialize":
        initialize();
        break;
      case "run":
        result = run(request);
        break;
      case "barrier":
        acknowledgeBarrier(request);
        break;
      default:
        throw new Error("unknown vCPU worker request");
    }
    if (result === undefined) {
      self.postMessage({ requestId, ok: true });
    } else {
      self.postMessage(
        { requestId, ok: true, value: result },
        [result.record.buffer],
      );
    }
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function instantiate(request: {
  readonly module?: unknown;
  readonly memory?: unknown;
  readonly control?: unknown;
  readonly vcpu?: unknown;
}): void {
  if (
    instance !== undefined ||
    !(request.module instanceof WebAssembly.Module) ||
    !(request.memory instanceof WebAssembly.Memory) ||
    !(request.control instanceof SharedArrayBuffer) ||
    !Number.isInteger(request.vcpu) ||
    Number(request.vcpu) < 1 ||
    Number(request.vcpu) > 4
  ) {
    throw new Error("invalid vCPU worker initialization");
  }
  vcpu = Number(request.vcpu);
  memory = request.memory;
  control = new Int32Array(request.control);
  dispatchTable = new WebAssembly.Table({
    element: "anyfunc",
    initial: JIT_DISPATCH_TABLE_ENTRIES,
    maximum: JIT_DISPATCH_TABLE_ENTRIES,
  });
  recordingDispatchTable = new WebAssembly.Table({
    element: "anyfunc",
    initial: JIT_DISPATCH_TABLE_ENTRIES,
    maximum: JIT_DISPATCH_TABLE_ENTRIES,
  });
  instance = new WebAssembly.Instance(request.module, {
    env: { memory },
    oxidevm_host: {
      entropy_fill: createCoreEntropyImport(() => memory),
      disk_read: unavailableDisk,
      disk_write: unavailableDisk,
      disk_zero: unavailableDisk,
      disk_discard: unavailableDisk,
      disk_flush: unavailableDisk,
      disk_read_start: unavailableDisk,
      disk_flush_start: unavailableDisk,
      disk_poll: unavailableDiskPoll,
    },
  });
  const stack = instance.exports["__stack_pointer"];
  if (!(stack instanceof WebAssembly.Global)) {
    throw new Error("shared core stack pointer is missing");
  }
  stack.value = (vcpu + 1) * 2 * 1024 * 1024;
}

function initialize(): void {
  const loaded = requireInstance();
  const initialize = loaded.exports["oxidevm_shared_initialize"];
  if (typeof initialize !== "function") {
    throw new Error("shared core initializer is missing");
  }
  Reflect.apply(initialize, undefined, []);
  if (
    call("oxidevm_api_version") !== CORE_API_VERSION ||
    call("oxidevm_jit_api_version") !== JIT_API_VERSION
  ) {
    throw new Error("shared core ABI version is unsupported");
  }
  jitDispatcher = instantiateJitDispatcher();
}

/** `run` of the core's dispatcher module over this vCPU's tables; translated modules carry no
 * dispatcher of their own. */
function instantiateJitDispatcher(): { readonly run: CallableFunction; readonly retirePrefix: CallableFunction } {
  const pointer = call("oxidevm_jit_dispatcher_module_ptr") >>> 0;
  const length = call("oxidevm_jit_dispatcher_module_len");
  checkedMemory(pointer, length);
  const bytes = new Uint8Array(requireMemory().buffer, pointer, length).slice();
  const dispatcher = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    oxidevm: {
      memory: requireMemory(),
      dispatch_table: requireDispatchTable(),
      record_dispatch_table: requireRecordingDispatchTable(),
    },
  });
  const run = dispatcher.exports["run"];
  const retirePrefix = dispatcher.exports["retire_prefix"];
  if (typeof run !== "function" || typeof retirePrefix !== "function") throw new Error("vCPU JIT dispatcher module exports are invalid");
  return { run, retirePrefix };
}

function run(request: {
  readonly generation?: unknown;
  readonly maximumSteps?: unknown;
}, installOnlyActions = 0): VcpuRunResult {
  if (installOnlyActions > 1) {
    throw new Error("vCPU JIT emitted consecutive install-only actions");
  }
  const shared = requireControl();
  const generation = Number(request.generation);
  const maximumSteps = Number(request.maximumSteps);
  if (
    !Number.isInteger(generation) ||
    generation !== Atomics.load(shared, CONTROL_GENERATION) ||
    !Number.isInteger(maximumSteps) ||
    maximumSteps < 1 ||
    maximumSteps > 0xffff_ffff ||
    Atomics.load(shared, CONTROL_STOPPED) !== 0
  ) {
    throw new Error("stale or invalid vCPU execution request");
  }
  const cancellation = Atomics.load(shared, CONTROL_CANCELLATION);
  let prepared = false;
  try {
    assertStatus(call("oxidevm_vcpu_jit_next", vcpu, maximumSteps));
    prepared = true;
    const action = decodeJitAction(readJitRecord("action"));
    if (action.kind === "interpreted-result") {
      prepared = false;
      const record = readJitRecord("result");
      const exit = decodeRunResult(record);
      if (exit.steps !== BigInt(action.instructionCount)) {
        throw new Error("resident vCPU result does not match its JIT action");
      }
      ensureCurrent(shared, generation, cancellation);
      return { record, tier: "interpreter" };
    }

    const executionBudget = Math.min(
      maximumSteps,
      action.maximumInstructions,
    );
    const moduleLength = call("oxidevm_vcpu_jit_module_len", vcpu);
    const contextLength = call("oxidevm_vcpu_jit_context_len", vcpu);
    if (
      (moduleLength !== 0 && moduleLength !== action.moduleLength) ||
      contextLength !== action.contextLength
    ) {
      throw new Error("vCPU JIT action lengths changed before execution");
    }
    const key = `${action.cacheKey.toString(16)}:${String(action.moduleLength)}`;
    let block = blocks.get(key);
    if (block === undefined) {
      if (moduleLength === 0) {
        assertStatus(call("oxidevm_vcpu_jit_forget_pending", vcpu));
        discardPreparedJit();
        prepared = false;
        if (action.kind === "install") {
          return run(request, installOnlyActions + 1);
        }
        return runInterpreter(
          generation,
          Math.min(executionBudget, INTERPRETER_FALLBACK_STEPS),
        );
      }
      const moduleBytes = readJitRecord("module");
      // TODO: compile off this thread and batch translations, as the BSP's JitRuntime does.
      const compiled = new WebAssembly.Module(moduleBytes);
      ensureCurrent(shared, generation, cancellation);
      const compiledInstance = new WebAssembly.Instance(compiled, jitImports());
      ensureCurrent(shared, generation, cancellation);
      block = installBlock(
        key,
        action.cacheKey,
        action.moduleLength,
        compiledInstance,
      );
    } else {
      blocks.delete(key);
      blocks.set(key, block);
    }

    const registration = call(
      "oxidevm_vcpu_jit_register",
      vcpu,
      action.cacheKey,
      block.slot,
    );
    if (registration !== 0) {
      discardPreparedJit();
      prepared = false;
      evictBlock(block);
      if (action.kind === "install") {
        return run(request, installOnlyActions + 1);
      }
      return runInterpreter(
        generation,
        Math.min(executionBudget, INTERPRETER_FALLBACK_STEPS),
      );
    }
    if (action.kind === "install") {
      prepared = false;
      ensureCurrent(shared, generation, cancellation);
      return run(request, installOnlyActions + 1);
    }

    const runBlock = jitDispatcher?.run;
    if (runBlock === undefined) throw new Error("vCPU JIT dispatcher is not initialized");
    const contextPointer = call("oxidevm_vcpu_jit_context_ptr", vcpu) >>> 0;
    checkedMemory(contextPointer, contextLength);
    const rawExit: unknown = Reflect.apply(runBlock, undefined, [
      contextPointer,
      BigInt(executionBudget),
      block.slot,
    ]);
    if (
      typeof rawExit !== "number" ||
      !Number.isInteger(rawExit) ||
      rawExit < 0 ||
      rawExit > JIT_EXIT_PERFORMANCE_BOUNDARY
    ) {
      throw new Error("compiled vCPU JIT block returned an invalid exit");
    }
    assertStatus(call("oxidevm_vcpu_jit_complete", vcpu, rawExit));
    prepared = false;
    ensureCurrent(shared, generation, cancellation);
    const residentInterpreted = call(
      "oxidevm_vcpu_jit_interpreted_steps",
      vcpu,
    );
    if (isJitGuardExit(rawExit)) {
      if (residentInterpreted !== 0) {
        const record = readJitRecord("result");
        const exit = decodeRunResult(record);
        if (
          exit.kind !== "step-limit" ||
          exit.steps < 1n ||
          exit.steps > BigInt(executionBudget) ||
          BigInt(residentInterpreted) > exit.steps
        ) {
          throw new Error("vCPU JIT resident guard result is invalid");
        }
        return { record, tier: "jit", residentInterpreted };
      }
      return runInterpreter(
        generation,
        Math.min(executionBudget, INTERPRETER_FALLBACK_STEPS),
      );
    }
    const record = readJitRecord("result");
    const exit = decodeRunResult(record);
    if (exit.steps < 1n || exit.steps > BigInt(executionBudget)) {
      throw new Error("compiled vCPU JIT block reported an invalid step count");
    }
    return {
      record,
      tier: "jit",
      residentInterpreted,
    };
  } catch (error) {
    if (prepared) {
      const completion = call("oxidevm_vcpu_jit_complete", vcpu, JIT_EXIT_GUARD);
      if (completion !== 0) {
        throw new Error(
          `failed to discard vCPU JIT state (${String(
            call("oxidevm_vcpu_jit_completion_failure", vcpu),
          )})`,
          { cause: error },
        );
      }
    }
    throw error;
  }
}

function runInterpreter(
  generation: number,
  maximumSteps: number,
): VcpuRunResult {
  const shared = requireControl();
  const cancellation = Atomics.load(shared, CONTROL_CANCELLATION);
  if (
    call("oxidevm_system_run_vcpu", vcpu, maximumSteps, generation) !== 0 ||
    cancellation !== Atomics.load(shared, CONTROL_CANCELLATION)
  ) {
    throw new Error("vCPU execution was canceled or failed");
  }
  const record = readSystemResult();
  decodeRunResult(record);
  return { record, tier: "interpreter" };
}

// TODO: install batched translations from a background compiler (see the note on cacheBytes).
function installBlock(
  key: string,
  cacheKey: bigint,
  bytes: number,
  compiled: WebAssembly.Instance,
): JitBlock {
  if (bytes > JIT_CACHE_BYTES) {
    throw new Error("compiled vCPU JIT block exceeds its cache");
  }
  while (cacheBytes + bytes > JIT_CACHE_BYTES && blocks.size !== 0) {
    const oldest = blocks.values().next().value;
    if (oldest === undefined) break;
    evictBlock(oldest);
  }
  const slot = nextSlot;
  nextSlot = (nextSlot + 1) % JIT_DISPATCH_TABLE_ENTRIES;
  const occupied = blocksBySlot.get(slot);
  if (occupied !== undefined) evictBlock(occupied);
  const trace = compiled.exports["trace"];
  const recordTrace = compiled.exports["record_trace"];
  if (typeof trace !== "function" || typeof recordTrace !== "function") {
    throw new Error("compiled vCPU JIT block has incomplete trace exports");
  }
  const block = { key, cacheKey, slot, bytes, instance: compiled };
  requireDispatchTable().set(slot, trace);
  requireRecordingDispatchTable().set(slot, recordTrace);
  blocks.set(key, block);
  blocksBySlot.set(slot, block);
  cacheBytes += bytes;
  return block;
}

function evictBlock(block: JitBlock): void {
  if (blocks.get(block.key) === block) blocks.delete(block.key);
  if (blocksBySlot.get(block.slot) === block) {
    blocksBySlot.delete(block.slot);
    requireDispatchTable().set(block.slot, null);
    requireRecordingDispatchTable().set(block.slot, null);
  }
  cacheBytes = Math.max(0, cacheBytes - block.bytes);
  const status = call(
    "oxidevm_vcpu_jit_unregister",
    vcpu,
    block.cacheKey,
    block.slot,
  );
  if (status !== 0) throw new Error("failed to unregister vCPU JIT block");
}

function discardPreparedJit(): void {
  const status = call("oxidevm_vcpu_jit_complete", vcpu, JIT_EXIT_GUARD);
  if (status !== 0) {
    throw new Error(
      `failed to discard vCPU JIT state (${String(
        call("oxidevm_vcpu_jit_completion_failure", vcpu),
      )})`,
    );
  }
}

function jitImports(): WebAssembly.Imports {
  const dispatcher = jitDispatcher;
  if (dispatcher === undefined) throw new Error("vCPU JIT dispatcher is not initialized");
  return {
    oxidevm: {
      stack_frame: indexedBoundary("oxidevm_vcpu_jit_stack_frame"),
      enter_frame: indexedBoundary("oxidevm_vcpu_jit_enter_frame"),
      stack_registers: indexedBoundary("oxidevm_vcpu_jit_stack_registers"),
      segment_load: indexedBoundary("oxidevm_vcpu_jit_segment_load"),
      cpuid: indexedBoundary("oxidevm_vcpu_jit_cpuid"),
      msr: indexedBoundary("oxidevm_vcpu_jit_msr"),
      control_register: indexedBoundary("oxidevm_vcpu_jit_control_register"),
      descriptor: indexedBoundary("oxidevm_vcpu_jit_descriptor"),
      tlb: indexedBoundary("oxidevm_vcpu_jit_tlb"),
      far_control: indexedBoundary("oxidevm_vcpu_jit_far_control"),
      random_word: indexedBoundary("oxidevm_vcpu_jit_random_word"),
      io_instruction: indexedBoundary("oxidevm_vcpu_jit_io_instruction"),
      memory: requireMemory(),
      memory_access: indexedBoundary("oxidevm_vcpu_jit_memory_access"),
      floating_point: indexedBoundary("oxidevm_vcpu_jit_floating_point"),
      retirement_prefix: dispatcher.retirePrefix,
      invalidate_page: indexedBoundary("oxidevm_vcpu_jit_invalidate_page"),
      timestamp_counter: indexedBoundary(
        "oxidevm_vcpu_jit_timestamp_counter",
      ),
      side_exit: indexedBoundary("oxidevm_vcpu_jit_chain"),
      dispatch_table: requireDispatchTable(),
      record_dispatch_table: requireRecordingDispatchTable(),
    },
  };
}

function indexedBoundary(name: string): (...args: unknown[]) => unknown {
  const operation = requireInstance().exports[name];
  if (typeof operation !== "function") {
    throw new Error(`missing core export ${name}`);
  }
  return (...args: unknown[]): unknown =>
    Reflect.apply(operation, undefined, [vcpu, ...args]);
}

function readJitRecord(
  name: "action" | "module" | "result",
): Uint8Array<ArrayBuffer> {
  const pointer = call(`oxidevm_vcpu_jit_${name}_ptr`, vcpu) >>> 0;
  const length = call(`oxidevm_vcpu_jit_${name}_len`, vcpu);
  return new Uint8Array(checkedMemory(pointer, length));
}

function readSystemResult(): Uint8Array<ArrayBuffer> {
  const pointer = call("oxidevm_system_vcpu_result_ptr", vcpu) >>> 0;
  const length = call("oxidevm_system_vcpu_result_len", vcpu);
  return new Uint8Array(checkedMemory(pointer, length));
}

function checkedMemory(pointer: number, length: number): Uint8Array {
  const wasmMemory = requireMemory();
  if (
    !Number.isInteger(length) ||
    length < 0 ||
    pointer + length > wasmMemory.buffer.byteLength
  ) {
    throw new Error("vCPU record is outside shared memory");
  }
  return new Uint8Array(wasmMemory.buffer, pointer, length);
}

function ensureCurrent(
  shared: Int32Array<SharedArrayBuffer>,
  generation: number,
  cancellation: number,
): void {
  if (
    generation !== Atomics.load(shared, CONTROL_GENERATION) ||
    cancellation !== Atomics.load(shared, CONTROL_CANCELLATION) ||
    Atomics.load(shared, CONTROL_STOPPED) !== 0
  ) {
    throw new Error("vCPU execution was canceled");
  }
}

function acknowledgeBarrier(request: { readonly epoch?: unknown }): void {
  const shared = requireControl();
  const epoch = Number(request.epoch);
  if (
    !Number.isInteger(epoch) ||
    epoch !== Atomics.load(shared, CONTROL_BARRIER)
  ) {
    throw new Error("stale vCPU barrier");
  }
  Atomics.store(shared, CONTROL_ACK_BASE + vcpu - 1, epoch);
  Atomics.notify(shared, CONTROL_ACK_BASE + vcpu - 1);
}

function assertStatus(status: number): void {
  if (status !== 0) throw new Error(`core operation failed with status ${status}`);
}

function call(name: string, ...args: Array<number | bigint>): number {
  const operation = requireInstance().exports[name];
  if (typeof operation !== "function") throw new Error(`missing core export ${name}`);
  const result: unknown = Reflect.apply(operation, undefined, args);
  if (typeof result !== "number") throw new Error(`invalid result from ${name}`);
  return result;
}

function requireInstance(): WebAssembly.Instance {
  if (instance === undefined) throw new Error("vCPU worker is not initialized");
  return instance;
}

function requireMemory(): WebAssembly.Memory {
  if (memory === undefined) throw new Error("vCPU worker memory is unavailable");
  return memory;
}

function requireControl(): Int32Array<SharedArrayBuffer> {
  if (control === undefined) throw new Error("vCPU worker control is unavailable");
  return control;
}

function requireDispatchTable(): WebAssembly.Table {
  if (dispatchTable === undefined) {
    throw new Error("vCPU worker dispatch table is unavailable");
  }
  return dispatchTable;
}

function requireRecordingDispatchTable(): WebAssembly.Table {
  if (recordingDispatchTable === undefined) {
    throw new Error("vCPU worker recording dispatch table is unavailable");
  }
  return recordingDispatchTable;
}

function unavailableDisk(): number {
  return 1;
}

function unavailableDiskPoll(): number {
  return 2;
}
