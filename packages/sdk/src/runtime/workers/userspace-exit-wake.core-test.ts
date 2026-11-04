import { readFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";

import { encodeUserspaceArguments } from "../userspace-abi.js";
import { engineModulePath } from "./engine-wasm.test-support.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";
import { instantiateRuntime } from "./userspace-runtime.js";
import { preparesAgainAfter } from "./userspace-service.js";
import { mountTestRuntime, runRingTurn, spawnRing, stage, termination, traceRingElf, type TestRuntime } from "./userspace-tier2.test-support.js";

const runtimes: TestRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.jitRuntime.dispose(); });

/** Original guest bytes: read(0, rsp-16, 1); exit_group(0). The process blocks on its open standard input. */
function blockedReaderElf(): Uint8Array<ArrayBuffer> {
  const code = [0x31, 0xff, 0x48, 0x8d, 0x74, 0x24, 0xf0, 0xba, 0x01, 0x00, 0x00, 0x00, 0x31, 0xc0, 0x0f, 0x05,
    0x31, 0xff, 0xb8, 0xe7, 0x00, 0x00, 0x00, 0x0f, 0x05];
  const headers = 120, elf = new Uint8Array(headers + code.length), view = new DataView(elf.buffer);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  view.setUint16(16, 2, true); view.setUint16(18, 62, true); view.setUint32(20, 1, true);
  view.setBigUint64(24, BigInt(0x40_0000 + headers), true); view.setBigUint64(32, 64n, true);
  view.setUint16(52, 64, true); view.setUint16(54, 56, true); view.setUint16(56, 1, true);
  view.setUint32(64, 1, true); view.setUint32(68, 5, true);
  view.setBigUint64(80, 0x40_0000n, true); view.setBigUint64(88, 0x40_0000n, true);
  view.setBigUint64(96, BigInt(elf.length), true); view.setBigUint64(104, BigInt(elf.length), true);
  view.setBigUint64(112, 4096n, true);
  elf.set(code, headers);
  return elf;
}

function spawn(runtime: TestRuntime, elf: Uint8Array, name: string): number {
  const args = encodeUserspaceArguments([name]), env = encodeUserspaceArguments([]);
  stage(runtime, elf, args, env, Uint8Array.of(47));
  const pid = call(runtime.instance, "oxidevm_userspace_spawn_top_level_process", elf.length, args.length, env.length, 1, 0, 0, 0);
  if (pid === 0 || pid === 0xffff_ffff) throw new Error("spawn failed");
  return pid;
}

/** One worker turn (`runJitTurn`): "exit" or "blocked" when the preparation ends it, else "step-limit". */
function turn(runtime: TestRuntime): "exit" | "blocked" | "step-limit" {
  const prepared = call(runtime.instance, "oxidevm_userspace_prepare");
  if (prepared === 3) return "exit";
  if (prepared === 4 || prepared === 5) return "blocked";
  expect(prepared).toBe(0);
  const exit = runtime.jitRuntime.runLinuxBlock(runtime.core, 0, 100_000, () => undefined)
    ?? runtime.jitRuntime.runLinuxGuardFallback(runtime.core, 100_000);
  if (exit.kind === "adapter-exit") {
    const completed = call(runtime.instance, "oxidevm_userspace_complete_syscall");
    if (completed === 3) return "exit";
    if (completed === 4 || completed === 5) return "blocked";
    expect(completed).toBe(0);
  } else expect(exit.kind).toBe("step-limit");
  return "step-limit";
}

it("a SIGKILL delivered before the stored exit is consumed still ends its blocked process", async () => {
  const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
  const runtime = await instantiateRuntime(await WebAssembly.compile(bytes.buffer), "exit-wake-core-test", { kind: "disabled" }, "immediate");
  runtimes.push(runtime);
  mountTestRuntime(runtime, 1);
  const blocked = spawn(runtime, blockedReaderElf(), "/blocked");
  // A hot ring exits from inside the resident JIT loop, which stores its exit for the next preparation.
  const exiting = spawnRing(runtime, traceRingElf(400_000));
  for (let turns = 0; turns < 10_000 && termination(runtime, exiting) === 0xffff_ffff; turns++) runRingTurn(runtime);
  expect(termination(runtime, exiting)).not.toBe(0xffff_ffff);
  expect(termination(runtime, blocked)).toBe(0xffff_ffff);

  // The host kills the blocked process before the worker's next turn (the browser race).
  expect(call(runtime.instance, "oxidevm_userspace_process_signal", blocked, 9)).toBe(0);

  // The worker keeps preparing while its policy says so; a boundary that does not prepare again
  // waits for a deadline or an event, and none comes for an already runnable process.
  let boundary = turn(runtime);
  for (let turns = 0; turns < 100 && (boundary === "step-limit" || preparesAgainAfter(boundary)); turns++) {
    if (termination(runtime, blocked) !== 0xffff_ffff) break;
    boundary = turn(runtime);
  }
  expect(termination(runtime, blocked)).not.toBe(0xffff_ffff);
});
