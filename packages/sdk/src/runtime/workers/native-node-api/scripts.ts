import { VMError } from "../../errors.js";
import type { AssistanceCompiler } from "../assistance/compiler.js";

/** The realm's intrinsic eval and Function, captured before application code can replace them. */
const intrinsicEval: unknown = Reflect.get(globalThis, "eval"), intrinsicFunction: unknown = Reflect.get(globalThis, "Function");
const NativeSyntaxError = SyntaxError, apply = Reflect.apply, construct = Reflect.construct;

/**
 * napi_run_script, path A of ADR 0026 (2.12): Node compiles and runs a Script, and for a script
 * that creates no global binding an indirect call of the intrinsic eval gives the same result:
 * the completion value, a global `this`, sloppy or strict code, and no read of the realm's
 * current `eval`. A script that declares global bindings needs a classic script in the process
 * realm (path B), and one the compiler cannot parse that the engine would accept cannot be
 * classified, so both fail as a limitation; the program's next run uses Linux. A source the engine
 * rejects too is invalid either way, and eval throws the engine's own SyntaxError, as Node's
 * Script::Compile does.
 */
export function nativeScriptRunner(compiler: AssistanceCompiler): (source: string) => unknown {
  if (typeof intrinsicEval !== "function") throw new VMError("FEATURE_NOT_AVAILABLE", "This realm has no eval for napi_run_script");
  const evaluate = intrinsicEval;
  return source => {
    const bindings = compiler.scriptBindings(source);
    if (bindings === "unparsed" && rejectedByEngine(source)) return completion(evaluate, source);
    if (bindings !== "none") {
      throw new VMError("FEATURE_NOT_AVAILABLE", "napi_run_script cannot yet run a script that declares global bindings", { lateFailure: "unsupported-node-api", subject: "napi_run_script" });
    }
    return completion(evaluate, source);
  };
}

/** An indirect call of the intrinsic eval: the script's completion value. */
function completion(evaluate: unknown, source: string): unknown {
  if (typeof evaluate !== "function") throw new VMError("FEATURE_NOT_AVAILABLE", "This realm has no eval for napi_run_script");
  const value: unknown = apply(evaluate, undefined, [source]);
  return value;
}

/** Whether the engine rejects `source` even as a function body, whose grammar is a script's plus
 * `return` and `new.target`; compiling the body runs none of it. */
function rejectedByEngine(source: string): boolean {
  if (typeof intrinsicFunction !== "function") return false;
  try { construct(intrinsicFunction, [source]); return false; }
  catch (error) { return error instanceof NativeSyntaxError; }
}
