import { readFile } from "node:fs/promises";

import { decodeCpuSnapshot } from "../../core-abi.js";
import { record } from "../../decode.js";
import { unavailableDiskBridgeImports } from "../../disk-bridge.js";
import { JIT_CACHE_BYTES } from "../../jit-cache.js";
import {
  type Core,
  assertStatus,
  callNumber,
  createCore,
  readRecord,
  stage,
} from "./core.js";
import { loadDiagnosticLongMode } from "./diagnostic-core.js";
import { type JitCompilerTransport, JitCompilerClient } from "./jit-compiler-client.js";
import {
  JIT_COMPILER_PROTOCOL_VERSION,
  type JitCompilerRequest,
  decodeJitCompilerRequest,
} from "./jit-compiler-protocol.js";
import { type JitBatchPolicy, JitDeferredInstall } from "./jit-deferred-install.js";
import { DEFAULT_JIT_POLICY, type JitEnginePolicy } from "./jit-engine-policy.js";
import type { JitDegradation } from "./jit-health.js";
import { JitRuntime } from "./jit-runtime.js";
import { engineModulePath } from "../engine-wasm.test-support.js";

// The full-system core of an engine release (OXIDEVM_ENGINE_DIR). These tests drive the real Rust
// core through the real JitRuntime, as the control worker's diagnostic probe does, so they run from
// `pnpm test:core` with an engine release rather than from `pnpm test`.
const CORE_WASM = engineModulePath("oxidevm_core.wasm");
export const ITERATIONS = 10_000;

/** `mov ecx, N; xor eax, eax; loop: <op> rax, rcx; dec ecx; jnz loop; hlt`. */
export function summingLoop(operation: "add" | "sub"): Uint8Array {
  const program = new Uint8Array([
    0xb9, 0, 0, 0, 0, // mov ecx, ITERATIONS
    0x31, 0xc0, // xor eax, eax
    0x48, operation === "add" ? 0x01 : 0x29, 0xc8, // loop: add/sub rax, rcx
    0xff, 0xc9, // dec ecx
    0x75, 0xf9, // jnz loop
    0xf4, // hlt
  ]);
  new DataView(program.buffer).setUint32(1, ITERATIONS, true);
  return program;
}

export const LOOP_RETIRED = 2n + 3n * BigInt(ITERATIONS) + 1n;
export const LOOP_SUM = BigInt(ITERATIONS) * BigInt(ITERATIONS + 1) / 2n;

/** `xor eax, eax`, then `count` times `mov ecx, N; loop: add rax, rcx; dec ecx; jnz loop`, then
 * `hlt`: one hot block per loop, each reached after the previous loop ends. */
export function summingLoops(count: number): Uint8Array {
  const loop = [0xb9, 0, 0, 0, 0, 0x48, 0x01, 0xc8, 0xff, 0xc9, 0x75, 0xf9];
  const program = new Uint8Array(2 + count * loop.length + 1);
  program.set([0x31, 0xc0]);
  for (let index = 0; index < count; index += 1) {
    const at = 2 + index * loop.length;
    program.set(loop, at);
    new DataView(program.buffer).setUint32(at + 1, ITERATIONS, true);
  }
  program[program.length - 1] = 0xf4;
  return program;
}

export async function loadStagedCore(jitPolicy: JitEnginePolicy = DEFAULT_JIT_POLICY): Promise<Core> {
  const bytes = new Uint8Array(await readFile(CORE_WASM));
  const { instance } = await WebAssembly.instantiate(bytes, {
    oxidevm_host: { ...unavailableDiskBridgeImports, entropy_fill: () => 1 },
  });
  const exports = record(instance.exports, "core exports");
  const memory = exports["memory"];
  if (!(memory instanceof WebAssembly.Memory)) throw new TypeError("core memory export is missing");
  return createCore(exports, memory, "jit-runtime-core-test", JIT_CACHE_BYTES, jitPolicy);
}

/** A compiler worker that answers only when the test lets it, compiling on the test's thread. */
export class ManualCompiler implements JitCompilerTransport {
  readonly #listeners = new Map<string, Set<(event: Event) => void>>();
  #pending: Extract<JitCompilerRequest, { readonly type: "compile" }>[] = [];
  /** `failed` is a rejected module, `out-of-memory` a compile without executable memory left. */
  answer: "compiled" | "failed" | "out-of-memory" | "crash" = "compiled";

  postMessage(message: unknown): void {
    const request = decodeJitCompilerRequest(message);
    if (request.type === "compile") this.#pending.push(request);
  }

  terminate(): void {
    this.#pending = [];
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  get pending(): number {
    return this.#pending.length;
  }

  /** Answers every compile received so far. */
  release(): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const request of pending) {
      if (this.answer === "crash") {
        this.#emit("error", new Event("error"));
        return;
      }
      this.#emit("message", new MessageEvent("message", {
        data: this.answer === "compiled"
          ? {
              version: JIT_COMPILER_PROTOCOL_VERSION,
              type: "compiled",
              id: request.id,
              epoch: request.epoch,
              module: new WebAssembly.Module(request.bytes),
              compileMilliseconds: 0.5,
            }
          : {
              version: JIT_COMPILER_PROTOCOL_VERSION,
              type: "failed",
              id: request.id,
              epoch: request.epoch,
              // SpiderMonkey rejects a compile with no executable memory left as "out of memory".
              ...(this.answer === "out-of-memory"
                ? { errorName: "Error", reason: "out of memory" }
                : { errorName: "CompileError", reason: "rejected by the test" }),
            },
      }));
    }
  }

  #emit(type: string, event: Event): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

export function deferredRuntime(
  mode: "deferred" | "batched" = "deferred",
  onDegraded?: (degradation: JitDegradation) => void,
  batchPolicy?: JitBatchPolicy,
): { readonly runtime: JitRuntime; readonly compilers: ManualCompiler[] } {
  const compilers: ManualCompiler[] = [];
  const client = new JitCompilerClient({
    createTransport: () => {
      const compiler = new ManualCompiler();
      compilers.push(compiler);
      return compiler;
    },
    now: () => 0,
    timer: { arm: () => undefined, cancel: () => undefined },
    sharedCounter: () => null,
  });
  const runtime = new JitRuntime(
    undefined,
    undefined,
    new JitDeferredInstall(mode, client, batchPolicy),
    onDegraded,
  );
  runtime.initialize();
  return { runtime, compilers };
}

/** Runs `program` to its halt the way the control worker's diagnostic probe does; `between`
 * runs after every block, as the worker's event loop runs between slices. */
export function runToHalt(
  loaded: Core,
  runtime: JitRuntime,
  program: Uint8Array,
  between: () => void = () => undefined,
): bigint {
  assertStatus(callNumber(loaded, "oxidevm_reset", [0, 0]));
  const programAddress = loadDiagnosticLongMode(loaded);
  stage(loaded, program);
  assertStatus(callNumber(loaded, "oxidevm_load_memory", [programAddress, program.byteLength]));
  let retired = 0n;
  for (let remaining = 1_000_000; remaining > 0;) {
    const exit = runtime.runBlock(loaded, 0, remaining, false, () => undefined)
      ?? runtime.runGuardFallback(loaded, remaining);
    retired += exit.steps;
    remaining -= Number(exit.steps);
    between();
    if (exit.kind === "halted") return retired;
    if (exit.kind !== "step-limit") throw new Error(`unexpected exit ${exit.kind}`);
  }
  throw new Error("program did not halt within its budget");
}

export function rax(loaded: Core): bigint {
  return decodeCpuSnapshot(readRecord(loaded, "cpu-state")).state.rax;
}

