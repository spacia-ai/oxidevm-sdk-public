import { decodeBufferRetirement, type BufferRetirement } from "./userspace-buffer-retirement-trace.ts";
import { decodeBufferTagPublication, type UserspaceIoUringTagPublication } from "./userspace-buffer-tag-trace.ts";
export type { UserspaceIoUringTagPublication } from "./userspace-buffer-tag-trace.ts";
import { VMError } from "./errors.ts";
import { decodeWorkerLimitTrace, type UserspaceWorkerLimitTrace } from "./userspace-worker-limit-trace.ts";
export type { UserspaceWorkerLimitTrace } from "./userspace-worker-limit-trace.ts";
import { decodeTaskFilterFinalizationTrace, type UserspaceTaskFilterFinalizationTrace } from "./userspace-task-filter-finalization-trace.ts";
export type { UserspaceTaskFilterFinalizationTrace } from "./userspace-task-filter-finalization-trace.ts";
import { decodeCqWriterWait, type CqWriterWait } from "./userspace-io-uring-enter-trace.ts";
import { decodeBufferProgress, type BufferProgress } from "./userspace-buffer-progress.ts";
import { decodeIoUringCancellationTrace, type UserspaceIoUringCancellationTrace } from "./userspace-io-uring-cancellation-trace.ts";
import { decodeIoUringExecutor, type IoUringExecutor, type IoUringExitedIssuerExecutor } from "./userspace-io-uring-executor.ts";
import { sameIoUringCallSource } from "./userspace-io-uring-source.ts";
import { decodeWorkerIdleTrace, type UserspaceWorkerIdleTrace } from "./userspace-worker-idle-trace.ts";
import { validateIoUringIssuerTrailer } from "./userspace-io-uring-issuer.ts";
import { decodeRingFinalizationTrace, type UserspaceRingFinalizationTrace } from "./userspace-ring-finalization-trace.ts";
import { decodePoolFinalizationTrace, type UserspacePoolFinalizationTrace } from "./userspace-pool-finalization-trace.ts";
export type { UserspacePoolFinalizationTrace } from "./userspace-pool-finalization-trace.ts";
import { decodeInlineBufferTrace, type UserspaceInlineBufferTrace } from "./userspace-inline-buffer-trace.ts";
export type { UserspaceRingFinalizationTrace } from "./userspace-ring-finalization-trace.ts";

interface IoUringWorkIdentity {
  readonly ringClosing?: true;
  /** Trace40 retains the real account after its task has been reaped. */
  readonly cpuCgroupId?: bigint;
  readonly executor?: IoUringExecutor;
  readonly poolId: bigint;
  readonly sequence: bigint;
  readonly guestTicks: bigint;
  /** Present in trace v10; older captures did not record this identity. */
  readonly credentialId?: bigint;
  readonly creatorTid: number;
  readonly chainSlot: number;
  readonly sqSequence: number;
  readonly sqeIndex: number;
  readonly opcode: number;
}

/** One worker boundary, referring to the copied SQE and its original submitter. */
type IssuerExecutor = Extract<IoUringExecutor, { readonly kind: "ordinary-task-run" }>
  | IoUringExitedIssuerExecutor;

