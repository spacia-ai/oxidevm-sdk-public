import { VMError } from "./errors.ts";
import { decodeSeccompTrace } from "./userspace-seccomp-trace.ts";

interface Identity {
  readonly ring: bigint;
  readonly openFile: bigint;
  readonly pool: bigint;
  readonly cpuCgroup: bigint;
  readonly admittedGuestTicks: bigint;
  readonly guestTicks: bigint;
  readonly kernelUnits: 1;
  readonly previous: readonly [number, number];
  readonly limits: readonly [number, number];
  readonly requested: readonly [number, number];
}

export type UserspaceWorkerLimitTrace = Identity & (
  | { readonly action: "applied" | "retiring"; readonly poolCgroup: bigint }
  | { readonly action: "departed"; readonly poolCgroup?: never }
);

/** Trace51 keeps the common seccomp area at 272..288 and pool limits at 288..312. */
export function decodeWorkerLimitTrace(bytes: Uint8Array, view: DataView, at: number, version: number): UserspaceWorkerLimitTrace {
  const ring = view.getBigUint64(at + 192, true), openFile = view.getBigUint64(at + 200, true);
  const guestTicks = view.getBigUint64(at + 208, true), cpuCgroup = view.getBigUint64(at + 216, true);
  const pool = view.getBigUint64(at + 224, true), poolCgroup = view.getBigUint64(at + 232, true);
  const admittedGuestTicks = view.getBigUint64(at + 240, true), kernelUnits = view.getBigUint64(at + 248, true);
  const actionCode = view.getUint8(at + 256);
  const previous: readonly [number, number] = [view.getUint32(at + 288, true), view.getUint32(at + 292, true)];
  const limits: readonly [number, number] = [view.getUint32(at + 296, true), view.getUint32(at + 300, true)];
  const requested: readonly [number, number] = [view.getUint32(at + 304, true), view.getUint32(at + 308, true)];
  const operation = view.getBigUint64(at + 72, true), fd = view.getBigUint64(at + 64, true) & 0xffff_ffffn;
  const span = BigInt.asUintN(64, view.getBigUint64(at + 48, true) - view.getBigUint64(at + 40, true));
  const decision = decodeSeccompTrace(bytes, view, at + 272);
  if (version < 51 || [ring, openFile, pool, cpuCgroup].some(value => value === 0n || value === 0xffff_ffff_ffff_ffffn)
    || (operation & 0x7fff_ffffn) !== 19n || view.getBigUint64(at + 56, true) !== 427n
    || view.getBigUint64(at + 80, true) === 0n || (view.getBigUint64(at + 88, true) & 0xffff_ffffn) !== 2n
    || ((operation & 0x8000_0000n) !== 0n ? fd >= 16n : fd >= 0x8000_0000n)
    || kernelUnits !== 1n || guestTicks <= admittedGuestTicks || span < 1n || span > 15n
    || view.getUint8(at + 120) !== 0 || view.getBigInt64(at + 112, true) !== 0n || view.getUint8(at + 122) !== 0
    || bytes.subarray(at + 128, at + 144).some(byte => byte !== 0)
    || bytes.subarray(at + 257, at + 272).some(byte => byte !== 0)
    || bytes.subarray(at + 312, at + 992).some(byte => byte !== 0)
    || [...previous, ...limits, ...requested].some(value => value > 0x7fff_ffff)) throw malformed();
  if (decision !== undefined && (decision.kind === "strict" || (decision.value >>> 16) !== 0x7fff && (decision.value >>> 16) !== 0x7ffc)) throw malformed();
  const identity: Identity = { ring, openFile, pool, cpuCgroup, admittedGuestTicks, guestTicks, kernelUnits: 1, previous, limits, requested };
  if (actionCode === 3) {
    if (poolCgroup !== 0n || [...previous, ...limits].some(value => value !== 0)) throw malformed();
    return { ...identity, action: "departed" };
  }
  if (poolCgroup === 0n || poolCgroup === 0xffff_ffff_ffff_ffffn || actionCode !== 1 && actionCode !== 2
    || limits.some((value, index) => value !== (actionCode === 2 || requested[index] === 0 ? previous[index] : requested[index]))) throw malformed();
  return { ...identity, action: actionCode === 1 ? "applied" : "retiring", poolCgroup };
}

function malformed(): VMError { return new VMError("PROTOCOL_ERROR", "Userspace worker-limit trace is malformed"); }
