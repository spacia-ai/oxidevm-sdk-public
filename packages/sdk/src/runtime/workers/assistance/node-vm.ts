import { VMError } from "../../errors.ts";

type Evaluate = (source: string, filename: string) => unknown;
export type EvaluateContext = (source: string, context: object, filename: string) => unknown;

const refuse = (name: string): ((...args: unknown[]) => never) => () => {
  throw new VMError("FEATURE_NOT_AVAILABLE", `vm.${name} is not supported: an isolated browser worker has one realm and cannot create another V8 context`, { builtin: "vm", export: name });
};

/** The realm's own indirect `eval`, looked up at call time so the runtime's
 * generated-function policy (not this module) decides whether it exists. */
export function realmEvaluator(): Evaluate {
  return (source, filename) => {
    const indirect: unknown = Reflect.get(globalThis, "eval");
    if (typeof indirect !== "function") throw new VMError("FEATURE_NOT_AVAILABLE", `vm cannot evaluate ${filename}: eval is unavailable in this process`, { builtin: "vm", filename });
    const result: unknown = Reflect.apply(indirect, undefined, [source]);
    return result;
  };
}

/** The `vm` builtin: `runInThisContext` and `Script` are real evaluations in
 * the process's own realm through the runtime's generated-function policy;
 * general V8 contexts refuse. A qualified runtime can supply bounded data-script evaluation. */
/** Every value is "not a context": no separate context can exist here. */
const isContext: (context: unknown) => boolean = () => false;

export interface VmScript {
  runInThisContext(): unknown;
  readonly runInContext: (...args: unknown[]) => never;
  readonly runInNewContext: (context?: unknown, options?: unknown) => unknown;
  createCachedData(): Uint8Array;
}
export interface NodeVm {
  readonly Script: new (source: unknown, options?: unknown) => VmScript;
  readonly runInThisContext: (source: unknown, options?: unknown) => unknown;
  readonly isContext: (context: unknown) => boolean;
  readonly createContext: (...args: unknown[]) => never;
  readonly runInContext: (...args: unknown[]) => never;
  readonly runInNewContext: (source: unknown, context?: unknown, options?: unknown) => unknown;
  readonly compileFunction: (...args: unknown[]) => never;
}

export function createNodeVm(evaluate: Evaluate, evaluateContext?: EvaluateContext): NodeVm {
  const filenameOf = (options: unknown): string => {
    const value: unknown = typeof options === "object" && options !== null ? Reflect.get(options, "filename") : typeof options === "string" ? options : undefined;
    return typeof value === "string" ? value : "evalmachine.<anonymous>";
  };
  class Script {
    readonly #source: string;
    readonly #filename: string;
    constructor(source: unknown, options?: unknown) {
      if (typeof source !== "string") throw Object.assign(new TypeError("The \"code\" argument must be of type string"), { code: "ERR_INVALID_ARG_TYPE" });
      this.#source = source; this.#filename = filenameOf(options);
    }
    runInThisContext(): unknown { return evaluate(this.#source, this.#filename); }
    readonly runInContext: (...args: unknown[]) => never = refuse("runInContext");
    readonly runInNewContext = (context: unknown = {}, options?: unknown): unknown => {
      if (evaluateContext === undefined) return refuse("runInNewContext")();
      if (typeof context !== "object" || context === null) throw new TypeError("VM data context must be an object");
      if (options !== undefined && (typeof options !== "object" || options === null || Object.keys(options).length !== 0)) return refuse("runInNewContext options")();
      return evaluateContext(this.#source, context, this.#filename);
    };
    createCachedData(): Uint8Array { return new Uint8Array(0); }
  }
  return Object.freeze({
    Script,
    runInThisContext: (source: unknown, options?: unknown): unknown => new Script(source, options).runInThisContext(),
    isContext,
    createContext: refuse("createContext"), runInContext: refuse("runInContext"), runInNewContext: (source: unknown, context?: unknown, options?: unknown) => {
      if (options !== undefined && (typeof options !== "object" || options === null || Object.keys(options).some(key => key !== "filename"))) return refuse("runInNewContext options")();
      return new Script(source, options).runInNewContext(context);
    },
    compileFunction: refuse("compileFunction"),
  });
}