export type UserspaceIoUringWorkTrace = IoUringWorkIdentity & (
  | { readonly executor: IssuerExecutor; readonly completion: "notified"; readonly done: false;
      readonly wait?: never; readonly canceledBy?: never; readonly memoryAdvice?: never; readonly buffers?: never }
  | { readonly executor: Extract<IoUringExecutor, { readonly kind: "ordinary-task-run" }>;
      readonly completion: "worker-queued" | "worker-rejected"; readonly done: false;
      readonly wait?: never; readonly canceledBy?: never; readonly memoryAdvice?: never; readonly buffers?: never }
  | { readonly executor: IssuerExecutor;
      readonly completion: "retired"; readonly done: boolean; readonly wait?: never;
      readonly canceledBy?: UserspaceIoUringCancellationTrace; readonly memoryAdvice?: never; readonly buffers?: never }
  | { readonly completion: "retiring"; readonly done: boolean; readonly retirement: BufferRetirement; readonly wait?: never; readonly canceledBy?: UserspaceIoUringCancellationTrace; readonly memoryAdvice?: never; readonly buffers?: never }
  | { readonly completion: "released"; readonly done: true; readonly wait?: never; readonly canceledBy?: never; readonly memoryAdvice?: never; readonly buffers?: never }
  | ({ readonly completion: "executing"; readonly done: false; readonly wait?: never; readonly canceledBy?: never } & (
      | { readonly memoryAdvice: MemoryAdviceProgress; readonly buffers?: never }
      | { readonly buffers: Extract<BufferProgress, { readonly kind: "remove" }>; readonly memoryAdvice?: never }
    ))
  | { readonly completion: "waiting"; readonly done: false; readonly wait: ReadinessWait | CounterCapacityWait | DurabilityWait | CqWriterWait; readonly canceledBy?: never; readonly memoryAdvice?: never;
      readonly buffers?: Extract<BufferProgress, { readonly kind: "select" | "select-vector" }> }
  | { readonly completion: "task-run-reissue"; readonly done: false; readonly wait: TaskRunWait; readonly canceledBy?: never; readonly memoryAdvice?: never;
      readonly buffers?: Extract<BufferProgress, { readonly kind: "select" | "select-vector" }> }
  | ({ readonly completion: "task-run"; readonly done: false; readonly wait: TaskRunWait;
      readonly canceledBy?: UserspaceIoUringCancellationTrace } & (
      | { readonly memoryAdvice?: MemoryAdviceProgress; readonly buffers?: never }
      | { readonly buffers: BufferProgress; readonly memoryAdvice?: never }
    ))
  | ({ readonly completion: "skipped" | "pending" | "published"; readonly done: boolean; readonly wait?: never; readonly canceledBy?: UserspaceIoUringCancellationTrace } & (
      | { readonly memoryAdvice?: MemoryAdviceProgress; readonly buffers?: never }
      | { readonly buffers: BufferProgress; readonly memoryAdvice?: never }
    ))
);

interface MemoryAdviceProgress {
  readonly start: bigint;
  readonly end: bigint;
  readonly next: bigint;
  readonly advice: 22 | 23;
  readonly sawHole: boolean;
}

interface TaskRunWait {
  readonly kind: "task-run";
  readonly ringOpenFileId: bigint;
  readonly issuerTid: number;
}

interface ReadinessWait {
  readonly kind: "readiness";
  readonly openFileId: bigint;
  readonly events: 1 | 4;
  readonly wakeups: bigint;
}

interface CounterCapacityWait {
  readonly kind: "eventfd-capacity";
  readonly openFileId: bigint;
  readonly events: 4;
  readonly wakeups: bigint;
  readonly balance: bigint;
}

interface DurabilityWait {
  readonly kind: "durability";
  readonly generation: bigint;
  readonly id: bigint;
  readonly root?: bigint;
  readonly workspace?: bigint;
}

export type UserspaceTraceOperation =
  | { readonly kind: "io-uring-worker-limits"; readonly operation: UserspaceWorkerLimitTrace }
  | { readonly kind: "io-uring-task-filter-finalization"; readonly finalization: UserspaceTaskFilterFinalizationTrace }
  | { readonly kind: "io-uring-inline-buffers"; readonly operation: UserspaceInlineBufferTrace }
  | { readonly kind: "io-uring-finalization"; readonly finalization: UserspaceRingFinalizationTrace }
  | { readonly kind: "io-uring-pool-finalization"; readonly finalization: UserspacePoolFinalizationTrace }
  | { readonly kind: "syscall" }
  | { readonly kind: "io-uring-worker-idle"; readonly worker: UserspaceWorkerIdleTrace }
  | { readonly kind: "io-uring-buffer-tag"; readonly tag: UserspaceIoUringTagPublication }
  | { readonly kind: "io-uring-work"; readonly work: UserspaceIoUringWorkTrace };

