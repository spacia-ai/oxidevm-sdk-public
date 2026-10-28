import { encodeUserspaceArguments } from "../userspace-abi.js";
import type { CoreRunExit } from "../core-abi.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";
import type { instantiateRuntime } from "./userspace-runtime.js";

export type TestRuntime = Awaited<ReturnType<typeof instantiateRuntime>>;

/** Original guest x86 instruction bytes, not emulator implementation. Four code pages force
 * Tier-1 boundaries and let a hot trace remove those boundaries. Exit with the sum's low byte. */
export function traceRingElf(iterations = 4_000_000, subtract = false, shape: "ring" | "cold-successors" = "ring"): Uint8Array<ArrayBuffer> {
  const headers = 120;
  const elf = new Uint8Array(headers + 4 * 4096);
  const view = new DataView(elf.buffer);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  view.setUint16(16, 2, true);
  view.setUint16(18, 62, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(24, BigInt(0x40_0000 + headers), true);
  view.setBigUint64(32, 64n, true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 1, true);
  view.setUint32(64, 1, true);
  view.setUint32(68, 5, true); // R+X; writable ELF code is intentionally rejected by the loader
  view.setBigUint64(80, 0x40_0000n, true);
  view.setBigUint64(88, 0x40_0000n, true);
  view.setBigUint64(96, BigInt(elf.length), true);
  view.setBigUint64(104, BigInt(elf.length), true);
  view.setBigUint64(112, 4096n, true);
  const code = elf.subarray(headers);
  const jump = (at: number, target: number): void => {
    code[at] = 0xe9;
    view.setInt32(headers + at + 1, target - at - 5, true);
  };
  const hotJump = (at: number, target: number): void => {
    if (shape === "ring") { jump(at, target); return; }
    code.set([0x4d, 0x39, 0xe4, 0x0f, 0x84, 0, 0, 0, 0], at); // cmp r12,r12; je hot
    view.setInt32(headers + at + 5, target - at - 9, true);
    code.fill(0x90, at + 9, at + 309);
    jump(at + 309, target);
  };
  code.set([0xb9, 0, 0, 0, 0, 0x31, 0xc0]);
  view.setUint32(headers + 1, iterations, true);
  jump(7, 128);
  code.set([0x48, subtract ? 0x29 : 0x01, 0xc8], 128); // add/sub rax,rcx
  hotJump(131, 4096);
  code.set([0x48, 0x89, 0x44, 0x24, 0xf8], 4096); // mov [rsp-8],rax
  hotJump(4101, 8192);
  code.set([0x48, 0x8b, 0x54, 0x24, 0xf8, 0x48, 0x39, 0xc2], 8192);
  hotJump(8200, 12288);
  code.set([0xff, 0xc9, 0x0f, 0x85, 0, 0, 0, 0], 12288);
  view.setInt32(headers + 12292, 128 - 12296, true);
  code.set([0x89, 0xc7, 0x81, 0xe7, 255, 0, 0, 0, 0xb8, 231, 0, 0, 0, 0x0f, 0x05], 12296);
  return elf;
}

export function mountTestRuntime(runtime: TestRuntime, tier: 1 | 2): void {
  const rootfs = new Uint8Array([0x4f, 0x58, 0x52, 0x46, 4, 0, 0, 0, 0, 0, 0, 0]);
  stage(runtime, rootfs);
  status(call(runtime.instance, "oxidevm_userspace_mount_rootfs", rootfs.length, 1, 64));
  status(call(runtime.instance, "oxidevm_userspace_jit_configure", tier));
}

export function spawnRing(runtime: TestRuntime, elf = traceRingElf()): number {
  const args = encodeUserspaceArguments(["/ring"]), env = encodeUserspaceArguments([]);
  stage(runtime, elf, args, env, Uint8Array.of(47));
  const pid = call(runtime.instance, "oxidevm_userspace_spawn_top_level_process", elf.length, args.length, env.length, 1, 0, 0, 0);
  if (pid === 0 || pid === 0xffff_ffff) throw new Error("spawn failed");
  return pid;
}

export function runRingTurn(runtime: TestRuntime, budget = 100_000): CoreRunExit | undefined {
  const prepared = call(runtime.instance, "oxidevm_userspace_prepare");
  if (prepared === 3 || prepared === 4 || prepared === 5) return;
  status(prepared);
  const exit = runtime.jitRuntime.runLinuxBlock(runtime.core, 0, budget, () => undefined)
    ?? runtime.jitRuntime.runLinuxGuardFallback(runtime.core, budget);
  if (exit.kind === "adapter-exit") {
    const completed = call(runtime.instance, "oxidevm_userspace_complete_syscall");
    if (completed !== 3 && completed !== 4 && completed !== 5) status(completed);
  } else if (exit.kind === "exception") {
    const exception = exit.exception;
    const classes = { fault: 0, trap: 1, abort: 2, interrupt: 3 } as const;
    const flags = (exception.errorCode === undefined ? 0 : 1)
      | (exception.faultAddress === undefined ? 0 : 2);
    // Real programs also need Rust to resolve lazy pages and deliver guest signals.
    status(call(runtime.instance, "oxidevm_userspace_handle_exception", exception.vector.number,
      classes[exception.class], flags, exception.errorCode ?? 0, exception.faultAddress ?? 0n,
      exception.instructionRip));
  } else if (exit.kind !== "step-limit") throw new Error(`unexpected exit ${exit.kind}`);
  return exit;
}

export function termination(runtime: TestRuntime, pid: number): number {
  return call(runtime.instance, "oxidevm_userspace_process_termination", pid) >>> 0;
}

export function stage(runtime: Pick<TestRuntime, "instance" | "memory">, ...parts: readonly Uint8Array[]): void {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  status(call(runtime.instance, "oxidevm_userspace_staging_resize", length));
  const bytes = new Uint8Array(runtime.memory.buffer, call(runtime.instance, "oxidevm_userspace_staging_ptr"), length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
}

function status(value: number): void {
  if (value !== 0) throw new Error(`unexpected status ${value}`);
}

/** The parent warms the ring, forks, and verifies the child's independent sum through wait4. */
export function forkRingElf(iterations = 4_000_000): Uint8Array<ArrayBuffer> {
  const elf = traceRingElf(iterations);
  const tail = 12296;
  const body: number[] = [];
  const branch = (...opcode: number[]): number => {
    body.push(...opcode);
    const offset = body.length;
    body.push(0, 0, 0, 0);
    return offset;
  };
  body.push(0x45, 0x85, 0xe4); // test r12d,r12d
  const finish = branch(0x0f, 0x85);
  body.push(0xb8, 57, 0, 0, 0, 0x0f, 0x05, 0x85, 0xc0); // fork; test eax,eax
  const parent = branch(0x0f, 0x85);
  body.push(0x41, 0xbc, 1, 0, 0, 0, 0xb9);
  const count = body.length;
  body.push(0, 0, 0, 0, 0x31, 0xc0);
  const loop = branch(0xe9);
  const wait = tail + body.length;
  body.push(0x89, 0xc7, 0x48, 0x8d, 0x74, 0x24, 0xf8, 0x31, 0xd2, 0x45, 0x31, 0xd2,
    0xb8, 61, 0, 0, 0, 0x0f, 0x05, // wait4(child, rsp-8, 0, NULL)
    0x8b, 0x7c, 0x24, 0xf8, 0xc1, 0xef, 8, 0x81, 0xe7, 255, 0, 0, 0,
    0x81, 0xf7, Number(BigInt(iterations) * BigInt(iterations + 1) / 2n & 255n), 0, 0, 0,
    0xb8, 231, 0, 0, 0, 0x0f, 0x05);
  const exit = tail + body.length;
  body.push(0x89, 0xc7, 0x81, 0xe7, 255, 0, 0, 0, 0xb8, 60, 0, 0, 0, 0x0f, 0x05);
  elf.set(body, 120 + tail);
  const view = new DataView(elf.buffer);
  view.setUint32(120 + tail + count, iterations, true);
  for (const [offset, target] of [[finish, exit], [parent, wait], [loop, 128]] as const) {
    view.setInt32(120 + tail + offset, target - tail - offset - 4, true);
  }
  return elf;
}
