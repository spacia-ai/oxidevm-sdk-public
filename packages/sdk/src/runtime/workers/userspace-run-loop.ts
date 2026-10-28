import { serializeUnknownError } from "../errors.js";
import { decodeCpuSnapshot, type CoreRunExit } from "../core-abi.js";
import { decodeUserspacePendingWork, decodeUserspaceRunResult, type UserspaceRunResult } from "../userspace-abi.js";
import type { HostAttention } from "../host-attention.js";
import { coreFailureError } from "./core-failure.js";
import { assertUserspaceStatus as assertStatus, callUserspaceU32 as call } from "./userspace-exports.js";
import { throwIfUserspaceKernelFailed } from "./userspace-io-failure.js";
import type { UserspaceAttentionChannel, UserspaceSliceEnd } from "../protocol/userspace-slices.js";
import { INLINE_SERVICE_MILLISECONDS, newOutputEndsSlice, runSliceMilliseconds } from "./userspace-run-slices.js";
import { shouldServicePendingWork } from "./userspace-service.js";
import type { RuntimeState } from "./userspace-worker-state.js";

/** Guest instructions one action may retire before it returns to the run loop. */
export const RUN_STEPS = 100_000;
/** Actions one run slice may take. */
export const RUN_ACTIONS_PER_SLICE = 4_096;

/** What the run loop asks of the worker that owns the runtime. */
export interface UserspaceSlicePorts {
  readonly now: () => number;
  /** Terminal input keeps run slices short until this time (`userspace-run-slices.ts`). */
  readonly interactiveUntil: () => number;
  /** Channels whose undelivered host messages end a slice once the guest had its quantum. */
  readonly attention: HostAttention<UserspaceAttentionChannel>;
  readonly servicePendingWork: (active: RuntimeState, scheduleTimer: boolean) => void;
  /** Serves the host requests the runtime raised, between actions of a running slice. */
  readonly serviceHostRequests: (active: RuntimeState) => void;
  /** Settles a true boundary: a blocked, exited or faulted runtime. */
  readonly finishResult: (active: RuntimeState) => void;
  readonly scheduleRun: (active: RuntimeState) => void;
}

/**
 * One run slice: guest actions back to back until the slice's actions or time run out, a compiled
 * module waits to be installed, an interactive slice produced output, a watched channel holds host
 * messages the worker's event loop has not delivered (once the guest had its fair quantum), or the
 * guest reaches a true boundary. Every action ends at an instruction boundary. There the worker
 * services pending work when the slice ends, and the host requests the runtime raised every
 * `INLINE_SERVICE_MILLISECONDS` while it runs. Each slice records exactly one end reason.
 */
export function runUserspaceSlice(active: RuntimeState, ports: UserspaceSlicePorts): void {
  active.workerRunTurns += 1;
  const started = ports.now();
  const slice: SliceClock = { started, now: started };
  let end: UserspaceSliceEnd = "failure";
  try {
    end = runSliceActions(active, ports, slice);
  } finally {
    active.slices.ends[end] += 1;
    active.fairness.end(slice.now, end !== "boundary" && end !== "failure");
  }
  if (end === "boundary") ports.finishResult(active);
  else ports.scheduleRun(active);
}

interface SliceClock {
  readonly started: number;
  now: number;
}

function runSliceActions(active: RuntimeState, ports: UserspaceSlicePorts, slice: SliceClock): UserspaceSliceEnd {
  const interactiveUntil = ports.interactiveUntil();
  const interactive = slice.started < interactiveUntil;
  const sliceMilliseconds = runSliceMilliseconds(slice.started, interactiveUntil);
  const quantum = active.fairness.begin(slice.started);
  let inlineServiceAt = 0;
  for (let action = 1; ; action += 1) {
    active.pendingResult = runJitTurn(active);
    const trueBoundary = active.pendingResult.kind !== "step-limit";
    slice.now = ports.now();
    const elapsed = slice.now - slice.started;
    // The order and side effects of the first four checks are those of the slice before host attention.
    const end: UserspaceSliceEnd | undefined = action === RUN_ACTIONS_PER_SLICE ? "action-budget"
      : elapsed >= sliceMilliseconds ? "deadline"
      : active.jitRuntime.yieldForCompiledModule(active.core, elapsed) ? "compiled-module"
      : newOutputEndsSlice(active, interactive) ? "interactive-output"
      : !trueBoundary && attentionEndsSlice(active, ports.attention, elapsed, quantum) ? "host-attention"
      : undefined;
    if (shouldServicePendingWork(active.pendingResult.kind, end !== undefined)) {
      ports.servicePendingWork(active, trueBoundary);
    } else if (elapsed - inlineServiceAt >= INLINE_SERVICE_MILLISECONDS) {
      inlineServiceAt = elapsed;
      serviceInlineHostRequests(active, ports);
    }
    if (trueBoundary) return "boundary";
    active.pendingResult = undefined;
    if (end !== undefined) return end;
  }
}

/** Whether a watched channel's undelivered messages end the slice now. Attention waits until the
 * slice has run its quantum, so continuous host traffic cannot starve the guest. */