export function decodeUserspaceTraceOperation(
  bytes: Uint8Array, view: DataView, offset: number, version: number,
): UserspaceTraceOperation {
  if (view.getUint8(offset + 123) === 8) return { kind: "io-uring-worker-limits", operation: decodeWorkerLimitTrace(bytes, view, offset, version) };
  if (view.getUint8(offset + 123) === 7) return { kind: "io-uring-task-filter-finalization", finalization: decodeTaskFilterFinalizationTrace(bytes, view, offset, version) };
  if (view.getUint8(offset + 123) === 6) return { kind: "io-uring-pool-finalization", finalization: decodePoolFinalizationTrace(bytes, view, offset, version) };
  if (view.getUint8(offset + 123) === 5) return { kind: "io-uring-inline-buffers", operation: decodeInlineBufferTrace(bytes, view, offset, version) };
  if (version >= 43 && (view.getUint8(offset + 123) !== 1 || view.getUint8(offset + 584) !== 1)
    && bytes.subarray(offset + 960, offset + 992).some(byte => byte !== 0)) throw malformed();
  if (view.getUint8(offset + 123) === 4) return { kind: "io-uring-finalization", finalization: decodeRingFinalizationTrace(bytes, view, offset, version) };
  validateIoUringIssuerTrailer(bytes, view, offset, version);
  const tag = view.getUint8(offset + 123);
  if (version >= 35 && (tag !== 1 || view.getUint8(offset + 512) !== 4)
    && bytes.subarray(offset + 832, offset + 928).some(byte => byte !== 0)) throw malformed();
  if (tag === 3) return { kind: "io-uring-worker-idle", worker: decodeWorkerIdleTrace(bytes, view, offset, version) };
  const retirement = version >= 27 ? decodeBufferRetirement(bytes, view, offset, version) : undefined;
  if (tag === 2 && version >= 26) return { kind: "io-uring-buffer-tag", tag: decodeBufferTagPublication(bytes, view, offset) };
  if (version >= 26 && bytes.subarray(offset + 752, offset + 784).some(byte => byte !== 0)) throw new VMError("PROTOCOL_ERROR", "Userspace syscall trace is malformed");
  const executor = decodeIoUringExecutor(bytes, view, offset, version);
  const cpuCgroupId = version >= 40 ? view.getBigUint64(offset + 952, true) : 0n;
  const exitedCpu = executor?.kind === "exited" || executor?.kind === "exited-signal" || executor?.kind === "exited-seccomp";
  const ringClosing = version >= 40 && view.getUint8(offset + 938) === 1;
  if (ringClosing && !exitedCpu) throw malformed();
  if (version >= 40 && (exitedCpu ? cpuCgroupId === 0n || cpuCgroupId === 0xffff_ffff_ffff_ffffn : cpuCgroupId !== 0n)) throw malformed();
  const registrationTaskRun = executor?.kind === "task-run" && executor.source.number === 427n;
  const canceledBy = version >= 12 ? decodeIoUringCancellationTrace(bytes, view, offset, version) : undefined;
  if (executor?.kind === "task-run" && executor.source.number === 427n
    && (canceledBy?.kind !== "registration" || !sameIoUringCallSource(executor.source, canceledBy.source))) throw malformed();
  const durability = version >= 13 ? decodeControlWait(bytes, view, offset, version) : undefined;
  const memoryAdvice = version >= 14 ? decodeMemoryAdvice(bytes, view, offset) : undefined;
  const buffers = version >= 15 ? decodeBufferProgress(bytes, view, offset, version) : undefined;
  if (tag === 0) {
    if (executor !== undefined && executor.kind !== "worker" || buffers !== undefined || memoryAdvice !== undefined || durability !== undefined || canceledBy !== undefined || version >= 11 && bytes.subarray(offset + 248, offset + 272).some((byte) => byte !== 0)) {
      throw new VMError("PROTOCOL_ERROR", "Userspace syscall trace is malformed");
    }
    return { kind: "syscall" };
  }
  // The snapshot reader has already admitted a supported wire version and record size.
  if (tag !== 1 || version < 9) {
    throw new VMError("PROTOCOL_ERROR", "Userspace syscall trace is malformed");
  }
  const poolId = view.getBigUint64(offset + 192, true);
  const sequence = view.getBigUint64(offset + 200, true);
  const guestTicks = view.getBigUint64(offset + 208, true);
  const creatorTid = view.getUint32(offset + 216, true);
  const chainSlot = view.getUint32(offset + 220, true);
  const sqeIndex = view.getUint32(offset + 228, true);
  const done = view.getUint8(offset + 233), completion = view.getUint8(offset + 234);
  const credentialId = version >= 10 ? view.getBigUint64(offset + 240, true) : undefined;
  const waiting = version >= 11 && completion === 3;
  const executing = version >= 14 && completion === 4;
  const deferred = version >= 18 && completion === 5;
  const reissue = version >= 19 && completion === 6;
  const released = version >= 21 && completion === 7;
  const retiring = version >= 27 && completion === 8;
  const ordinary = executor?.kind === "ordinary-task-run";
  const exitedIssuer = executor !== undefined && "issuer" in executor ? executor : undefined;
  const issuerExecutor = ordinary ? executor : exitedIssuer;
  const issuer = ordinary ? executor : exitedIssuer?.issuer;
  const retired = version >= 38 && completion === 12;
  const notification = version >= 38 && completion === 9;
  const workerQueued = version >= 38 && completion === 10;
  const workerRejected = version >= 38 && completion === 11;
  const administrative = retired || notification || workerQueued || workerRejected;
  if (issuer !== undefined) {
    const accepted = issuer.phase === "issue" ? [3, 4, 5]
      : issuer.phase === "admit-worker" ? [10, 11] : issuer.phase === "publish" ? [0, 1, 2, 3]
        : issuer.phase === "notify" ? [9] : [8, 12];
    if (!accepted.includes(completion) || issuer.phase !== "retire" && done !== 0) throw malformed();
  } else if (administrative) throw malformed();
  if (administrative && (buffers !== undefined || memoryAdvice !== undefined || durability !== undefined
    || !retired && canceledBy !== undefined || view.getUint8(offset + 120) !== 0
    || (workerRejected ? ![-11n, -12n].includes(view.getBigInt64(offset + 112, true))
      : view.getBigInt64(offset + 112, true) !== 0n))) throw malformed();
  if (retiring !== (retirement !== undefined) || retiring && (buffers !== undefined || memoryAdvice !== undefined || durability !== undefined)) throw malformed();
  const taskWait = deferred || reissue;
  const exited = executor?.kind === "exited" || executor?.kind === "exited-signal" || executor?.kind === "exited-seccomp";
  if (retirement?.completion === "released" && (!exited || issuer !== undefined
    || canceledBy !== undefined || view.getBigInt64(offset + 112, true) !== 0n)) throw malformed();
  if (exited && exitedIssuer === undefined && !reissue && !released && !(retiring && version >= 28)
    && !(ringClosing && [0, 1, 2].includes(completion))) {
    throw new VMError("PROTOCOL_ERROR", "Userspace exited issuer trace is malformed");
  }
  if (released && (!exited || done !== 1 || view.getUint8(offset + 120) !== 4
    || view.getBigInt64(offset + 112, true) !== 0n || buffers !== undefined || memoryAdvice !== undefined
    || durability !== undefined || canceledBy !== undefined)) {
    throw new VMError("PROTOCOL_ERROR", "Userspace retained request release is malformed");
  }
  const wait = waiting ? durability ?? decodeIoWait(bytes, view, offset) : taskWait ? durability : undefined;
  const issuerReadinessWait = version >= 19 && waiting && (executor?.kind === "task-run" || ordinary || exitedIssuer !== undefined);
  if (exitedIssuer !== undefined && waiting && wait?.kind !== "cq-writer") throw malformed();
  const execIssuer = ordinary && version >= 39 && [59n, 322n].includes(executor.source.number)
    && ["publish", "notify", "retire"].includes(executor.phase);
  if (durability?.kind === "eventfd-capacity"
    && (!waiting || ![2, 5, 23].includes(view.getUint8(offset + 232)) || buffers !== undefined)) throw malformed();
  if ((executor?.kind === "exec" || executor?.kind === "worker-admission-failed")
    && (waiting || executing || taskWait || durability !== undefined)) {
    throw new VMError("PROTOCOL_ERROR", "Userspace exec cleanup trace is malformed");
  }
  if (executor?.kind === "worker-admission-failed" && view.getBigInt64(offset + 112, true) !== -125n) throw malformed();
  if (reissue && (view.getUint8(offset + 120) !== 2 || executor?.kind === "task-run"
    || memoryAdvice !== undefined || canceledBy !== undefined || ![1, 2, 4, 5, 22, 23].includes(view.getUint8(offset + 232))
    || buffers !== undefined && buffers.kind !== "select" && buffers.kind !== "select-vector")) {
    throw new VMError("PROTOCOL_ERROR", "Userspace readiness reissue trace is malformed");
  }
  if (poolId === 0n || sequence === 0n || guestTicks === 0n
    || credentialId === 0n || credentialId === 0xffff_ffff_ffff_ffffn
    || creatorTid === 0 || (ordinary ? !execIssuer && creatorTid !== view.getUint32(offset + 28, true)
      : executor?.kind === "task-run" || executor?.kind === "worker-admission-failed"
      ? creatorTid !== view.getUint32(offset + 28, true) || waiting && !issuerReadinessWait || executing || deferred && !registrationTaskRun
      : executor?.kind !== "exec" && !exited && creatorTid === view.getUint32(offset + 28, true))
    || chainSlot >= 32768 || sqeIndex >= 32768 || done > 1 || completion > (version >= 38 ? 12 : version >= 27 ? 8 : version >= 21 ? 7 : version >= 19 ? 6 : version >= 18 ? 5 : version >= 14 ? 4 : version >= 11 ? 3 : 2)
    || ((waiting || taskWait) && done !== 0)
    || (buffers !== undefined && (memoryAdvice !== undefined
      || (waiting || canceledBy !== undefined) && buffers.kind !== "select" && buffers.kind !== "select-vector"))
    || (wait?.kind === "cq-writer" && buffers !== undefined)
    || ((buffers?.kind === "select" || buffers?.kind === "select-vector") && waiting && (wait?.kind !== "readiness" || wait.events !== 1))
    || (executing && (done !== 0 || memoryAdvice === undefined && buffers?.kind !== "remove"
      || memoryAdvice !== undefined && (memoryAdvice.next <= memoryAdvice.start || memoryAdvice.next >= memoryAdvice.end)))
    || (memoryAdvice !== undefined && (waiting || view.getUint8(offset + 232) !== 25
      || (!executing && view.getBigInt64(offset + 112, true) === 0n && (memoryAdvice.next !== memoryAdvice.end || memoryAdvice.sawHole))))
    || (taskWait && (durability?.kind !== "task-run" || durability.issuerTid !== creatorTid
      || buffers !== undefined && buffers.ring !== durability.ringOpenFileId))
    || (waiting && durability?.kind === "task-run")
    || (issuerReadinessWait && wait?.kind !== "cq-writer" && (wait?.kind !== "readiness" && wait?.kind !== "eventfd-capacity"
      || ![1, 2, 4, 5, 22, 23].includes(view.getUint8(offset + 232))))
    || (durability !== undefined && ((!waiting && !taskWait)
      || durability.kind !== "eventfd-capacity" && bytes.subarray(offset + 248, offset + 272).some((byte) => byte !== 0)))
    || (canceledBy !== undefined && (waiting || executing || view.getUint8(offset + 120) !== 0
      || view.getBigInt64(offset + 112, true) !== (retired ? 0n : -125n) || canceledBy.source.guestTicks > guestTicks))
    || view.getUint8(offset + 122) !== 0
    || bytes.subarray(offset + 128, offset + 152).some((byte) => byte !== 0)
    || bytes.subarray(offset + 235, offset + (version >= 10 ? 240 : 272)).some((byte) => byte !== 0)
    || (version >= 10 && !waiting && bytes.subarray(offset + 248, offset + 272).some((byte) => byte !== 0))) {
    throw new VMError("PROTOCOL_ERROR", "Userspace syscall trace is malformed");
  }
  const identity = {
    ...(ringClosing ? { ringClosing: true as const } : {}),
    ...(cpuCgroupId === 0n ? {} : { cpuCgroupId }),
    ...(executor === undefined ? {} : { executor }),
    poolId, sequence, guestTicks, creatorTid, chainSlot,
    ...(credentialId === undefined ? {} : { credentialId }),
    sqSequence: view.getUint32(offset + 224, true), sqeIndex,
    opcode: view.getUint8(offset + 232),
  };
  if (retired && issuerExecutor !== undefined) return { kind: "io-uring-work", work: { ...identity, executor: issuerExecutor, completion: "retired",
      done: done === 1, ...(canceledBy === undefined ? {} : { canceledBy }) } };
  if (notification && issuerExecutor !== undefined) return { kind: "io-uring-work", work: {
    ...identity, executor: issuerExecutor, completion: "notified", done: false,
  } };
  if ((workerQueued || workerRejected) && ordinary) {
    return { kind: "io-uring-work", work: { ...identity, executor, done: false,
      completion: workerQueued ? "worker-queued" : "worker-rejected" } };
  }
  if (retiring && retirement !== undefined) return { kind: "io-uring-work", work: { ...identity, completion: "retiring", done: done === 1, retirement, ...(canceledBy === undefined ? {} : { canceledBy }) } };
  if (released) return { kind: "io-uring-work", work: { ...identity, completion: "released", done: true } };
  if (reissue && wait?.kind === "task-run") return { kind: "io-uring-work", work: {
    ...identity, completion: "task-run-reissue", done: false, wait,
    ...(buffers?.kind === "select" || buffers?.kind === "select-vector" ? { buffers } : {}),
  } };
  if (deferred && wait?.kind === "task-run" && buffers !== undefined) return { kind: "io-uring-work", work: {
    ...identity, completion: "task-run", done: false, wait, buffers,
    ...(canceledBy === undefined ? {} : { canceledBy }),
  } };
  if (deferred && wait?.kind === "task-run") return { kind: "io-uring-work", work: {
    ...identity, completion: "task-run", done: false, wait,
    ...(canceledBy === undefined ? {} : { canceledBy }),
    ...(memoryAdvice === undefined ? {} : { memoryAdvice }),
  } };
  if (wait !== undefined && wait.kind !== "task-run") return { kind: "io-uring-work", work: { ...identity, completion: "waiting", done: false, wait,
    ...(buffers?.kind === "select" || buffers?.kind === "select-vector" ? { buffers } : {}),
  } };
  if (executing && memoryAdvice !== undefined) return { kind: "io-uring-work", work: {
    ...identity, completion: "executing", done: false, memoryAdvice,
  } };
  if (executing && buffers?.kind === "remove") return { kind: "io-uring-work", work: {
    ...identity, completion: "executing", done: false, buffers,
  } };
  if (buffers !== undefined) return { kind: "io-uring-work", work: {
    ...identity, done: done === 1, buffers,
    ...(canceledBy === undefined ? {} : { canceledBy }),
    completion: completion === 0 ? "skipped" : completion === 1 ? "pending" : "published",
  } };
  return { kind: "io-uring-work", work: { ...identity, done: done === 1,
    ...(memoryAdvice === undefined ? {} : { memoryAdvice }),
    ...(canceledBy === undefined ? {} : { canceledBy }),
    completion: completion === 0 ? "skipped" : completion === 1 ? "pending" : "published",
  } };
}

