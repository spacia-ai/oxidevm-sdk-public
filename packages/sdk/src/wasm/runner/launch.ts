import type { RunnerCopies, RunnerLaunch } from "../../runtime/js-process/launch.js";
import type { Invocation, Terminals } from "../define.js";

/** What one start of the runner works with, whichever way it was started. */
export interface RunnerStart {
  /** The launch description the start message carried. */
  readonly descriptor: string;
  /** The process's arguments after argv[0]. */
  readonly args: readonly string[];
  readonly invocation: Invocation<string>;
  readonly terminals: Terminals;
  /** The copies the VM's store verified before the process existed (engine ADR 0028). */
  readonly copies: RunnerCopies;
}

/** `spawnModule` starts a module with pipes, never a terminal. */
const NO_TERMINALS: Terminals = Object.freeze({ stdin: false, stdout: false, stderr: false });

/**
 * The start the launch describes. `argv` is what Rust reports as the process's arguments: for an application start
 * (`spawnModule`) only the caller's arguments, because the launcher's argv[0] is omitted; for a module command (engine
 * ADR 0027) the caller's whole argv, argv[0] included. Either way the module's `args` are the arguments after argv[0].
 */
export function runnerStart(launch: RunnerLaunch, argv: readonly string[]): RunnerStart {
  if (launch.kind === "host") return { descriptor: launch.descriptor, args: argv, invocation: Object.freeze({ kind: "host" }), terminals: NO_TERMINALS, copies: launch };
  const { name, path } = launch.invocation;
  return {
    descriptor: launch.descriptor, args: argv.slice(1), invocation: Object.freeze({ kind: "command", name, path, argv0: argv[0] ?? "" }),
    terminals: Object.freeze({ ...launch.terminals }), copies: launch,
  };
}
