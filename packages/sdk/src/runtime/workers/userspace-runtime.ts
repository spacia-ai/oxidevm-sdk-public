import { UserspaceCheckpoints } from "./userspace-checkpoint.js";
import { createCoreEntropyImport } from "../core-abi.js";
/// <reference lib="webworker" />
import { VMError } from "../errors.js";
import { record } from "../decode.js";
import { USERSPACE_API_VERSION } from "../userspace-abi.js";
import { unsignedWasmPointer } from "../core-abi.js";
import { USERSPACE_JIT_CACHE_BYTES } from "../jit-cache.js";
import { createCore } from "./control/core.js";
import { JitRuntime } from "./control/jit-runtime.js";
import { browserJitCompilerHost, JitCompilerClient } from "./control/jit-compiler-client.js";
import { JitDeferredInstall } from "./control/jit-deferred-install.js";
import { jitEnginePolicy } from "./control/jit-engine-policy.js";
import type { JitDegradation } from "./control/jit-health.js";
import { DEFAULT_JIT_INSTALL_MODE, type SystemJitInstallMode } from "../protocol/system-trace-background-compile.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";
import type { ExecutionTimingMode } from "../protocol/common.js";

export async function instantiateRuntime(compiled: WebAssembly.Module, source: string, executionTiming: ExecutionTimingMode, jitInstall: SystemJitInstallMode = DEFAULT_JIT_INSTALL_MODE, onJitDegraded?: (degradation: JitDegradation) => void) {
  const holder: { memory?: WebAssembly.Memory } = {};
  const unavailableDisk = () => 1;
  const loaded = await WebAssembly.instantiate(compiled, {
    oxidevm_host: {
      entropy_fill: createCoreEntropyImport(() => holder.memory),
      disk_zero: unavailableDisk,
      disk_poll: () => 0,
      disk_read: unavailableDisk,
      disk_flush: unavailableDisk,
      disk_write: unavailableDisk,
      disk_read_start: unavailableDisk,
      disk_flush_start: unavailableDisk,
      disk_discard: unavailableDisk,
    },
    oxidevm_userspace_host: {
      clock_gettime: (clock: number, address: number) => {
        if (clock !== 0 && clock !== 1) return 1;
        const now = clock === 0 ? Date.now() : performance.now();
        new DataView(requireMemory(holder.memory).buffer).setBigUint64(
          unsignedWasmPointer(address),
          BigInt(Math.floor(now * 1_000_000)),
          true,
        );
        return 0;
      },
      entropy_fill: (address: number, length: number) => {
        // Wasm i32 addresses arrive signed in JS, including valid offsets above 2 GiB.
        const bytes = new Uint8Array(
          requireMemory(holder.memory).buffer,
          unsignedWasmPointer(address),
          unsignedWasmPointer(length),
        );
        for (let offset = 0; offset < bytes.byteLength; offset += 65_536) {
          crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65_536, bytes.byteLength)));
        }
        return 0;
      },
    },
  });
  const memoryExport = loaded.exports["memory"];
  if (!(memoryExport instanceof WebAssembly.Memory)) {
    throw new VMError("CORE_LOAD_FAILED", "Userspace Wasm memory is missing");
  }
  holder.memory = memoryExport;
  if (call(loaded, "oxidevm_userspace_api_version") !== USERSPACE_API_VERSION) {
    throw new VMError("CORE_LOAD_FAILED", "Userspace Wasm API is unsupported");
  }
  for (const name of ["oxidevm_jit_aliases_ptr", "oxidevm_jit_aliases_len", "oxidevm_jit_aliases_ack"]) {
    if (typeof loaded.exports[name] !== "function") {
      throw new VMError("CORE_LOAD_FAILED", "Userspace JIT alias exports are missing");
    }
  }
  const jitPolicy = jitEnginePolicy();
  const jitRuntime = new JitRuntime(
    executionTiming,
    undefined,
    new JitDeferredInstall(jitInstall, new JitCompilerClient(browserJitCompilerHost()), jitPolicy.batch),
    onJitDegraded,
  );
  jitRuntime.initialize();
  const core = createCore(
    record(loaded.exports, "Userspace Wasm exports"), memoryExport, source,
    USERSPACE_JIT_CACHE_BYTES, jitPolicy,
  );
  const checkpoints = new UserspaceCheckpoints({ instance: loaded, memory: memoryExport }, () => {
    jitRuntime.invalidate(); jitRuntime.clearCatalogBindings(core);
  });
  return { instance: loaded, core, memory: memoryExport, jitRuntime, checkpoints };
}

function requireMemory(memory: WebAssembly.Memory | undefined): WebAssembly.Memory {
  if (memory === undefined) throw new VMError("CORE_LOAD_FAILED", "Userspace memory has not been installed"); return memory;
}
