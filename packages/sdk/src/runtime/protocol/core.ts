import { bigint, exactKeys, integer, record, string } from "../decode.js";
import { CORE_API_VERSION } from "../core-abi.js";
import { VMError } from "../errors.js";

export type CoreMode = "real" | "protected" | "compatibility" | "long";
export type CoreExceptionClass = "fault" | "trap" | "abort" | "interrupt";

export interface CoreCpuState {
  readonly rax: bigint;
  readonly rcx: bigint;
  readonly rdx: bigint;
  readonly rbx: bigint;
  readonly rsp: bigint;
  readonly rbp: bigint;
  readonly rsi: bigint;
  readonly rdi: bigint;
  readonly r8: bigint;
  readonly r9: bigint;
  readonly r10: bigint;
  readonly r11: bigint;
  readonly r12: bigint;
  readonly r13: bigint;
  readonly r14: bigint;
  readonly r15: bigint;
  readonly rip: bigint;
  readonly rflags: bigint;
  readonly mode: CoreMode;
  readonly cpl: 0 | 1 | 2 | 3;
}

export interface CoreException {
  readonly vector: {
    readonly name: string;
    readonly number: number;
  };
  readonly class: CoreExceptionClass;
  readonly errorCode?: number;
  readonly faultAddress?: bigint;
  readonly instructionRip: bigint;
}

export type CoreProbeExit =
  | { readonly kind: "halted"; readonly steps: bigint }
  | { readonly kind: "step-limit"; readonly steps: bigint }
  | {
      readonly kind: "exception";
      readonly steps: bigint;
      readonly exception: CoreException;
    }
  | {
      readonly kind: "reset";
      readonly steps: bigint;
      readonly reason: "triple-fault" | "external-reset";
    };

export interface CoreProbeResult {
  readonly apiVersion: typeof CORE_API_VERSION;
  readonly exit: CoreProbeExit;
  readonly state: CoreCpuState;
}


export function decodeCoreProbeResult(value: unknown): CoreProbeResult {
  const result = record(value, "core probe result");
  exactKeys(result, ["apiVersion", "exit", "state"]);
  if (integer(result["apiVersion"], "apiVersion", CORE_API_VERSION, CORE_API_VERSION) !== CORE_API_VERSION) {
    throw new VMError("PROTOCOL_ERROR", "unsupported core API version");
  }
  return {
    apiVersion: CORE_API_VERSION,
    exit: decodeCoreExit(result["exit"]),
    state: decodeCoreState(result["state"]),
  };
}

export function decodeCoreState(value: unknown): CoreCpuState {
  const state = record(value, "core CPU state");
  exactKeys(state, [
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
    "rip",
    "rflags",
    "mode",
    "cpl",
  ]);
  return {
    rax: bigint(state["rax"], "RAX"),
    rcx: bigint(state["rcx"], "RCX"),
    rdx: bigint(state["rdx"], "RDX"),
    rbx: bigint(state["rbx"], "RBX"),
    rsp: bigint(state["rsp"], "RSP"),
    rbp: bigint(state["rbp"], "RBP"),
    rsi: bigint(state["rsi"], "RSI"),
    rdi: bigint(state["rdi"], "RDI"),
    r8: bigint(state["r8"], "R8"),
    r9: bigint(state["r9"], "R9"),
    r10: bigint(state["r10"], "R10"),
    r11: bigint(state["r11"], "R11"),
    r12: bigint(state["r12"], "R12"),
    r13: bigint(state["r13"], "R13"),
    r14: bigint(state["r14"], "R14"),
    r15: bigint(state["r15"], "R15"),
    rip: bigint(state["rip"], "RIP"),
    rflags: bigint(state["rflags"], "RFLAGS"),
    mode: decodeMode(state["mode"]),
    cpl: decodeCpl(state["cpl"]),
  };
}

export function decodeCoreExit(value: unknown): CoreProbeExit {
  const exit = record(value, "core exit");
  const kind = string(exit["kind"], "core exit kind");
  switch (kind) {
    case "halted":
    case "step-limit":
      exactKeys(exit, ["kind", "steps"]);
      return { kind, steps: bigint(exit["steps"], "exit steps") };
    case "exception":
      exactKeys(exit, ["kind", "steps", "exception"]);
      return {
        kind,
        steps: bigint(exit["steps"], "exit steps"),
        exception: decodeCoreException(exit["exception"]),
      };
    case "reset": {
      exactKeys(exit, ["kind", "steps", "reason"]);
      const reason = string(exit["reason"], "reset reason");
      if (reason !== "triple-fault" && reason !== "external-reset") {
        throw new VMError("PROTOCOL_ERROR", "reset reason is invalid");
      }
      return {
        kind,
        steps: bigint(exit["steps"], "exit steps"),
        reason,
      };
    }
    default:
      throw new VMError("PROTOCOL_ERROR", `unknown core exit ${kind}`);
  }
}

export function decodeCoreException(value: unknown): CoreException {
  const exception = record(value, "core exception");
  exactKeys(
    exception,
    ["vector", "class", "instructionRip"],
    ["errorCode", "faultAddress"],
  );
  const vector = record(exception["vector"], "exception vector");
  exactKeys(vector, ["name", "number"]);
  const errorCode =
    exception["errorCode"] === undefined
      ? undefined
      : integer(exception["errorCode"], "exception error code", 0, 0xffff_ffff);
  const faultAddress =
    exception["faultAddress"] === undefined
      ? undefined
      : bigint(exception["faultAddress"], "exception fault address");
  return {
    vector: {
      name: string(vector["name"], "exception vector name"),
      number: integer(vector["number"], "exception vector number", 0, 255),
    },
    class: decodeExceptionClass(exception["class"]),
    instructionRip: bigint(exception["instructionRip"], "instruction RIP"),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(faultAddress === undefined ? {} : { faultAddress }),
  };
}

export function decodeMode(value: unknown): CoreMode {
  const mode = string(value, "CPU mode");
  switch (mode) {
    case "real":
    case "protected":
    case "compatibility":
    case "long":
      return mode;
    default:
      throw new VMError("PROTOCOL_ERROR", `unknown CPU mode ${mode}`);
  }
}

export function decodeCpl(value: unknown): 0 | 1 | 2 | 3 {
  const cpl = integer(value, "CPL", 0, 3);
  switch (cpl) {
    case 0:
    case 1:
    case 2:
    case 3:
      return cpl;
    default:
      throw new VMError("PROTOCOL_ERROR", "CPL is invalid");
  }
}

function decodeExceptionClass(value: unknown): CoreExceptionClass {
  const exceptionClass = string(value, "exception class");
  switch (exceptionClass) {
    case "fault":
    case "trap":
    case "abort":
    case "interrupt":
      return exceptionClass;
    default:
      throw new VMError(
        "PROTOCOL_ERROR",
        `unknown exception class ${exceptionClass}`,
      );
  }
}
