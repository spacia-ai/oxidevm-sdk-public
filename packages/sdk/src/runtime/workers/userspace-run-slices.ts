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
