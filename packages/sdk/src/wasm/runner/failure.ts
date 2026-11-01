import { VMError } from "../../runtime/errors.js";
import { MODULE_EXIT, MODULE_EXIT_REASONS, type ModuleExitReason } from "../exit-codes.js";
import type { AdapterFault } from "./hooks.js";

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

/**
 * What the runner reports for a failure. An application start writes it as a JSON record on standard error, which
 * `spawnModule` and `oxidevm wasm test` read; `reason` names a stable `detail.reason` the status alone does not.
 */
export type RunnerReport =
  | { readonly kind: ModuleExitReason; readonly message: string; readonly items?: readonly string[]; readonly reason?: string }
  | { readonly kind: "adapter"; readonly fault: AdapterFault; readonly message: string; readonly capabilities?: readonly string[]; readonly stack?: string };

/** The longest failure line, in code points. */
const MAX_LINE = 1024;

/**
 * The one line a program in the VM that ran `command` (engine ADR 0027) finds on standard error when the runner fails:
 * readable text with the command's name, like any Linux program's error, instead of a JSON record.
 */
export function failureLine(command: string, report: RunnerReport): string {
  const detail = "fault" in report
    ? report.fault === "undeclared-capability" ? `the module used ${(report.capabilities ?? []).join(", ")}, which its manifest does not declare: ${report.message}` : `the module failed: ${report.message}`
    : report.kind === "launch" ? `cannot start: ${report.message}` : report.kind === "adapter" ? `the module failed: ${report.message}` : report.message;
  // Bounded in code points, so a long message is never cut inside a character.
  return `${Array.from(`${command}: ${detail}`.replace(/\p{Cc}+/gu, " ")).slice(0, MAX_LINE).join("")}\n`;
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