function decodeMemoryAdvice(bytes: Uint8Array, view: DataView, offset: number): MemoryAdviceProgress | undefined {
  const tag = view.getUint8(offset + 552);
  if (tag === 0) {
    if (bytes.subarray(offset + 553, offset + 584).some(byte => byte !== 0)) throw malformed();
    return undefined;
  }
  const hole = view.getUint8(offset + 553), advice = view.getUint32(offset + 556, true);
  const start = view.getBigUint64(offset + 560, true), end = view.getBigUint64(offset + 568, true);
  const next = view.getBigUint64(offset + 576, true);
  if (tag !== 1 || hole > 1 || (advice !== 22 && advice !== 23)
    || bytes.subarray(offset + 554, offset + 556).some(byte => byte !== 0)
    || start >= end || next < start || next > end || [start, end, next].some(value => value % 4096n !== 0n)) throw malformed();
  return { start, end, next, advice, sawHole: hole === 1 };
}

function decodeIoWait(bytes: Uint8Array, view: DataView, offset: number): ReadinessWait {
  const openFileId = view.getBigUint64(offset + 248, true);
  const events = view.getUint32(offset + 256, true);
  if (openFileId === 0n || openFileId === 0xffff_ffff_ffff_ffffn || (events !== 1 && events !== 4)
    || bytes.subarray(offset + 260, offset + 264).some((byte) => byte !== 0)) {
    throw new VMError("PROTOCOL_ERROR", "Userspace syscall trace is malformed");
  }
  return { kind: "readiness", openFileId, events, wakeups: view.getBigUint64(offset + 264, true) };
}