function attentionEndsSlice(
  active: RuntimeState,
  attention: HostAttention<UserspaceAttentionChannel>,
  elapsed: number,
  quantum: number,
): boolean {
  const channel = attention.pending();
  if (channel === undefined) return false;
  if (elapsed < quantum) {
    active.slices.attentionDeferrals += 1;
    return false;
  }
  active.slices.hostAttention[channel] += 1;
  return true;
}

/** Serves host requests the runtime raised during the slice: completions for JS processes, I/O
 * requests and preview replies. Output and exits keep their slice-boundary cadence. */
function serviceInlineHostRequests(active: RuntimeState, ports: UserspaceSlicePorts): void {
  active.pendingWorkPolls += 1;
  active.slices.inlinePendingWorkPolls += 1;
  if (!decodeUserspacePendingWork(call(active.instance, "oxidevm_userspace_pending_work")).hostRequest) return;
  active.hostRequestServicePolls += 1;
  ports.serviceHostRequests(active);
}

/** One guest action: prepare the next runnable task, run it through the JIT runtime, and complete
 * the syscall or exception that ended it. */
export function runJitTurn(active: RuntimeState): UserspaceRunResult {
  const loaded = active.instance;
  const prepared = call(loaded, "oxidevm_userspace_prepare");
  if (prepared !== 0) throwIfUserspaceKernelFailed(active);
  if (prepared === 3 || prepared === 4 || prepared === 5) return readResult(active, prepared);
  assertStatus(prepared, "oxidevm_userspace_prepare");
  const exit = active.jitRuntime.runLinuxBlock(active.core, 0, RUN_STEPS, () => undefined)
    ?? active.jitRuntime.runLinuxGuardFallback(active.core, RUN_STEPS);
  return completeJitExit(active, exit);
}

function completeJitExit(active: RuntimeState, exit: CoreRunExit): UserspaceRunResult {
  const loaded = active.instance;
  switch (exit.kind) {
    case "adapter-exit": {
      const status = call(loaded, "oxidevm_userspace_complete_syscall");
      if (status !== 0) throwIfUserspaceKernelFailed(active);
      if (status === 3 || status === 4 || status === 5) return readResult(active, status);
      assertStatus(status, "oxidevm_userspace_complete_syscall");
      return { kind: "step-limit" };
    }
    case "exception": {
      const exception = exit.exception;
      if (
        exception.vector.number === 14
        && exception.faultAddress === exception.instructionRip
      ) {
        console.error(
          "oxidevm-userspace invalid instruction target",
          readFaultControlState(active),
        );
      }
      if (exception.vector.number === 6) {
        console.error("oxidevm-userspace preceding exception", active.lastException, exception);
      }
      active.lastException = exception;
      const flags = (exception.errorCode === undefined ? 0 : 1)
        | (exception.faultAddress === undefined ? 0 : 2);
      assertStatus(call(
        loaded,
        "oxidevm_userspace_handle_exception",
        exception.vector.number,
        exceptionClass(exception.class),
        flags,
        exception.errorCode ?? 0,
        exception.faultAddress ?? 0n,
        exception.instructionRip,
      ), "oxidevm_userspace_handle_exception");
      return { kind: "step-limit" };
    }
    case "step-limit":
      return { kind: "step-limit" };
    case "halted":
    case "reset":
      return { kind: "fault" };
    case "internal-failure":
      throw coreFailureError(exit);
  }
}

function readFaultControlState(active: RuntimeState): unknown {
  try {
    const loaded = active.instance;
    const snapshotPointer = call(loaded, "oxidevm_cpu_state_ptr");
    const snapshotLength = call(loaded, "oxidevm_cpu_state_len");
    const state = decodeCpuSnapshot(
      new Uint8Array(active.memory.buffer, snapshotPointer, snapshotLength).slice(),
      "userspace",
    ).state;
    const stackAddress = state.rsp >= 16n ? state.rsp - 16n : 0n;
    try {
      assertStatus(call(loaded, "oxidevm_read_memory", stackAddress, 32), "oxidevm_read_memory");
      const stagingPointer = call(loaded, "oxidevm_staging_ptr");
      const stack = new Uint8Array(active.memory.buffer, stagingPointer, 32).slice();
      return { state, stack: [...stack] };
    } catch (error) { return { state, stackError: serializeUnknownError(error) }; }
  } catch (error) {
    return { error: serializeUnknownError(error) };
  }
}

function exceptionClass(value: "fault" | "trap" | "abort" | "interrupt"): number {
  switch (value) {
    case "fault": return 0;
    case "trap": return 1;
    case "abort": return 2;
    case "interrupt": return 3;
  }
}

function readResult(active: RuntimeState, completionStatus?: number): UserspaceRunResult {
  const loaded = active.instance;
  const pointer = call(loaded, "oxidevm_userspace_result_ptr");
  const length = call(loaded, "oxidevm_userspace_result_len");
  const result = decodeUserspaceRunResult(new Uint8Array(active.memory.buffer, pointer, length), completionStatus);
  if (result.kind === "fault") throwIfUserspaceKernelFailed(active);
  return result;
}
