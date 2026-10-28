import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";

import { decodeUserspaceRunResult, encodeUserspaceArguments, type UserspaceRunResult } from "../userspace-abi.js";
import type { JitDegradation } from "./control/jit-health.js";
import { engineModulePath } from "./engine-wasm.test-support.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";
import { instantiateRuntime } from "./userspace-runtime.js";

// The Userspace worker runs every process of a runtime on one JIT; a module the browser cannot
// compile used to fail every process (`userspace.worker.ts` fails all processes on a thrown
// turn). This drives the real Userspace engine through the worker's turn sequence (prepare,
// runLinuxBlock, complete the syscall) with two processes while the engine refuses every
// compile for lack of executable memory: both must exit with their own results.

const EMPTY_ROOTFS = new Uint8Array([0x4f, 0x58, 0x52, 0x46, 4, 0, 0, 0, 0, 0, 0, 0]);
const RUN_STEPS = 1_000_000;

/** A static x86-64 ELF: `padding` NOPs, `mov ecx, N; xor eax, eax; loop: add rax, rcx; dec ecx;
 * jnz loop; mov edi, eax; and edi, 0xff; mov eax, 231; syscall` (exit_group with the sum's low
 * byte). Different padding places the loop at a different address, so it needs its own module. */
function summingElf(iterations: number, padding: number): Uint8Array {
  const code = [
    ...new Array<number>(padding).fill(0x90),
    0xb9, 0, 0, 0, 0,
    0x31, 0xc0,
    0x48, 0x01, 0xc8,
    0xff, 0xc9,
    0x75, 0xf9,
    0x89, 0xc7,
    0x81, 0xe7, 0xff, 0, 0, 0,
    0xb8, 231, 0, 0, 0,
    0x0f, 0x05,
  ];
  const base = 0x40_0000;
  const headers = 64 + 56;
  const elf = new Uint8Array(headers + code.length);
  const view = new DataView(elf.buffer);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  view.setUint16(16, 2, true); // ET_EXEC
  view.setUint16(18, 62, true); // x86-64
  view.setUint32(20, 1, true);
  view.setBigUint64(24, BigInt(base + headers), true); // entry
  view.setBigUint64(32, 64n, true); // program headers
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 1, true);
  view.setUint32(64, 1, true); // PT_LOAD
  view.setUint32(68, 5, true); // R+X
  view.setBigUint64(80, BigInt(base), true);
  view.setBigUint64(88, BigInt(base), true);
  view.setBigUint64(96, BigInt(elf.byteLength), true);
  view.setBigUint64(104, BigInt(elf.byteLength), true);
  view.setBigUint64(112, 0x1000n, true);
  elf.set(code, headers);
  new DataView(elf.buffer, headers + padding + 1, 4).setUint32(0, iterations, true);
  return elf;
}

function expectedExit(iterations: number): number {
  return Number((BigInt(iterations) * BigInt(iterations + 1) / 2n) & 0xffn);
}

type Runtime = Awaited<ReturnType<typeof instantiateRuntime>>;

function spawn(runtime: Runtime, elf: Uint8Array): number {
  const args = encodeUserspaceArguments(["/sum"]);
  const env = encodeUserspaceArguments([]);
  const cwd = new TextEncoder().encode("/");
  const length = elf.byteLength + args.byteLength + env.byteLength + cwd.byteLength;
  expect(call(runtime.instance, "oxidevm_userspace_staging_resize", length)).toBe(0);
  const staging = new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), length);
  staging.set(elf);
  staging.set(args, elf.byteLength);
  staging.set(env, elf.byteLength + args.byteLength);
  staging.set(cwd, elf.byteLength + args.byteLength + env.byteLength);
  const pid = call(runtime.instance, "oxidevm_userspace_spawn_top_level_process", elf.byteLength, args.byteLength, env.byteLength, cwd.byteLength, 0, 0);
  expect(pid).toBeGreaterThan(0);
  return pid;
}

