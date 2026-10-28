/// <reference lib="webworker" />

import { decodeCoreRuntimeProfile } from "../core-abi/profile.js";
import { encodeUserspaceArguments } from "../userspace-abi.js";
import { exactKeys, integer, record, string } from "../decode.js";
import { readExportedView } from "./control/core.js";
import { instantiateRuntime } from "./userspace-runtime.js";
import { acknowledgeUserspaceOutput, readUserspaceOutput } from "./userspace-output.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";
import { runRingTurn, stage, termination } from "./userspace-tier2.test-support.js";

type Runtime = Awaited<ReturnType<typeof instantiateRuntime>>;

// A benchmark execution worker. Both engine arms use this exact bundle and compiler worker.
self.onmessage = (event: MessageEvent<unknown>): void => {
  void run(event.data).catch((error: unknown) => self.postMessage({ error: error instanceof Error ? error.message : String(error) }));
};

async function run(raw: unknown): Promise<void> {
  const input = record(raw, "reuse benchmark");
  exactKeys(input, ["engine", "rootfs", "elf", "arguments", "tier"]);
  const engine = localUrl(input["engine"]);
  const tier = integer(input["tier"], "tier", 1, 2);
  const values = input["arguments"];
  if (!Array.isArray(values) || values.length === 0 || values.length > 64) throw new Error("invalid benchmark arguments");
  const arguments_ = values.map((value: unknown) => string(value, "argument"));
  const compiled = await WebAssembly.compileStreaming(fetch(engine));
  const rootfs = new Uint8Array(await (await fetch(localUrl(input["rootfs"]))).arrayBuffer());
  const elf = new Uint8Array(await (await fetch(localUrl(input["elf"]))).arrayBuffer());
  if (rootfs.length > 256 * 1024 ** 2 || elf.length > 256 * 1024 ** 2) throw new Error("benchmark fixture is too large");
  const runtime = await instantiateRuntime(compiled, engine, { kind: "disabled" }, "batched");
  try {
    stage(runtime, rootfs);
    status(call(runtime.instance, "oxidevm_userspace_mount_rootfs", rootfs.length, 1, 1536));
    status(call(runtime.instance, "oxidevm_userspace_process_limit", 512));
    status(call(runtime.instance, "oxidevm_userspace_jit_configure", tier));
    for (let command = 0; command < 3; command++) {
      const before = profile(runtime);
      const jit = runtime.core.runtimeStats;
      const interpreted = jit.interpretedInstructions, translated = jit.jitInstructions;
      const compiles = runtime.core.traceProfile.worker.compileModules;
      const started = performance.now();
      const pid = spawn(runtime, elf, arguments_);
      const stdout: Uint8Array[] = [], stderr: Uint8Array[] = [];
      let peakWasmBytes = runtime.memory.buffer.byteLength;
      let externalAdapterExits = 0, executionTurns = 0;
      for (let turn = 0; turn < 1_000_000 && termination(runtime, pid) === 0xffff_ffff; turn++) {
        if (performance.now() - started > 180_000) throw new Error("benchmark command exceeded 180 seconds");
        const exit = runRingTurn(runtime);
        executionTurns++;
        if (exit?.kind === "adapter-exit") externalAdapterExits++;
        drain(runtime, pid, "stdout", stdout); drain(runtime, pid, "stderr", stderr);
        peakWasmBytes = Math.max(peakWasmBytes, runtime.memory.buffer.byteLength);
        if (runtime.jitRuntime.yieldForCompiledModule(runtime.core, 4) || turn % 64 === 0) await yieldWorker();
      }
      drain(runtime, pid, "stdout", stdout); drain(runtime, pid, "stderr", stderr);
      const elapsedMilliseconds = performance.now() - started;
      const exit = termination(runtime, pid);
      if (exit === 0xffff_ffff) throw new Error("benchmark exhausted its execution budget");
      const after = profile(runtime);
      self.postMessage({
        command, elapsedMilliseconds, exit, peakWasmBytes, externalAdapterExits, executionTurns,
        stdout: new TextDecoder().decode(concat(stdout)), stderr: new TextDecoder().decode(concat(stderr)),
        interpretedInstructions: String(jit.interpretedInstructions - interpreted),
        jitInstructions: String(jit.jitInstructions - translated),
        translations: String(after.jitCandidateCompiles - before.jitCandidateCompiles),
        tier2Translations: String(after.jitTier2Compiles - before.jitTier2Compiles),
        browserCompiles: runtime.core.traceProfile.worker.compileModules - compiles,
        residentAdapterCompletions: String(after.jitResidentAdapterCompletions - before.jitResidentAdapterCompletions),
        residentTaskSwitches: String(after.jitResidentTaskSwitches - before.jitResidentTaskSwitches),
        residentHostWaitExits: String(after.jitResidentHostWaitExits - before.jitResidentHostWaitExits),
        tier1Adoptions: String(after.jitTierOneReuseAdoptions - before.jitTierOneReuseAdoptions),
        tier2Adoptions: String(after.jitTierTwoReuseAdoptions - before.jitTierTwoReuseAdoptions),
        validationBytes: String(after.jitTierOneReuseValidationBytes - before.jitTierOneReuseValidationBytes
          + after.jitTierTwoReuseValidationBytes - before.jitTierTwoReuseValidationBytes),
        jitState: runtime.core.jitHealth.state,
      });
    }
    self.postMessage({ done: true });
  } finally { await runtime.jitRuntime.dispose(); }
}

function profile(runtime: Runtime) {
  return decodeCoreRuntimeProfile(readExportedView(runtime.core, "oxidevm_runtime_profile"));
}

function spawn(runtime: Runtime, elf: Uint8Array, arguments_: readonly string[]): number {
  const args = encodeUserspaceArguments(arguments_), env = encodeUserspaceArguments(["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/home/oxidevm", "LANG=C.UTF-8", "TZ=UTC"]);
  stage(runtime, elf, args, env, Uint8Array.of(47));
  const pid = call(runtime.instance, "oxidevm_userspace_spawn_top_level_process", elf.length, args.length, env.length, 1, 0, 0);
  if (pid === 0 || pid === 0xffff_ffff) throw new Error("benchmark spawn failed");
  return pid;
}

function drain(runtime: Runtime, pid: number, stream: "stdout" | "stderr", chunks: Uint8Array[]): void {
  for (;;) {
    const bytes = readUserspaceOutput(runtime, pid, stream);
    if (bytes.length === 0) return;
    chunks.push(bytes);
    if (chunks.reduce((sum, chunk) => sum + chunk.length, 0) > 1024 ** 2) throw new Error("benchmark output exceeded 1 MiB");
    acknowledgeUserspaceOutput(runtime, pid, stream, bytes.length);
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function localUrl(value: unknown): string {
  const url = new URL(string(value, "benchmark URL"), self.location.href);
  if (url.origin !== self.location.origin) throw new Error("benchmark URL must be local");
  return url.href;
}

function status(value: number): void { if (value !== 0) throw new Error(`benchmark status ${String(value)}`); }

function yieldWorker(): Promise<void> {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(null);
  });
}
