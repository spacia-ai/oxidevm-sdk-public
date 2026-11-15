import { protocol } from "../../js-process/codec.js";
import { decodeForkExecArgv } from "../../protocol/assistance-fork.js";
import { readNodeExecutionOptions } from "../../protocol/node-options.js";

/** Rust admits a launch only with the execution options the runtime implements, before the
 * original project entry (ADR 0026, 1.11); Bun launches carry source-map flags only. */
export function nativeArguments(argv: readonly string[], runtime: "node" | "bun" = "node") {
  const read = readNodeExecutionOptions(argv.slice(1), undefined, runtime);
  const index = 1 + (read?.end ?? 0), entry = argv[index];
  if (read === undefined || entry === undefined || entry === "" || entry.startsWith("-")) protocol("Unqualified native launch argument");
  return { entry, execArgv: decodeForkExecArgv(argv.slice(1, index)), args: argv.slice(index + 1) };
}
