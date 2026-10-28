import { decodeIoUringQueryWait, type UserspaceIoUringQueryWait } from "./userspace-io-uring-query-trace.ts";
import { decodeFileCopyWait, type UserspaceFileCopyWait } from "./userspace-file-copy-trace.ts";
import { decodeMessageBatchWait, type UserspaceMessageBatchWait } from "./userspace-message-batch-trace.ts";
import { decodeSyscallTraceOutcome, type UserspaceSyscallTraceOutcome } from "./userspace-trace-outcome.ts";
export type { UserspaceSyscallTraceOutcome, UserspaceExecFailureStage } from "./userspace-trace-outcome.ts";
import { decodeSeccompTrace, type UserspaceSeccompTrace } from "./userspace-seccomp-trace.ts";
import { VMError } from "./errors.ts";
import { decodeIoUringIssuerWait, type IoUringIssuerWait } from "./userspace-io-uring-issuer.ts";
import { decodeIoUringRegistrationDrain, decodeIoUringRegistrationWait, type UserspaceIoUringRegistrationDrain, type UserspaceIoUringRegistrationWait } from "./userspace-io-uring-registration-trace.ts";
import { decodeIoUringEnterBody, decodeIoUringEnterDrain, decodeIoUringEnterMutex, type UserspaceIoUringEnterDrain, type UserspaceIoUringEnterMutex, type UserspaceIoUringEnterWait } from "./userspace-io-uring-enter-trace.ts";
export { decodeUserspaceIoRegistrationPhase, type UserspaceIoRegistrationPhase } from "./userspace-io-uring-registration-trace.ts";
import { integer } from "./decode.ts";
import type { ProcessTermination } from "./protocol/agent.js";
import { decodeUserspaceTraceOperation, type UserspaceTraceOperation } from "./userspace-io-uring-trace.ts";
export { decodeIoUringCallSource, type IoUringCallSource } from "./userspace-io-uring-source.ts";

export { decodeUserspaceSpawnResult, type UserspaceSpawnResult } from "./userspace-spawn.ts";

export const USERSPACE_API_VERSION = 143;
/** Current encoder version; historical trace versions remain readable below. */
export const USERSPACE_SYSCALL_TRACE_VERSION = 52;

/** A newer work model must be understood before its CPU metrics can be interpreted. */
export function decodeUserspaceKernelAccountingModel(value: unknown): 1 {
  if (value !== 1n) throw new VMError("PROTOCOL_ERROR", "Unsupported Userspace kernel accounting model");
  return 1;
}

/** API 34 writes return an accepted prefix or a negative Linux errno. */
export function decodeUserspaceStdinCount(value: unknown, length: number): number {
  const count = integer(value, "Userspace accepted stdin bytes", -4095, length);
  if (count === -11) return 0;
  if (count < 0) throw new VMError("GUEST_CRASH", `Userspace stdin failed with errno ${-count}`);
  return count;
}
const USERSPACE_SYSCALL_TRACE_V1_RECORD_LENGTH = 160;
const USERSPACE_SYSCALL_TRACE_V2_RECORD_LENGTH = 192;
const USERSPACE_SYSCALL_TRACE_V3_RECORD_LENGTH = 272;
const USERSPACE_SYSCALL_TRACE_V4_RECORD_LENGTH = 272;
const USERSPACE_SYSCALL_TRACE_V6_RECORD_LENGTH = 288;
const USERSPACE_SYSCALL_TRACE_V12_RECORD_LENGTH = 512;
const USERSPACE_SYSCALL_TRACE_V13_RECORD_LENGTH = 552;
const USERSPACE_SYSCALL_TRACE_V14_RECORD_LENGTH = 584;
const USERSPACE_SYSCALL_TRACE_V15_RECORD_LENGTH = 624;
const USERSPACE_SYSCALL_TRACE_V16_RECORD_LENGTH = USERSPACE_SYSCALL_TRACE_V15_RECORD_LENGTH;
const USERSPACE_SYSCALL_TRACE_V17_RECORD_LENGTH = USERSPACE_SYSCALL_TRACE_V16_RECORD_LENGTH;
const USERSPACE_SYSCALL_TRACE_V18_RECORD_LENGTH = 752;
const USERSPACE_SYSCALL_TRACE_V26_RECORD_LENGTH = 784;
const USERSPACE_SYSCALL_TRACE_V27_RECORD_LENGTH = 832;
const USERSPACE_SYSCALL_TRACE_V35_RECORD_LENGTH = 928;
const USERSPACE_SYSCALL_TRACE_V38_RECORD_LENGTH = 960;
const USERSPACE_SYSCALL_TRACE_V43_RECORD_LENGTH = 992;
const FUTEX_CLOCK_REALTIME = 256;
const MAX_USERSPACE_SYSCALL_TRACE_EVENTS = 4_096;
export const MAX_USERSPACE_SYSCALL_TRACE_BYTES = 24 + MAX_USERSPACE_SYSCALL_TRACE_EVENTS * USERSPACE_SYSCALL_TRACE_V43_RECORD_LENGTH;