function readResult(runtime: Runtime): UserspaceRunResult {
  const pointer = call(runtime.instance, "oxidevm_userspace_result_ptr");
  const length = call(runtime.instance, "oxidevm_userspace_result_len");
  return decodeUserspaceRunResult(new Uint8Array(runtime.memory.buffer, pointer, length));
}

/** One worker turn (`runJitTurn` and `completeJitExit`) without host I/O. */
function turn(runtime: Runtime): UserspaceRunResult {
  const prepared = call(runtime.instance, "oxidevm_userspace_prepare");
  if (prepared === 3 || prepared === 4 || prepared === 5) return readResult(runtime);
  expect(prepared).toBe(0);
  const exit = runtime.jitRuntime.runLinuxBlock(runtime.core, 0, RUN_STEPS, () => undefined)
    ?? runtime.jitRuntime.runLinuxGuardFallback(runtime.core, RUN_STEPS);
  if (exit.kind === "adapter-exit") {
    const status = call(runtime.instance, "oxidevm_userspace_complete_syscall");
    if (status === 3 || status === 4 || status === 5) return readResult(runtime);
    expect(status).toBe(0);
    return { kind: "step-limit" };
  }
  if (exit.kind !== "step-limit") throw new Error(`unexpected exit ${exit.kind}`);
  return { kind: "step-limit" };
}

function termination(runtime: Runtime, pid: number): number {
  return call(runtime.instance, "oxidevm_userspace_process_termination", pid) >>> 0;
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("keeps every process running when compiles run out of executable memory", async () => {
  const bytes = await readFile(engineModulePath("oxidevm_userspace.wasm"));
  const module = await WebAssembly.compile(new Uint8Array(bytes).buffer);
  const degradations: JitDegradation[] = [];
  // No compiler worker in Node: every compile happens on the guest's thread.
  const runtime = await instantiateRuntime(module, "userspace.wasm", { kind: "disabled" }, "immediate", (event) => degradations.push(event));
  try {
    expect(call(runtime.instance, "oxidevm_userspace_staging_resize", EMPTY_ROOTFS.byteLength)).toBe(0);
    new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), EMPTY_ROOTFS.byteLength).set(EMPTY_ROOTFS);
    expect(call(runtime.instance, "oxidevm_userspace_mount_rootfs", EMPTY_ROOTFS.byteLength, 1, 256)).toBe(0);
    const Original = WebAssembly.Module;
    let compiles = 0;
    // The engine compiles the dispatcher and the first translation, then has no code memory left.
    vi.spyOn(WebAssembly, "Module").mockImplementation(function (source: BufferSource) {
      compiles += 1;
      if (compiles > 2) throw new RangeError("WebAssembly.Module(): Out of memory: Cannot allocate Wasm code");
      return new Original(source);
    });
    const first = spawn(runtime, summingElf(20_000, 0));

    // The first process runs its loop translated before the second one starts.
    while (runtime.core.runtimeStats.jitInstructions === 0n) turn(runtime);
    const second = spawn(runtime, summingElf(30_000, 16));
    for (let turns = 0; turns < 100_000; turns += 1) {
      const result = turn(runtime);
      expect(result.kind).not.toBe("fault");
      if (termination(runtime, first) !== 0xffff_ffff && termination(runtime, second) !== 0xffff_ffff) break;
    }

    expect(termination(runtime, first)).toBe(expectedExit(20_000));
    expect(termination(runtime, second)).toBe(expectedExit(30_000));
    expect(runtime.core.jitHealth).toMatchObject({
      state: "exhausted",
      reason: "code-memory",
      firstFailure: { phase: "synchronous-compile", errorName: "RangeError" },
    });
    expect(runtime.core.jitHealth.parkedCompiles).toBeGreaterThan(0);
    expect(degradations).toHaveLength(1);
  } finally {
    await runtime.jitRuntime.dispose();
  }
});
