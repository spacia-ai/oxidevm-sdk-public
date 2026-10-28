import type { AssistanceCredit } from "../../protocol/assistance-credit.js";
import type { AssistedDependencyIdentity, BrokerEvent } from "../../protocol/assistance-broker.js";
import { VMError, deserializeError, serializeUnknownError } from "../../errors.js";

/** The waits a task retirement performs, each with its own owner: Linux for
 * the stop and terminal acknowledgement, the guest agent for credit returns,
 * the broker for its worker's retirement, and the network owner for listeners. */
export type RetirementStep = "guest-stop" | "terminal-ack" | "credit-return" | "broker-retired" | "network-close"
  | "broker-shutdown" | "guest-fence" | "network-shutdown";
export const RETIREMENT_STEP_MS = 45_000;

/** A retirement wait that never answers fails with the step that stalled and
 * the task it belonged to, so disposal reports an owner instead of hanging. */
export function boundedRetirementStep<T>(work: Promise<T>, step: RetirementStep, process: number, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new VMError("GUEST_CRASH", "Assisted task retirement stalled", { step, process, afterMs: ms })), ms);
    work.then(
      value => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(deserializeError(serializeUnknownError(error))); },
    );
  });
}

/** Public-stream output queued for the SDK port; an inherited fork child's
 * output joins its parent's queue and is charged to the parent. */
export interface Output {
  readonly event: Extract<BrokerEvent, { kind: "output" }>;
  readonly reservation: number;
  sequence: number | undefined;
}
export interface ChildOutput {
  readonly child: number; readonly stream: "stdout" | "stderr";
  readonly bytes: number; readonly reservation: number;
  acknowledging: boolean;
}
/** One silent fork child's output chunk in flight to its parent worker. */
export interface ForkOutput {
  readonly event: Extract<BrokerEvent, { kind: "output" }>;
  readonly reservation: number;
}
export type TaskOutcome = { readonly code: number } | { readonly signal: number } | { readonly error: unknown };

/** One assisted Linux task and its browser worker, owned by SystemAssistance. */
export interface Task {
  readonly requestId: number;
  readonly process: number;
  /** The SDK-side process port; a fork child has none and reports to its parent. */
  readonly port: MessagePort | undefined;
  readonly parent: Task | undefined;
  readonly silent: boolean;
  readonly children: Set<Task>;
  /** Guest child handles of this task's live fork helpers. Each reports exactly
   * one exit, which control consumes; the application never sees a helper. */
  readonly helpers: Set<number>;
  readonly forkOutput: Map<number, ForkOutput>;
  forkChunk: number;
  dependencies: AssistedDependencyIdentity | undefined;
  readonly ready: PromiseWithResolvers<undefined>;
  readonly guestCredits: AssistanceCredit[];
  readonly brokerCredits: AssistanceCredit[];
  readonly dispatch: AbortController;
  brokerRetired: PromiseWithResolvers<undefined> | undefined;
  brokerStarted: boolean;
  networkAdmission: Promise<void> | undefined;
  phase: "starting" | "running" | "stopping" | "terminal";
  guestSequence: number;
  guestEventSequence: number;
  terminalSequence: number | undefined;
  commandSequence: number;
  brokerSequence: number;
  outputSequence: number;
  input: { readonly sequence: number; readonly reservation: number; readonly completion: PromiseWithResolvers<undefined> } | undefined;
  inputClosed: boolean;
  readonly output: Output[];
  readonly childOutput: Map<number, ChildOutput>;
  outputBytes: number;
  drain: (() => void) | undefined;
  retirement: Promise<void> | undefined;
}
