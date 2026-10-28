import { protocol } from "../../js-process/codec.js";
import { decodeForkExecArgv, FORK_EXEC_ARGUMENTS } from "../../protocol/assistance-fork.js";

/** Rust admits this closed flag set before selecting the original project entry. */
export function nativeArguments(argv: readonly string[]) {
  let index = 1;
  while (argv[index] !== undefined && FORK_EXEC_ARGUMENTS.includes(argv[index] ?? "")) index++;
  const entry = argv[index];
  if (entry === undefined || entry === "" || entry.startsWith("-")) protocol("Unqualified native launch argument");
  return { entry, execArgv: decodeForkExecArgv(argv.slice(1, index)), args: argv.slice(index + 1) };
}
