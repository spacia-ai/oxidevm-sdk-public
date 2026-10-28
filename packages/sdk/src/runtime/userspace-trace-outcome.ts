import { VMError } from "./errors.ts";

export type UserspaceExecFailureStage =
  | "main-mapping" | "interpreter-mapping" | "stack-mapping" | "initial-stack"
  | "address-space-limit" | "cpu-initialization" | "close-descriptors" | "command-launch" | "io-cleanup";

export type UserspaceSyscallTraceOutcome =
  | { readonly kind: "result"; readonly value: bigint }
  | { readonly kind: "resumed" | "blocked" | "released" }
  | { readonly kind: "exit"; readonly status: number }
  | { readonly kind: "exec-failure"; readonly stage: UserspaceExecFailureStage; readonly error: number;
    readonly signal: 11; readonly replacementAddressSpace: bigint; readonly guestTicks: bigint };

export function decodeSyscallTraceOutcome(bytes: Uint8Array, view: DataView, offset: number, version: number): UserspaceSyscallTraceOutcome {
  const value = view.getBigInt64(offset + 112, true);
  switch (view.getUint8(offset + 120)) {
    case 0: return { kind: "result", value };
    case 1: if (value === 0n) return { kind: "resumed" }; break;
    case 2: if (value === 0n) return { kind: "blocked" }; break;
    case 3: if (value >= 0n && value <= 255n) return { kind: "exit", status: Number(value) }; break;
    case 4: if (version >= 21 && value === 0n) return { kind: "released" }; break;
    case 5: if (version >= 24 && value === 0n) return decodeExecFailure(bytes, view, offset); break;
  }
  throw malformed();
}

function decodeExecFailure(bytes: Uint8Array, view: DataView, offset: number): Extract<UserspaceSyscallTraceOutcome, { readonly kind: "exec-failure" }> {
  const stage = decodeStage(view.getUint8(offset + 192));
  const error = view.getInt32(offset + 196, true);
  const replacementAddressSpace = view.getBigUint64(offset + 200, true);
  const guestTicks = view.getBigUint64(offset + 208, true);
  const number = view.getBigUint64(offset + 56, true);
  if ((number !== 59n && number !== 322n) || view.getUint8(offset + 122) !== 0 || view.getUint8(offset + 123) !== 0
    || view.getUint8(offset + 193) !== 11 || view.getUint16(offset + 194, true) !== 0
    || error <= 0 || error > 4095 || stage === "address-space-limit" && error !== 12
    || replacementAddressSpace === 0n || replacementAddressSpace === view.getBigUint64(offset + 32, true)
    || guestTicks === 0n || bytes.subarray(offset + 128, offset + 152).some(byte => byte !== 0)
    || bytes.subarray(offset + 216, offset + 272).some(byte => byte !== 0)) throw malformed();
  return { kind: "exec-failure", stage, error, signal: 11, replacementAddressSpace, guestTicks };
}

function decodeStage(tag: number): UserspaceExecFailureStage {
  switch (tag) {
    case 1: return "main-mapping";
    case 2: return "interpreter-mapping";
    case 3: return "stack-mapping";
    case 4: return "initial-stack";
    case 5: return "address-space-limit";
    case 6: return "cpu-initialization";
    case 7: return "close-descriptors";
    case 8: return "command-launch";
    case 9: return "io-cleanup";
    default: throw malformed();
  }
}

function malformed(): VMError {
  return new VMError("PROTOCOL_ERROR", "Userspace syscall trace is malformed");
}
