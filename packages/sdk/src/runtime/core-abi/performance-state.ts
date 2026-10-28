import { type BinaryCursor, fault } from "./cursor.ts";

export interface CorePerformanceState {
  readonly fixedCounter0: bigint;
  readonly fixedCounterControl: bigint;
  readonly perfGlobalControl: bigint;
  readonly perfGlobalStatus: bigint;
  readonly perfOverflowControl: bigint;
  readonly debugControl: bigint;
  readonly pmiPending: boolean;
}

const STATUS_MASK = (1n << 32n) | (1n << 63n);

export function decodePerformanceState(cursor: BinaryCursor, version: number, available: boolean): CorePerformanceState {
  const fixedCounter0 = version >= 6 ? cursor.u64() : 0n;
  const fixedCounterControl = version >= 6 ? cursor.u64() : 0n;
  const perfGlobalControl = version >= 6 ? cursor.u64() : 0n;
  const perfGlobalStatus = version >= 6 ? cursor.u64() : 0n;
  const perfOverflowControl = version >= 6 ? cursor.u64() : 0n;
  const debugControl = version >= 6 ? cursor.u64() : 0n;
  const pending = version >= 6 ? cursor.u8() : 0;
  if (version >= 6) cursor.zero(7, "PMU reserved field");
  if (fixedCounter0 > 0xffff_ffff_ffffn || (fixedCounterControl & ~0xbn) !== 0n
    || (perfGlobalControl & ~(1n << 32n)) !== 0n || (perfGlobalStatus & ~STATUS_MASK) !== 0n
    || (perfOverflowControl & ~STATUS_MASK) !== 0n || (debugControl & ~(1n << 12n)) !== 0n || pending > 1
    || (!available && (fixedCounter0 | fixedCounterControl | perfGlobalControl | perfGlobalStatus
      | perfOverflowControl | debugControl | BigInt(pending)) !== 0n)) {
    throw fault("CPU snapshot has invalid PMU state");
  }
  return { fixedCounter0, fixedCounterControl, perfGlobalControl, perfGlobalStatus,
    perfOverflowControl, debugControl, pmiPending: pending === 1 };
}
