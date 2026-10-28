import { VMError } from "./errors.ts";

interface WorkerIdleIdentity {
  readonly poolId: bigint;
  readonly allocationId: bigint;
  readonly allocationCgroup: bigint;
  readonly cpuCgroup: bigint;
  readonly creatorTid: number;
  readonly class: "bounded" | "unbounded";
  readonly classWorkers: number;
  readonly guestTicks: bigint;
  readonly kernelUnits: 1;
}

export type UserspaceWorkerIdleTrace = WorkerIdleIdentity & (
  | { readonly reason: "idle-started"; readonly cpuAllowed: boolean; readonly nextDeadline: bigint; readonly deadline?: never }
  | { readonly reason: "last-worker"; readonly cpuAllowed: true; readonly classWorkers: 1; readonly deadline: bigint; readonly nextDeadline: bigint }
  | { readonly reason: "excess-worker"; readonly cpuAllowed: true; readonly deadline: bigint; readonly nextDeadline?: never }
  | { readonly reason: "affinity-excluded"; readonly cpuAllowed: false; readonly deadline: bigint; readonly nextDeadline?: never }
);

/** Decode only the dedicated v31 idle record; no guest syscall or request is synthesized. */
export function decodeWorkerIdleTrace(
  bytes: Uint8Array, view: DataView, offset: number, version: number,
): UserspaceWorkerIdleTrace {
  const reason = view.getUint8(offset + 192), workerClass = view.getUint8(offset + 193);
  const allowed = view.getUint8(offset + 194), flags = view.getUint8(offset + 195);
  const classWorkers = view.getUint32(offset + 196, true);
  const poolId = view.getBigUint64(offset + 200, true), guestTicks = view.getBigUint64(offset + 208, true);
  const creatorTid = view.getUint32(offset + 216, true);
  const kernelUnits = view.getUint32(offset + 220, true);
  const deadline = view.getBigUint64(offset + 224, true), nextDeadline = view.getBigUint64(offset + 232, true);
  const allocationId = view.getBigUint64(offset + 240, true), allocationCgroup = view.getBigUint64(offset + 248, true);
  const cpuCgroup = view.getBigUint64(offset + 256, true);
  const monotonic = guestTicks * 25n / 64n;
  if (version < 31 || reason < 1 || reason > 4 || workerClass > 1 || allowed > 1
    || flags !== (reason === 1 ? 2 : reason === 2 ? 3 : 1)
    || classWorkers < 1 || classWorkers > 4096 || poolId === 0n || guestTicks === 0n
    || allocationId === 0n || allocationId === poolId || allocationCgroup === 0n || cpuCgroup === 0n
    || creatorTid === 0 || creatorTid === view.getUint32(offset + 28, true) || kernelUnits !== 1
    || reason === 1 && deadline !== 0n || reason !== 1 && deadline > monotonic
    || reason < 3 && nextDeadline < monotonic || reason >= 3 && nextDeadline !== 0n
    || reason === 2 && (allowed !== 1 || classWorkers !== 1)
    || reason === 3 && (allowed !== 1 || classWorkers < 2) || reason === 4 && allowed !== 0
    || view.getBigUint64(offset + 56, true) !== 0xffff_ffff_ffff_ffffn
    || bytes.subarray(offset + 40, offset + 56).some(byte => byte !== 0)
    || bytes.subarray(offset + 64, offset + 123).some(byte => byte !== 0)
    || bytes.subarray(offset + 128, offset + 192).some(byte => byte !== 0)
    || bytes.subarray(offset + 264, offset + 832).some(byte => byte !== 0)) {
    throw new VMError("PROTOCOL_ERROR", "Userspace worker idle trace is malformed");
  }
  const identity: WorkerIdleIdentity = {
    poolId, allocationId, allocationCgroup, cpuCgroup, creatorTid, class: workerClass === 0 ? "bounded" : "unbounded",
    classWorkers, guestTicks, kernelUnits: 1,
  };
  if (reason === 1) return { ...identity, reason: "idle-started", cpuAllowed: allowed === 1, nextDeadline };
  if (reason === 2) return { ...identity, reason: "last-worker", cpuAllowed: true, classWorkers: 1, deadline, nextDeadline };
  if (reason === 3) return { ...identity, reason: "excess-worker", cpuAllowed: true, deadline };
  return { ...identity, reason: "affinity-excluded", cpuAllowed: false, deadline };
}