export type UserspaceRunResult =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "step-limit" }
  | { readonly kind: "blocked" }
  | { readonly kind: "fault" };

export function decodeUserspaceWaitStatus(value: unknown): ProcessTermination | undefined {
  const status = integer(value, "Userspace wait status", 0, 0xffff_ffff);
  if (status === 0xffff_ffff) return undefined;
  if (status <= 0xff00 && (status & 0xff) === 0) return { kind: "exit", code: status >>> 8 };
  if (status <= 0xff && (status & 0x7f) >= 1 && (status & 0x7f) <= 64) return { kind: "signal", signal: status & 0x7f };
  throw new VMError("PROTOCOL_ERROR", "Userspace wait status is not a completed termination");
}

export interface UserspacePendingWork {
  /** Includes file waits whose readiness changed before a service reply exists. */
  readonly hostRequest: boolean;
  readonly output: boolean;
  readonly processExit: boolean;
  readonly timer: boolean;
}

const USERSPACE_PENDING_HOST_REQUEST = 1 << 0;
export const USERSPACE_PENDING_OUTPUT = 1 << 1;
export const USERSPACE_PENDING_PROCESS_EXIT = 1 << 2;
export const USERSPACE_PENDING_TIMER = 1 << 3;
const USERSPACE_PENDING_MASK = (1 << 4) - 1;

export function decodeUserspacePendingWork(value: unknown): UserspacePendingWork {
  const bits = integer(value, "Userspace pending-work bits", 0, 0xffff_ffff);
  if ((bits & ~USERSPACE_PENDING_MASK) !== 0) {
    throw new VMError("PROTOCOL_ERROR", "Userspace pending-work contains reserved bits");
  }
  return {
    hostRequest: (bits & USERSPACE_PENDING_HOST_REQUEST) !== 0,
    output: (bits & USERSPACE_PENDING_OUTPUT) !== 0,
    processExit: (bits & USERSPACE_PENDING_PROCESS_EXIT) !== 0,
    timer: (bits & USERSPACE_PENDING_TIMER) !== 0,
  };
}

/** The guest clock a timed futex deadline is measured on. */
export type UserspaceFutexDeadlineClock = "monotonic" | "realtime";

export type UserspaceFutexTraceReason =
  | "value-mismatch"
  | "parked"
  | "wake"
  | "timeout"
  | "signal";

export type { UserspaceIoUringQueryWait } from "./userspace-io-uring-query-trace.ts";

