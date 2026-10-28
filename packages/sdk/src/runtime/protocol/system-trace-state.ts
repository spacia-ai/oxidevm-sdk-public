import { boolean, exactKeys, integer, record } from "../decode.js";
import { JIT_DISPATCH_TABLE_ENTRIES } from "../jit-cache.js";
import { decodeCpl, decodeMode } from "./core.js";
import { nonnegativeBigint } from "./decoders.js";
import type {
  SystemTraceCpu,
  SystemTraceJitContext,
  SystemTraceRegisters,
  SystemTraceSnapshot,
} from "./system.js";

export function decodeSystemTraceJitContext(
  value: unknown,
  label: string,
): SystemTraceJitContext {
  const context = record(value, label);
  exactKeys(context, [
    "cr3",
    "forceExit",
    "entryIndex",
    "readEpoch",
    "writeEpoch",
    "lastDispatchSlot",
    "dispatchEpoch",
    "pendingWrites",
  ]);
  return {
    cr3: nonnegativeBigint(context["cr3"], `${label} CR3`),
    forceExit: boolean(context["forceExit"], `${label} force-exit flag`),
    entryIndex: integer(context["entryIndex"], `${label} entry index`, 0),
    readEpoch: integer(
      context["readEpoch"],
      `${label} read-cache epoch`,
      0,
      0xffff_ffff,
    ),
    writeEpoch: nonnegativeBigint(
      context["writeEpoch"],
      `${label} write-cache epoch`,
    ),
    lastDispatchSlot: decodeOptionalDispatchSlot(
      context["lastDispatchSlot"],
    ),
    dispatchEpoch: nonnegativeBigint(
      context["dispatchEpoch"],
      `${label} dispatch epoch`,
    ),
    pendingWrites: nonnegativeBigint(
      context["pendingWrites"],
      `${label} pending writes`,
    ),
  };
}

export function decodeSystemTraceCpu(
  value: unknown,
  label: string,
  schemaVersion: SystemTraceSnapshot["schemaVersion"],
): SystemTraceCpu {
  const cpu = record(value, label);
  exactKeys(
    cpu,
    schemaVersion === 2
      ? ["rip", "rflags", "cr3", "cpl", "mode"]
      : ["rip", "rflags", "cr3", "cpl", "mode", "registers"],
  );
  return {
    rip: nonnegativeBigint(cpu["rip"], `${label} RIP`),
    rflags: nonnegativeBigint(cpu["rflags"], `${label} RFLAGS`),
    cr3: nonnegativeBigint(cpu["cr3"], `${label} CR3`),
    cpl: decodeCpl(cpu["cpl"]),
    mode: decodeMode(cpu["mode"]),
    registers:
      schemaVersion === 2
        ? null
        : decodeSystemTraceRegisters(cpu["registers"], label),
  };
}

function decodeSystemTraceRegisters(
  value: unknown,
  label: string,
): SystemTraceRegisters {
  const registers = record(value, `${label} registers`);
  const names = [
    "rax",
    "rcx",
    "rdx",
    "rbx",
    "rsp",
    "rbp",
    "rsi",
    "rdi",
    "r8",
    "r9",
    "r10",
    "r11",
    "r12",
    "r13",
    "r14",
    "r15",
  ] as const;
  exactKeys(registers, names);
  return {
    rax: nonnegativeBigint(registers["rax"], `${label} RAX`),
    rcx: nonnegativeBigint(registers["rcx"], `${label} RCX`),
    rdx: nonnegativeBigint(registers["rdx"], `${label} RDX`),
    rbx: nonnegativeBigint(registers["rbx"], `${label} RBX`),
    rsp: nonnegativeBigint(registers["rsp"], `${label} RSP`),
    rbp: nonnegativeBigint(registers["rbp"], `${label} RBP`),
    rsi: nonnegativeBigint(registers["rsi"], `${label} RSI`),
    rdi: nonnegativeBigint(registers["rdi"], `${label} RDI`),
    r8: nonnegativeBigint(registers["r8"], `${label} R8`),
    r9: nonnegativeBigint(registers["r9"], `${label} R9`),
    r10: nonnegativeBigint(registers["r10"], `${label} R10`),
    r11: nonnegativeBigint(registers["r11"], `${label} R11`),
    r12: nonnegativeBigint(registers["r12"], `${label} R12`),
    r13: nonnegativeBigint(registers["r13"], `${label} R13`),
    r14: nonnegativeBigint(registers["r14"], `${label} R14`),
    r15: nonnegativeBigint(registers["r15"], `${label} R15`),
  };
}

function decodeOptionalDispatchSlot(value: unknown): number | null {
  return value === null
    ? null
    : integer(
        value,
        "JIT trace final dispatch slot",
        0,
        JIT_DISPATCH_TABLE_ENTRIES - 1,
      );
}