function decodeControlWait(bytes: Uint8Array, view: DataView, offset: number, version: number): DurabilityWait | TaskRunWait | CounterCapacityWait | CqWriterWait | undefined {
  const tag = view.getUint8(offset + 512);
  if (tag === 4 && version >= 35) return decodeCqWriterWait(bytes, view, offset);
  if (tag === 0) {
    if (bytes.subarray(offset + 513, offset + 552).some((byte) => byte !== 0)) throw malformed();
    return undefined;
  }
  if (tag === 2 && version >= 18) {
    const ringOpenFileId = view.getBigUint64(offset + 520, true);
    const issuerTid = view.getUint32(offset + 528, true);
    if (ringOpenFileId === 0n || ringOpenFileId === 0xffff_ffff_ffff_ffffn || issuerTid === 0
      || bytes.subarray(offset + 513, offset + 520).some(byte => byte !== 0)
      || bytes.subarray(offset + 532, offset + 552).some(byte => byte !== 0)) throw malformed();
    return { kind: "task-run", ringOpenFileId, issuerTid };
  }
  if (tag === 3 && version >= 33) {
    const readiness = decodeIoWait(bytes, view, offset), balance = view.getBigUint64(offset + 520, true);
    if (readiness.events !== 4 || balance === 0n
      || bytes.subarray(offset + 513, offset + 520).some(byte => byte !== 0)
      || bytes.subarray(offset + 528, offset + 552).some(byte => byte !== 0)) throw malformed();
    return { kind: "eventfd-capacity", openFileId: readiness.openFileId, events: 4, wakeups: readiness.wakeups, balance };
  }
  const flags = view.getUint8(offset + 513);
  const generation = view.getBigUint64(offset + 520, true), id = view.getBigUint64(offset + 528, true);
  const root = view.getBigUint64(offset + 536, true), workspace = view.getBigUint64(offset + 544, true);
  if (tag !== 1 || flags === 0 || flags > 3 || generation === 0n || id === 0n
    || bytes.subarray(offset + 514, offset + 520).some((byte) => byte !== 0)
    || ((flags & 1) !== 0) !== (root !== 0n) || ((flags & 2) !== 0) !== (workspace !== 0n)) throw malformed();
  return { kind: "durability", generation, id,
    ...((flags & 1) === 0 ? {} : { root }), ...((flags & 2) === 0 ? {} : { workspace }),
  };
}

function malformed(): VMError {
  return new VMError("PROTOCOL_ERROR", "Userspace syscall trace is malformed");
}
