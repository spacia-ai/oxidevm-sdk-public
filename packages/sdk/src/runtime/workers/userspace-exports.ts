import { VMError } from "../errors.js";

/** A nonzero status from a Userspace export is a failed guest-runtime operation. */
export function assertUserspaceStatus(status: number, operation: string): void {
  if (status !== 0) throw new VMError("GUEST_CRASH", `Userspace Wasm ${operation} failed with status ${status}`);
}

/**
 * Calls a Userspace Wasm export that returns `u32`. Wasm hands an i32 result to JavaScript as
 * a signed number, so a pointer above 2 GiB or a sentinel such as `u32::MAX` arrives negative;
 * this returns the unsigned value the export produced.
 */
export function callUserspaceU32(
  instance: Pick<WebAssembly.Instance, "exports">,
  name: string,
  ...arguments_: readonly (number | bigint)[]
): number {
  const operation = instance.exports[name];
  if (typeof operation !== "function") {
    throw new VMError("CORE_LOAD_FAILED", `Userspace export ${name} is missing`);
  }
  const result: unknown = Reflect.apply(operation, undefined, arguments_);
  if (
    typeof result !== "number"
    || !Number.isInteger(result)
    || result < -0x8000_0000
    || result > 0xffff_ffff
  ) {
    throw new VMError("PROTOCOL_ERROR", `Userspace export ${name} returned an invalid value`);
  }
  return result >>> 0;
}

/**
 * Calls a Userspace Wasm export that returns `u64`. Wasm hands an i64 result to JavaScript as
 * a signed bigint, so `u64::MAX` arrives as `-1n`; this returns the unsigned value.
 */
export function callUserspaceU64(
  instance: Pick<WebAssembly.Instance, "exports">,
  name: string,
  ...arguments_: readonly (number | bigint)[]
): bigint {
  const operation = instance.exports[name];
  if (typeof operation !== "function") {
    throw new VMError("CORE_LOAD_FAILED", `Userspace export ${name} is missing`);
  }
  const result: unknown = Reflect.apply(operation, undefined, arguments_);
  if (typeof result !== "bigint") {
    throw new VMError("CORE_LOAD_FAILED", `Userspace export ${name} result is invalid`);
  }
  return BigInt.asUintN(64, result);
}

/** ABI37 distinguishes a rejected operation from a restore whose old heap was retired. */
export function assertUserspaceCheckpointStatus(status: number, operation: string): void {
  switch (status) {
    case 0: return;
    case 1: throw new VMError("PROTOCOL_ERROR", `Native checkpoint ${operation} was rejected`, { status });
    case 2: throw new VMError("STORAGE_ERROR", `Native checkpoint ${operation} could not complete`, { status });
    case 3: throw new VMError("QUOTA_EXCEEDED", `Native checkpoint ${operation} exceeded its quota`, { status });
    case 4: throw new VMError("STORAGE_ERROR", "Checkpoint recovery is required", { reason: "checkpoint-recovery-required", recoveryRequired: true, status });
    default: throw new VMError("PROTOCOL_ERROR", "Native checkpoint returned an unknown status", { status });
  }
}
