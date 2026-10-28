import type { UserspaceRunResult } from "../userspace-abi.js";
import { integer } from "../decode.js";

export function nativeExecutionPending(liveProcesses: unknown, detachedIo: unknown = 0): boolean {
  const live = integer(liveProcesses, "Userspace live process count", 0, 0xffff_ffff);
  const pending = integer(detachedIo, "Userspace detached I/O flag", 0, 1);
  return live !== 0 || pending === 1;
}

/** Execution belongs to the shared runtime, including after its first process retires. */
export function failUserspaceRuntime<Process>(
  processes: ReadonlyMap<number, Process>,
  error: unknown,
  fail: (process: Process, error: unknown) => void,
): void {
  for (const process of [...processes.values()]) fail(process, error);
}

export function shouldServicePendingWork(
  result: UserspaceRunResult["kind"],
  sliceComplete: boolean,
): boolean {
  return result !== "step-limit" || sliceComplete;
}

export function shouldAcknowledgeOutputGeneration(
  awaitingAcknowledgement: boolean,
  emittedOutput: boolean,
): boolean {
  return !awaitingAcknowledgement && !emittedOutput;
}

/** What the worker does with the runtime's `next_wake_ms` answer. */
export type WakeTimerAction =
  | { readonly kind: "none" }
  | { readonly kind: "run-now" }
  | { readonly kind: "arm"; readonly delayMs: number };

const NO_WAKE_DEADLINE = 0xffff_ffff;

export function wakeTimerAction(nextWakeMs: number): WakeTimerAction {
  if (nextWakeMs === NO_WAKE_DEADLINE) return { kind: "none" };
  if (nextWakeMs === 0) return { kind: "run-now" };
  return { kind: "arm", delayMs: nextWakeMs };
}

/**
 * A blocked or exit boundary leaves the runtime with nothing to run until a deadline or an
 * external event. An immediate run cancels the armed wake timer, and an unchanged deadline
 * raises no timer notification, so the worker re-arms from the runtime at every such boundary.
 */
export function rearmsWakeTimer(result: UserspaceRunResult["kind"]): boolean {
  return result === "blocked" || result === "exit";
}

export interface UserspaceTimerHost<Handle> {
  readonly set: (callback: () => void, delayMs: number) => Handle;
  readonly clear: (handle: Handle) => void;
}

/** The runtime's one wake timer: arming replaces a pending wake. */
export interface UserspaceWakeTimer {
  readonly armed: boolean;
  arm(delayMs: number): void;
  cancel(): void;
}

export function createUserspaceWakeTimer<Handle>(
  host: UserspaceTimerHost<Handle>,
  wake: () => void,
): UserspaceWakeTimer {
  let pending: { readonly handle: Handle } | undefined;
  const cancel = (): void => {
    if (pending === undefined) return;
    host.clear(pending.handle);
    pending = undefined;
  };
  return {
    get armed() {
      return pending !== undefined;
    },
    arm(delayMs) {
      cancel();
      pending = {
        handle: host.set(() => {
          pending = undefined;
          wake();
        }, delayMs),
      };
    },
    cancel,
  };
}