export type UserspaceSyscallTraceWait =
  | IoUringIssuerWait
  | UserspaceIoUringEnterWait
  | UserspaceIoUringEnterMutex
  | UserspaceIoUringEnterDrain
  | UserspaceFileCopyWait
  | UserspaceMessageBatchWait
  | UserspaceIoUringRegistrationDrain
  | UserspaceIoUringRegistrationWait
  | UserspaceIoUringQueryWait
  | { readonly kind: "io-uring-task-run"; readonly ringOpenFileId: bigint; readonly pendingRequests: number }
  | { readonly kind: "io-uring-exec"; readonly pendingRequests: bigint; readonly reason: "collection-bound" | "cpu-quota" | "pending-operation" }
  | { readonly kind: "io-uring-exit"; readonly scope: { readonly kind: "process" } | { readonly kind: "owner"; readonly tid: number }; readonly pendingRequests: bigint }
  | { readonly kind: "kernel-cpu"; readonly remainingTicks: 1 | 2; readonly model: 1 }
  | { readonly kind: "rseq-slice"; readonly deadlineTicks: bigint; readonly reason: "syscall" | "expiry" }
  | {
    readonly kind: "storage" | "network" | "durability";
    readonly generation: bigint;
    readonly id: bigint;
  }
  | {
    readonly kind: "futex";
    readonly address: bigint;
    readonly private: boolean;
    readonly operation: number;
    readonly expected: number;
    readonly observed: number;
    /** Guest nanoseconds since trace v4; host nanoseconds in earlier traces. */
    readonly deadline: bigint | null;
    readonly deadlineClock: UserspaceFutexDeadlineClock | null;
    readonly timerGeneration: bigint;
    readonly waiterGeneration: bigint;
    readonly wakeOwner: { readonly pid: number; readonly tid: number } | null;
    readonly reason: UserspaceFutexTraceReason;
    readonly transition: "none" | "running-to-blocked" | "blocked-to-runnable";
  };

export type { UserspaceSeccompTrace } from "./userspace-seccomp-trace.ts";

interface UserspaceSyscallTraceFields {
  readonly sequence: bigint;
  readonly correlation: bigint;
  readonly runtimeGeneration: bigint;
  readonly pid: number;
  readonly tid: number;
  readonly addressSpace: bigint;
  readonly instructionRip: bigint;
  readonly nextRip: bigint;
  readonly number: bigint;
  readonly name: string | null;
  readonly arguments: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  readonly outcome: UserspaceSyscallTraceOutcome;
  readonly wait?: UserspaceSyscallTraceWait;
  readonly seccomp?: UserspaceSeccompTrace;
}

export type UserspaceSyscallTraceEvent = UserspaceSyscallTraceFields & UserspaceTraceOperation;

const SUPPORTED_SYSCALL_TRACE_VERSIONS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
  19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45,
  46, 47, 48, 49, 50, 51, USERSPACE_SYSCALL_TRACE_VERSION,
] as const;

export interface UserspaceSyscallTraceSnapshot {
  readonly version: (typeof SUPPORTED_SYSCALL_TRACE_VERSIONS)[number];
  readonly dropped: bigint;
  readonly events: readonly UserspaceSyscallTraceEvent[];
}

export {
  decodeUserspaceHostRequest, encodeUserspaceHostCompletion,
  encodeUserspaceNetworkHostCompletion, encodeUserspaceDurabilityHostCompletion,
} from "./userspace-host-abi.ts";
export type {
  UserspaceStorageHostRequest, UserspaceNetworkOperation, UserspaceNetworkHostRequest,
  UserspaceHostRequest, UserspaceHostCompletion, UserspaceNetworkHostCompletion,
  UserspaceDurabilityHostRequest, UserspaceDurabilityHostCompletion,
} from "./userspace-host-abi.ts";

export function encodeUserspaceArguments(arguments_: readonly string[]): Uint8Array<ArrayBuffer> {
  if (arguments_.length > 65_536) {
    throw new VMError("INVALID_ARGUMENT", "too many Userspace arguments");
  }
  const encoded = arguments_.map((argument, index) => {
    if (argument.includes("\0")) {
      throw new VMError("INVALID_ARGUMENT", `Userspace argument ${index} contains NUL`);
    }
    return new TextEncoder().encode(argument);
  });
  const length = encoded.reduce((total, bytes) => total + 4 + bytes.byteLength, 4);
  const record = new Uint8Array(length);
  const view = new DataView(record.buffer);
  view.setUint32(0, encoded.length, true);
  let offset = 4;
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.byteLength, true);
    offset += 4;
    record.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return record;
}

