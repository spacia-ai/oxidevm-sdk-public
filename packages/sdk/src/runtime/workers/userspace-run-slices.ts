import { decodeUserspacePendingWork, USERSPACE_PENDING_OUTPUT } from "../userspace-abi.js";
import { callUserspaceU32 as call, callUserspaceU64 } from "./userspace-exports.js";

/** How long one run slice executes before the worker yields to its messages and timers. */
export const RUN_SLICE_MILLISECONDS = 32;
/** A run slice's length while the page types: the next input waits for at most one slice. */
export const INTERACTIVE_SLICE_MILLISECONDS = 4;
/** How long after terminal input the worker keeps interactive slices. */
export const INTERACTIVE_WINDOW_MILLISECONDS = 1_000;

/** When the interactive window opened by input arriving at `inputAt` closes. */
export function interactiveWindowEnd(inputAt: number): number {
  return inputAt + INTERACTIVE_WINDOW_MILLISECONDS;
}

/** The length of a run slice that starts at `now`. */
export function runSliceMilliseconds(now: number, interactiveUntil: number): number {
  return now < interactiveUntil ? INTERACTIVE_SLICE_MILLISECONDS : RUN_SLICE_MILLISECONDS;
}

export interface OutputYield {
  /** The slice runs inside an interactive window. */
  readonly interactive: boolean;
  /** The runtime reports output for the page. */
  readonly outputPending: boolean;
  /** The runtime's current output generation. */
  readonly generation: bigint;
  /** The output generation an earlier slice already ended for. */
  readonly yieldedGeneration: bigint;
}

/**
 * An interactive slice ends as soon as the guest writes output, so an echo reaches the page
 * without waiting for the slice to run out. Output the page has not acknowledged stays pending
 * under the same generation, and must not end every following slice.
 */
export function shouldYieldForOutput(state: OutputYield): boolean {
  return state.interactive && state.outputPending && state.generation !== state.yieldedGeneration;
}

interface Runtime {
  readonly instance: Pick<WebAssembly.Instance, "exports">;
  /** The output generation an interactive run slice last ended for. */
  outputYieldGeneration: bigint;
}

/** Whether new guest output ends this slice, so the page receives it now. */
export function newOutputEndsSlice(runtime: Runtime, interactive: boolean): boolean {
  // The runtime is asked only inside an interactive window.
  const outputPending = interactive
    && decodeUserspacePendingWork(call(runtime.instance, "oxidevm_userspace_pending_work")).output;
  const yieldedGeneration = runtime.outputYieldGeneration;
  const generation = outputPending
    ? callUserspaceU64(runtime.instance, "oxidevm_userspace_pending_generation", USERSPACE_PENDING_OUTPUT)
    : yieldedGeneration;
  const endsSlice = shouldYieldForOutput({ interactive, outputPending, generation, yieldedGeneration });
  if (endsSlice) runtime.outputYieldGeneration = generation;
  return endsSlice;
}

/** Between actions of a running slice the worker serves host requests the runtime raised (JS process
 * completions, I/O requests and preview replies) at this cadence, without ending the slice. */
export const INLINE_SERVICE_MILLISECONDS = 0.25;

/** Guest instructions the shortest action may retire before it returns to the run loop. */
export const ACTION_STEPS_MIN = 100_000;
/** Guest instructions the longest action may retire. */
export const ACTION_STEPS_MAX = 4_000_000;

/** What one action that used up its instruction budget retired, and how long it took. */
export interface InstructionRate {
  readonly instructions: number;
  readonly milliseconds: number;
}

/**
 * The instruction budget of the next action: as many instructions as last about
 * `INLINE_SERVICE_MILLISECONDS` at the rate of the action before it.
 *
 * An action returns to the run loop only when its budget is used up or the guest reaches a boundary,
 * and the loop's checks (the slice's deadline, a compiled module, output, host attention, inline
 * service) run between actions. A fixed budget makes fast guest code return every few microseconds
 * and pay for those checks each time; a budget sized by time keeps their cadence at any speed.
 *
 * The budget at most doubles from one action to the next and shrinks at once, so a guest that turns
 * slow overruns the interval by one action at most. With no timed action yet, or a measurement that
 * makes no sense, it is the shortest action.
 */
export function actionSteps(rate: InstructionRate | undefined): number {
  if (rate === undefined) return ACTION_STEPS_MIN;
  const { instructions, milliseconds } = rate;
  if (!Number.isFinite(instructions) || instructions <= 0 || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return ACTION_STEPS_MIN;
  }
  const doubled = instructions * 2;
  // A clock that saw no time pass says only that the action was short.
  const sized = milliseconds === 0
    ? doubled
    : Math.min(doubled, Math.round(instructions / milliseconds * INLINE_SERVICE_MILLISECONDS));
  return Math.min(ACTION_STEPS_MAX, Math.max(ACTION_STEPS_MIN, sized));
}

/**
 * The budget after an action that ran with `current`. An action that used up its budget gives its
 * `rate` and sizes the next one. An action that a system call, a fault or a boundary ended says
 * nothing about speed, so the budget halves: one grown on fast code does not wait, at full
 * length, for slow code that follows many such actions later.
 */
export function nextActionSteps(current: number, rate: InstructionRate | undefined): number {
  return rate === undefined ? Math.max(ACTION_STEPS_MIN, Math.floor(current / 2)) : actionSteps(rate);
}
