import { VMError } from "../../runtime/errors.js";
import { MODULE_EXIT, MODULE_EXIT_REASONS, type ModuleExitReason } from "../exit-codes.js";

/** A runner-level failure with the exit status that reports it. */
export class ModuleFailure extends VMError {
  readonly status: number;
  readonly kind: ModuleExitReason;
  /** Extra items for the error report, such as the names of missing prerequisites. */
  readonly items: readonly string[];
  constructor(kind: ModuleExitReason, message: string, items: readonly string[] = []) {
    super("GUEST_CRASH", message, { reason: MODULE_EXIT_REASONS[kind] });
    this.name = "ModuleFailure";
    this.kind = kind;
    this.status = MODULE_EXIT[kind];
    this.items = items;
  }
}

/** Rejects when `promise` has not settled within `ms`; the timer is always cleared. */
export async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new VMError("ABORTED", `${label} did not finish within ${String(ms)} ms`)); }, ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves after `ms`, or immediately when `promise` settles first. Never rejects. */
export async function settledWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>(resolve => { timer = setTimeout(resolve, ms); });
  try {
    await Promise.race([promise.then(() => undefined, () => undefined), elapsed]);
  } finally {
    clearTimeout(timer);
  }
}