export function decodeUserspaceRunResult(bytes: Uint8Array, completionStatus?: number): UserspaceRunResult {
  if (
    bytes.byteLength !== 16
    || new TextDecoder().decode(bytes.subarray(0, 4)) !== "OXLR"
  ) {
    throw new VMError("PROTOCOL_ERROR", "Userspace result record is malformed");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint16(4, true) !== 2
    || view.getUint16(6, true) !== 0
    || view.getUint32(8, true) !== 4
    || view.getUint16(14, true) !== 0
  ) {
    throw new VMError("PROTOCOL_ERROR", "Userspace result version is unsupported");
  }
  const status = view.getUint8(13);
  if (completionStatus !== undefined) {
    const expectedTag = completionStatus === 3 ? 0 : completionStatus === 4 ? 3 : completionStatus === 5 ? 1 : undefined;
    if (expectedTag === undefined || view.getUint8(12) !== expectedTag) {
      throw new VMError("PROTOCOL_ERROR", "Userspace completion status and result disagree");
    }
  }
  switch (view.getUint8(12)) {
    case 0:
      return { kind: "exit", code: status };
    case 1:
      if (status !== 0) break;
      return { kind: "step-limit" };
    case 2:
      if (status !== 0) break;
      return { kind: "fault" };
    case 3:
      if (status !== 0) break;
      return { kind: "blocked" };
  }
  throw new VMError("PROTOCOL_ERROR", "Userspace result tag is invalid");
}

function isSyscallTraceVersion(version: number): version is UserspaceSyscallTraceSnapshot["version"] {
  return SUPPORTED_SYSCALL_TRACE_VERSIONS.some(supported => supported === version);
}

