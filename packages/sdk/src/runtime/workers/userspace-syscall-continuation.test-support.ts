import { traceRingElf } from "./userspace-tier2.test-support.js";

/** Original unrolled x86 syscall sites model cold command startup. */
export function coldSyscallsElf(count = 512): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 2_000) throw new Error("invalid cold syscall count");
  const elf = traceRingElf(1);
  const code: number[] = [];
  for (let index = 0; index < count; index++) code.push(0xb8, 39, 0, 0, 0, 0x0f, 0x05);
  code.push(0x31, 0xff, 0xb8, 231, 0, 0, 0, 0x0f, 0x05);
  elf.set(code, 120);
  return elf;
}

/** A repeated getpid validates stable identity; a private futex wake must return zero. */
export function readySyscallsElf(count = 200_000, operation: "getpid" | "futex-wake" = "getpid"): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) throw new Error("invalid ready syscall count");
  const elf = traceRingElf(1);
  const code: number[] = [];
  if (operation === "futex-wake") {
    code.push(0x48, 0x83, 0xec, 16, 0xc7, 4, 0x24, 0, 0, 0, 0, // private stack word
      0x48, 0x89, 0xe7, 0xbe, 129, 0, 0, 0, 0xba, 1, 0, 0, 0);
  }
  code.push(0x41, 0xbc, count & 255, count >>> 8 & 255, count >>> 16 & 255, count >>> 24);
  if (operation === "getpid") code.push(0xb8, 39, 0, 0, 0, 0x0f, 0x05, 0x49, 0x89, 0xc5);
  const loop = code.length;
  code.push(0xb8, operation === "getpid" ? 39 : 202, 0, 0, 0, 0x0f, 0x05);
  code.push(...operation === "getpid" ? [0x4c, 0x39, 0xe8] : [0x85, 0xc0]);
  code.push(0x0f, 0x85, 0, 0, 0, 0);
  const failJump = code.length - 4;
  code.push(0x41, 0xff, 0xcc, 0x0f, 0x85, 0, 0, 0, 0);
  const backJump = code.length - 4;
  code.push(0x31, 0xff, 0xb8, 231, 0, 0, 0, 0x0f, 0x05);
  const fail = code.length;
  code.push(0xbf, 99, 0, 0, 0, 0xb8, 231, 0, 0, 0, 0x0f, 0x05);
  const body = Uint8Array.from(code);
  const view = new DataView(body.buffer);
  view.setInt32(failJump, fail - failJump - 4, true);
  view.setInt32(backJump, loop - backJump - 4, true);
  elf.set(body, 120);
  return elf;
}

/** Install an ordinary guest seccomp filter: getpid must return raw errno 17. */
export function filteredSyscallElf(): Uint8Array<ArrayBuffer> {
  const elf = traceRingElf(1);
  const code = [
    0xb8, 157, 0, 0, 0, 0xbf, 38, 0, 0, 0, 0xbe, 1, 0, 0, 0,
    0x31, 0xd2, 0x45, 0x31, 0xd2, 0x45, 0x31, 0xc0, 0x45, 0x31, 0xc9, 0x0f, 0x05,
  ];
  const failures: number[] = [];
  const check = (): void => { code.push(0x85, 0xc0, 0x0f, 0x85, 0, 0, 0, 0); failures.push(code.length - 4); };
  check();
  code.push(0xb8, 61, 1, 0, 0, 0xbf, 1, 0, 0, 0, 0x31, 0xf6, 0xba, 0, 0, 0, 0, 0x0f, 0x05);
  const programAddress = code.length - 6;
  check();
  code.push(0xb8, 39, 0, 0, 0, 0x0f, 0x05, 0x48, 0x83, 0xf8, 0xef, 0x0f, 0x85, 0, 0, 0, 0);
  failures.push(code.length - 4);
  code.push(0x31, 0xff, 0xb8, 231, 0, 0, 0, 0x0f, 0x05);
  const fail = code.length;
  code.push(0xbf, 99, 0, 0, 0, 0xb8, 231, 0, 0, 0, 0x0f, 0x05);
  const body = Uint8Array.from(code);
  const view = new DataView(body.buffer);
  view.setUint32(programAddress, 0x40_0000 + 120 + 512, true);
  for (const offset of failures) view.setInt32(offset, fail - offset - 4, true);
  elf.set(body, 120);
  const data = new DataView(elf.buffer);
  data.setUint16(120 + 512, 4, true);
  data.setBigUint64(120 + 520, BigInt(0x40_0000 + 120 + 536), true);
  for (const [index, [instruction, jumpFalse, value]] of [
    [0x20, 0, 0], [0x15, 1, 39], [0x06, 0, 0x0005_0011], [0x06, 0, 0x7fff_0000],
  ].entries()) {
    if (instruction === undefined || jumpFalse === undefined || value === undefined) throw new Error("invalid BPF fixture");
    const offset = 120 + 536 + index * 8;
    data.setUint16(offset, instruction, true); data.setUint8(offset + 3, jumpFalse); data.setUint32(offset + 4, value, true);
  }
  return elf;
}

/** A guest signal handler updates its caller's stack, then uses the Linux rt_sigreturn ABI. */
export function signalledSyscallElf(): Uint8Array<ArrayBuffer> {
  const elf = traceRingElf(1);
  const code = [0x48, 0x83, 0xec, 64, 0x49, 0x89, 0xe6, 0x41, 0xc7, 6, 0, 0, 0, 0,
    0xb8, 0, 0, 0, 0, 0x48, 0x89, 0x44, 0x24, 16,
    0xb8, 0, 0, 0, 4, 0x48, 0x89, 0x44, 0x24, 24,
    0xb8, 0, 0, 0, 0, 0x48, 0x89, 0x44, 0x24, 32,
    0x31, 0xc0, 0x48, 0x89, 0x44, 0x24, 40,
    0xb8, 13, 0, 0, 0, 0xbf, 10, 0, 0, 0, 0x48, 0x8d, 0x74, 0x24, 16,
    0x31, 0xd2, 0x41, 0xba, 8, 0, 0, 0, 0x0f, 0x05];
  const failures: number[] = [];
  const failJump = (): void => { code.push(0x0f, 0x85, 0, 0, 0, 0); failures.push(code.length - 4); };
  code.push(0x85, 0xc0); failJump();
  code.push(0xb8, 39, 0, 0, 0, 0x0f, 0x05, 0x89, 0xc7, 0xbe, 10, 0, 0, 0,
    0xb8, 62, 0, 0, 0, 0x0f, 0x05, 0x41, 0x83, 0x3e, 1);
  failJump();
  code.push(0x31, 0xff, 0xb8, 231, 0, 0, 0, 0x0f, 0x05);
  const fail = code.length;
  code.push(0xbf, 99, 0, 0, 0, 0xb8, 231, 0, 0, 0, 0x0f, 0x05);
  const handler = code.length;
  code.push(0x41, 0xc7, 6, 1, 0, 0, 0, 0xc3);
  const restorer = code.length;
  code.push(0xb8, 15, 0, 0, 0, 0x0f, 0x05, 0x0f, 0x0b);
  const body = Uint8Array.from(code);
  const view = new DataView(body.buffer);
  view.setUint32(15, 0x40_0000 + 120 + handler, true);
  view.setUint32(35, 0x40_0000 + 120 + restorer, true);
  for (const offset of failures) view.setInt32(offset, fail - offset - 4, true);
  elf.set(body, 120);
  return elf;
}
