import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { decodeUserspaceSyscallTrace, USERSPACE_SYSCALL_TRACE_VERSION } from "../userspace-abi.js";
import { engineModulePath } from "./engine-wasm.test-support.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";
import { instantiateRuntime } from "./userspace-runtime.js";
import { readUserspaceSyscallTrace } from "./userspace-trace-read.js";
import { mountTestRuntime, runRingTurn, spawnRing, termination, traceRingElf } from "./userspace-tier2.test-support.js";

const module = await WebAssembly.compile(new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm"))).buffer);

/** Reuse the existing static ELF fixture's headers; execute only this original syscall loop. */
function syscallLoop(): Uint8Array<ArrayBuffer> {
  const elf = traceRingElf(1);
  elf.fill(0, 120);
  elf.set([
    0x41, 0xb8, 0x88, 0x13, 0, 0, // mov r8d,5000 (survives SYSCALL's RCX/R11 clobbers)
    0xb8, 39, 0, 0, 0, 0x0f, 0x05, // getpid
    0x41, 0xff, 0xc8, 0x75, 0xf4, // dec r8d; jnz getpid
    0x31, 0xff, 0xb8, 231, 0, 0, 0, 0x0f, 0x05, // exit_group(0)
  ], 120);
  return elf;
}

it.each(["snapshot", "drain"] as const)("reads a full real native trace through %s and reconciles the dropped prefix", async mode => {
  const runtime = await instantiateRuntime(module, "full-trace-test", { kind: "disabled" }, "immediate");
  try {
    mountTestRuntime(runtime, 1);
    const pid = spawnRing(runtime, syscallLoop());
    expect(call(runtime.instance, "oxidevm_userspace_syscall_trace_configure", 4096)).toBe(0);
    for (let turn = 0; turn < 20_000 && termination(runtime, pid) === 0xffff_ffff; turn++) {
      runRingTurn(runtime);
    }
    expect(termination(runtime, pid)).toBe(0);
    const bytes = readUserspaceSyscallTrace(runtime, mode);
    const trace = decodeUserspaceSyscallTrace(bytes);
    expect(trace.version).toBe(USERSPACE_SYSCALL_TRACE_VERSION);
    expect(trace.events).toHaveLength(4096);
    expect(trace.dropped).toBe(905n);
    expect(trace.events[0]?.sequence).toBe(906n);
    expect(trace.events.at(-1)).toMatchObject({ sequence: 5001n, number: 231n, outcome: { kind: "exit", status: 0 } });
    expect(trace.events.slice(0, -1).every(event => event.number === 39n)).toBe(true);
    if (mode === "drain") {
      expect(decodeUserspaceSyscallTrace(readUserspaceSyscallTrace(runtime, mode))).toMatchObject({
        dropped: 905n, events: [],
      });
    } else {
      const repeated = readUserspaceSyscallTrace(runtime, mode);
      expect(repeated.byteLength).toBe(bytes.byteLength);
      expect(repeated.every((byte, index) => byte === bytes[index])).toBe(true);
    }
  } finally { await runtime.jitRuntime.dispose(); }
});