export function decodeUserspaceSyscallTrace(
  bytes: Uint8Array,
): UserspaceSyscallTraceSnapshot {
  if (bytes.byteLength < 24 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "OXLT") {
    throw malformedSyscallTrace();
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  const recordLength = version === 1
    ? USERSPACE_SYSCALL_TRACE_V1_RECORD_LENGTH
    : version === 2
      ? USERSPACE_SYSCALL_TRACE_V2_RECORD_LENGTH
      : version === 3
        ? USERSPACE_SYSCALL_TRACE_V3_RECORD_LENGTH
        : version === 4 || version === 5
          ? USERSPACE_SYSCALL_TRACE_V4_RECORD_LENGTH
          : version >= 6 && version <= 11 ? USERSPACE_SYSCALL_TRACE_V6_RECORD_LENGTH
            : version === 12 ? USERSPACE_SYSCALL_TRACE_V12_RECORD_LENGTH
              : version === 13 ? USERSPACE_SYSCALL_TRACE_V13_RECORD_LENGTH
                : version === 14 ? USERSPACE_SYSCALL_TRACE_V14_RECORD_LENGTH
                  : version === 15 ? USERSPACE_SYSCALL_TRACE_V15_RECORD_LENGTH
                    : version === 16 ? USERSPACE_SYSCALL_TRACE_V16_RECORD_LENGTH
                      : version === 17 ? USERSPACE_SYSCALL_TRACE_V17_RECORD_LENGTH
                        : version >= 18 && version <= 25 ? USERSPACE_SYSCALL_TRACE_V18_RECORD_LENGTH : version === 26 ? USERSPACE_SYSCALL_TRACE_V26_RECORD_LENGTH : version >= 27 && version <= 34 ? USERSPACE_SYSCALL_TRACE_V27_RECORD_LENGTH : version >= 35 && version <= 37 ? USERSPACE_SYSCALL_TRACE_V35_RECORD_LENGTH : version >= 38 && version <= 42 ? USERSPACE_SYSCALL_TRACE_V38_RECORD_LENGTH : version >= 43 && version <= 52 ? USERSPACE_SYSCALL_TRACE_V43_RECORD_LENGTH : 0;
  const count = view.getUint32(12, true);
  const expectedLength = 24 + count * recordLength;
  if (
    !isSyscallTraceVersion(version)
    || recordLength === 0
    || view.getUint16(6, true) !== 0
    || view.getUint32(8, true) !== recordLength
    || count > MAX_USERSPACE_SYSCALL_TRACE_EVENTS
    || expectedLength !== bytes.byteLength
  ) {
    throw malformedSyscallTrace();
  }
  const events: UserspaceSyscallTraceEvent[] = [];
  let previousSequence = 0n;
  for (let index = 0; index < count; index += 1) {
    const offset = 24 + index * recordLength;
    const sequence = view.getBigUint64(offset, true);
    const correlation = view.getBigUint64(offset + 8, true);
    const runtimeGeneration = view.getBigUint64(offset + 16, true);
    const pid = view.getUint32(offset + 24, true);
    const tid = view.getUint32(offset + 28, true);
    const addressSpace = view.getBigUint64(offset + 32, true);
    const nameLength = view.getUint8(offset + 121);
    if (
      sequence <= previousSequence
      || correlation === 0n
      || correlation > sequence
      || runtimeGeneration === 0n
      || pid === 0
      || tid === 0
      || addressSpace === 0n
      || nameLength > 32
      || (version === 1 && bytes.subarray(offset + 122, offset + 128).some((byte) => byte !== 0))
      || (version === 1 && bytes.subarray(offset + 128 + nameLength, offset + 160).some((byte) => byte !== 0))
      || (version >= 2 && bytes.subarray(offset + (version >= 9 ? 124 : 123), offset + 128).some((byte) => byte !== 0))
      || (version >= 2 && bytes.subarray(offset + 144, offset + 152).some((byte) => byte !== 0))
      || (version >= 2 && bytes.subarray(offset + 152 + nameLength, offset + 192).some((byte) => byte !== 0))
    ) {
      throw malformedSyscallTrace();
    }
    const nameOffset = version === 1 ? 128 : 152;
    const name = decodeSyscallName(bytes.subarray(offset + nameOffset, offset + nameOffset + nameLength));
    const result = view.getBigInt64(offset + 112, true);
    const outcome = decodeSyscallTraceOutcome(bytes, view, offset, version);
    const operation = decodeUserspaceTraceOperation(bytes, view, offset, version);
    if (operation.kind === "io-uring-work" && (view.getBigUint64(offset + 56, true) !== 426n
      || (operation.work.completion === "released" ? outcome.kind !== "released"
        : operation.work.completion === "waiting" || operation.work.completion === "executing" || operation.work.completion === "task-run-reissue" ? outcome.kind !== "blocked"
        : outcome.kind !== "result" || result < -0x8000_0000n || result > 0x7fff_ffffn))) throw malformedSyscallTrace();
    if (outcome.kind === "released" && operation.kind !== "io-uring-finalization" && operation.kind !== "io-uring-pool-finalization" && operation.kind !== "io-uring-task-filter-finalization" && (operation.kind !== "io-uring-work" || operation.work.completion !== "released")) throw malformedSyscallTrace();
    const wait = version === 1 || operation.kind === "io-uring-worker-limits" || operation.kind === "io-uring-inline-buffers" || operation.kind === "io-uring-finalization" || operation.kind === "io-uring-pool-finalization" || operation.kind === "io-uring-task-filter-finalization" || operation.kind === "io-uring-work" || operation.kind === "io-uring-worker-idle" || outcome.kind === "exec-failure"
      ? undefined
      : decodeSyscallTraceWait(bytes, view, offset, version);
    if ((wait?.kind === "kernel-cpu" || wait?.kind === "rseq-slice") && outcome.kind !== "blocked") throw malformedSyscallTrace();
    if (wait?.kind === "io-uring-task-run" && outcome.kind !== "blocked" && outcome.kind !== "resumed") throw malformedSyscallTrace();
    if (wait?.kind === "io-uring-issuer" && outcome.kind !== "blocked" && outcome.kind !== "resumed") throw malformedSyscallTrace();
    if (wait?.kind === "io-uring-exec" && outcome.kind !== "blocked" && outcome.kind !== "resumed") throw malformedSyscallTrace();
    if (wait?.kind === "io-uring-exit" && ((outcome.kind !== "blocked" && outcome.kind !== "resumed")
      || (wait.scope.kind === "process" ? view.getBigUint64(offset + 56, true) !== 231n
        : view.getBigUint64(offset + 56, true) !== 60n || wait.scope.tid !== tid))) throw malformedSyscallTrace();
    if (wait?.kind === "io-uring-query" && outcome.kind !== "blocked" && outcome.kind !== "resumed") throw malformedSyscallTrace();
    if (wait?.kind === "io-uring-registration-drain" && outcome.kind !== "blocked" && outcome.kind !== "resumed") throw malformedSyscallTrace();
    if (wait?.kind === "io-uring-registration" && outcome.kind !== "blocked" && outcome.kind !== "resumed") throw malformedSyscallTrace();
    if ((wait?.kind === "io-uring-enter" || wait?.kind === "io-uring-enter-mutex" || wait?.kind === "io-uring-enter-drain") && outcome.kind !== "blocked" && outcome.kind !== "resumed") throw malformedSyscallTrace();
    const seccomp = version >= 6 ? decodeSeccompTrace(bytes, view, offset + 272) : undefined;
    if ((wait?.kind === "io-uring-registration-drain" || wait?.kind === "io-uring-enter-drain") && wait.purpose === "seccomp-process-kill"
      && (seccomp?.kind !== "filter" || (seccomp.value >>> 16) !== 0x8000)) throw malformedSyscallTrace();
    if ((outcome.kind === "exec-failure" || wait?.kind === "io-uring-query") && seccomp !== undefined
      && (seccomp.kind === "strict" || (seccomp.value >>> 16) !== 0x7fff && (seccomp.value >>> 16) !== 0x7ffc)) throw malformedSyscallTrace();
    events.push({
      ...operation,
      sequence,
      correlation,
      runtimeGeneration,
      pid,
      tid,
      addressSpace,
      instructionRip: view.getBigUint64(offset + 40, true),
      nextRip: view.getBigUint64(offset + 48, true),
      number: view.getBigUint64(offset + 56, true),
      name,
      arguments: [
        view.getBigUint64(offset + 64, true),
        view.getBigUint64(offset + 72, true),
        view.getBigUint64(offset + 80, true),
        view.getBigUint64(offset + 88, true),
        view.getBigUint64(offset + 96, true),
        view.getBigUint64(offset + 104, true),
      ],
      outcome,
      ...(wait === undefined ? {} : { wait }),
      ...(seccomp === undefined ? {} : { seccomp }),
    });
    previousSequence = sequence;
  }
  return {
    version,
    dropped: view.getBigUint64(16, true),
    events,
  };
}


function decodeSyscallTraceWait(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  version: Exclude<UserspaceSyscallTraceSnapshot["version"], 1>,
): UserspaceSyscallTraceWait | undefined {
  const tag = view.getUint8(offset + 122);
  const generation = view.getBigUint64(offset + 128, true);
  const id = view.getBigUint64(offset + 136, true);
  const futexAreaUsed = version >= 3 && nonzero(bytes, offset + 192, offset + 272);
  if (tag === 16 && version >= 38) return decodeIoUringIssuerWait(bytes, view, offset);
  if (tag === 13 && version >= 34) return decodeIoUringEnterMutex(bytes, view, offset);
  if (tag === 15 && version >= 35) return decodeIoUringEnterBody(bytes, view, offset, version);
  if (tag === 14 && version >= 34) return decodeIoUringEnterDrain(bytes, view, offset);
  if (tag === 18 && version >= 52) return decodeMessageBatchWait(bytes, view, offset);
  if (tag === 17 && version >= 52) return decodeFileCopyWait(bytes, view, offset);
  if (tag === 10 && version >= 25) return decodeIoUringQueryWait(bytes, view, offset);
  if (tag === 0) {
    if (generation !== 0n || id !== 0n || futexAreaUsed) {
      throw malformedSyscallTrace();
    }
    return undefined;
  }
  if (tag === 1 || tag === 2 || (tag === 4 && version >= 5)) {
    if (generation === 0n || id === 0n || futexAreaUsed) {
      throw malformedSyscallTrace();
    }
    return { kind: tag === 1 ? "storage" : tag === 2 ? "network" : "durability", generation, id };
  }
  if (tag === 5 && version >= 7) {
    if ((generation !== 1n && generation !== 2n) || id !== 1n || futexAreaUsed) throw malformedSyscallTrace();
    return { kind: "kernel-cpu", remainingTicks: generation === 1n ? 1 : 2, model: 1 };
  }
  if (tag === 6 && version >= 8) {
    if (generation === 0n || (id !== 1n && id !== 2n) || futexAreaUsed) throw malformedSyscallTrace();
    return { kind: "rseq-slice", deadlineTicks: generation, reason: id === 1n ? "syscall" : "expiry" };
  }
  if (tag === 12 && version >= 29) return decodeIoUringRegistrationDrain(bytes, view, offset);
  if (tag === 11 && version >= 29) return decodeIoUringRegistrationWait(bytes, view, offset, version);
  if (tag === 9 && version >= 20) {
    const number = view.getBigUint64(offset + 56, true);
    if (generation === 0n || futexAreaUsed || (number !== 59n && number !== 322n)) throw malformedSyscallTrace();
    const reason = id === 1n ? "collection-bound" : id === 2n ? "cpu-quota" : id === 3n ? "pending-operation" : undefined;
    if (reason === undefined) throw malformedSyscallTrace();
    return { kind: "io-uring-exec", pendingRequests: generation, reason };
  }
  if (tag === 8 && version >= 18) {
    if (generation === 0n || generation === 0xffff_ffff_ffff_ffffn || id === 0n || id > 0xffff_ffffn
      || futexAreaUsed || view.getBigUint64(offset + 56, true) !== 426n
      || (view.getBigUint64(offset + 88, true) & 1n) === 0n) throw malformedSyscallTrace();
    return { kind: "io-uring-task-run", ringOpenFileId: generation, pendingRequests: Number(id) };
  }
  if (tag === 7 && version >= 9) {
    if (generation > 0xffff_ffffn || id === 0n || futexAreaUsed) throw malformedSyscallTrace();
    return { kind: "io-uring-exit", scope: generation === 0n ? { kind: "process" } : { kind: "owner", tid: Number(generation) }, pendingRequests: id };
  }
  if (tag !== 3 || version === 2 || generation !== 0n || id !== 0n) {
    throw malformedSyscallTrace();
  }
  return decodeFutexTraceWait(bytes, view, offset, version === 3 ? 3 : version === 4 ? 4 : 5);
}

function decodeFutexTraceWait(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  version: 3 | 4 | 5,
): Extract<UserspaceSyscallTraceWait, { readonly kind: "futex" }> {
  const address = view.getBigUint64(offset + 192, true);
  const rawDeadline = view.getBigUint64(offset + 200, true);
  const waiterGeneration = view.getBigUint64(offset + 208, true);
  const timerGeneration = view.getBigUint64(offset + 216, true);
  const operation = view.getUint32(offset + 224, true);
  const expected = view.getUint32(offset + 228, true);
  const observed = view.getUint32(offset + 232, true);
  const wakePid = view.getUint32(offset + 236, true);
  const wakeTid = view.getUint32(offset + 240, true);
  const reason = decodeFutexTraceReason(view.getUint8(offset + 244));
  const transition = decodeFutexTraceTransition(view.getUint8(offset + 245));
  const privateFlag = view.getUint8(offset + 246);
  const deadline = rawDeadline === 0xffff_ffff_ffff_ffffn ? null : rawDeadline;
  const deadlineClock = decodeFutexDeadlineClock(view, offset, version, operation, deadline);
  const hasOwner = wakePid !== 0 || wakeTid !== 0;
  if (
    address === 0n
    || (address & 3n) !== 0n
    || privateFlag > 1
    || ((operation & 128) !== 0) !== (privateFlag === 1)
    || (hasOwner && (wakePid === 0 || wakeTid === 0))
    || (deadline === null && timerGeneration !== 0n)
    || nonzero(bytes, offset + (version === 3 ? 247 : 248), offset + 272)
    || !validFutexTraceState(reason, transition, waiterGeneration, timerGeneration, deadline, hasOwner)
  ) {
    throw malformedSyscallTrace();
  }
  return {
    kind: "futex",
    address,
    private: privateFlag === 1,
    operation,
    expected,
    observed,
    deadline,
    deadlineClock,
    timerGeneration,
    waiterGeneration,
    wakeOwner: hasOwner ? { pid: wakePid, tid: wakeTid } : null,
    reason,
    transition,
  };
}

/**
 * Version 4 records name the deadline clock in byte 247. Version 3 records predate it, but
 * their producer used the realtime clock exactly when FUTEX_CLOCK_REALTIME was set.
 */
function decodeFutexDeadlineClock(
  view: DataView,
  offset: number,
  version: 3 | 4 | 5,
  operation: number,
  deadline: bigint | null,
): UserspaceFutexDeadlineClock | null {
  const realtime = (operation & FUTEX_CLOCK_REALTIME) !== 0;
  if (version === 3) {
    return deadline === null ? null : realtime ? "realtime" : "monotonic";
  }
  const tag = view.getUint8(offset + 247);
  if (deadline === null) {
    if (tag !== 0) throw malformedSyscallTrace();
    return null;
  }
  if (tag === 1 && !realtime) return "monotonic";
  if (tag === 2 && realtime) return "realtime";
  throw malformedSyscallTrace();
}

function validFutexTraceState(
  reason: UserspaceFutexTraceReason,
  transition: "none" | "running-to-blocked" | "blocked-to-runnable",
  waiterGeneration: bigint,
  timerGeneration: bigint,
  deadline: bigint | null,
  hasOwner: boolean,
): boolean {
  const timerIsConsistent = (deadline === null && timerGeneration === 0n)
    || (deadline !== null && timerGeneration > 0n);
  switch (reason) {
    case "value-mismatch":
      return transition === "none" && waiterGeneration === 0n && timerGeneration === 0n && deadline === null && !hasOwner;
    case "parked":
      return transition === "running-to-blocked" && waiterGeneration > 0n && timerIsConsistent && !hasOwner;
    case "wake":
      return transition === "blocked-to-runnable" && waiterGeneration > 0n && timerIsConsistent && hasOwner;
    case "timeout":
      return !hasOwner && deadline !== null && (
        (transition === "none" && waiterGeneration === 0n && timerGeneration === 0n)
        || (transition === "blocked-to-runnable" && waiterGeneration > 0n && timerGeneration > 0n)
      );
    case "signal":
      return transition === "blocked-to-runnable" && waiterGeneration > 0n && timerIsConsistent && !hasOwner;
  }
}

function decodeFutexTraceReason(tag: number): UserspaceFutexTraceReason {
  switch (tag) {
    case 1: return "value-mismatch";
    case 2: return "parked";
    case 3: return "wake";
    case 4: return "timeout";
    case 5: return "signal";
    default: throw malformedSyscallTrace();
  }
}

function decodeFutexTraceTransition(tag: number): "none" | "running-to-blocked" | "blocked-to-runnable" {
  switch (tag) {
    case 0: return "none";
    case 1: return "running-to-blocked";
    case 2: return "blocked-to-runnable";
    default: throw malformedSyscallTrace();
  }
}

function nonzero(bytes: Uint8Array, start: number, end: number): boolean {
  return bytes.subarray(start, end).some((byte) => byte !== 0);
}

function decodeSyscallName(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return null;
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw malformedSyscallTrace();
  }
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw malformedSyscallTrace();
  return name;
}

function malformedSyscallTrace(): VMError {
  return new VMError("PROTOCOL_ERROR", "Userspace syscall trace is malformed");
}
