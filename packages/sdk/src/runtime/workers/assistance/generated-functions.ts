import { ExecutableSources } from "./executable-sources.ts";
import { record, string } from "../../decode.ts";
import { type AssistanceCompiler, transformSource } from "./compiler.ts";
import { lowerScriptImports } from "./script-imports.js";
import { isNodeBuiltin } from "./commonjs.ts";
import { VMError } from "../../errors.ts";

/** What the realm's `eval` does under this profile: the local-script profile
 * refuses it, so every generated source crosses the compiler boundary; the
 * installed Next profile keeps the intrinsic, because webpack's development
 * output evaluates each module's source through a direct eval inside the
 * module factory's scope, which no transformed replacement can reach. Sources
 * evaluated that way are not registered for stack traces or source maps. */
export interface GeneratedFunctionPolicy {
  readonly eval: "refuse" | "native";
  /** The process's module loader. Node resolves an `import()` in generated code against the module that created the
   * function, which this adapter cannot see, so it serves only specifiers that resolve the same from anywhere: an
   * absolute path, a `file:` URL or a built-in (Prettier imports its plugins this way). Anything else is a typed
   * refusal the process remembers. Without a loader, generated code may not import. */
  readonly importModule?: (specifier: string, options?: unknown) => Promise<unknown>;
}

/** Runtime code generation shares the compiler boundary with loaded modules.
 * Native Function first parses its separate parameter/body inputs without
 * executing them. Its intrinsic source is then transformed before evaluation.
 */
export function installGeneratedFunctions(compiler: AssistanceCompiler, realmValue: unknown, sources = new ExecutableSources(),
  policy: GeneratedFunctionPolicy = { eval: "refuse" }): () => void {
  const realm = record(realmValue, "generated function realm");
  const NativeFunction = realm["Function"];
  if (typeof NativeFunction !== "function") throw new TypeError("realm has no Function constructor");
  const prototype = object(NativeFunction.prototype);
  const intrinsicToString: unknown = Reflect.get(prototype, "toString");
  if (typeof intrinsicToString !== "function") throw new TypeError("Function prototype has no toString");
  let sequence = 0;
  const generatedImport = (specifier: unknown, options?: unknown): Promise<unknown> => {
    if (typeof specifier === "symbol") return Promise.reject(new TypeError("Cannot convert a Symbol value to a string"));
    const request = String(specifier), load = policy.importModule;
    if (load !== undefined && (request.startsWith("/") || request.startsWith("file:") || isNodeBuiltin(request))) return load(request, options);
    return Promise.reject(new VMError("FEATURE_NOT_AVAILABLE", "import() of a relative or package specifier from generated code is unavailable",
      { backend: "assisted-node", lateFailure: "unavailable-builtin", subject: "import() of a relative or package specifier from generated code", specifier: request }));
  };
  const compile = (args: readonly unknown[], parser: unknown = NativeFunction): object => {
    if (typeof parser !== "function") throw new TypeError("Invalid function constructor");
    const original: unknown = Reflect.apply(parser, undefined, args);
    if (typeof original !== "function") throw new TypeError("Function constructor returned a non-function");
    const source = string(Reflect.apply(intrinsicToString, original, []), "generated function source");
    const imports = compiler.hasDynamicImport(source);
    if (imports && policy.importModule === undefined) throw new TypeError("Dynamic imports in generated functions are not supported");
    const filename = `/generated/function-${++sequence}.js`;
    sources.registerApplication(filename, source, true);
    const script = lowerScriptImports(source, filename);
    const transformed = transformSource(compiler, script.code, "commonjs", filename, script.map);
    const evaluator: unknown = Reflect.apply(NativeFunction, undefined, [
      ...(imports ? [script.importName] : []), `${sources.emit(transformed, filename, "generated-function")}\nreturn anonymous;`,
    ]);
    if (typeof evaluator !== "function") throw new TypeError("Invalid generated function evaluator");
    const result: unknown = Reflect.apply(evaluator, undefined, imports ? [generatedImport] : []);
    if (typeof result !== "function") throw new TypeError("Generated function is not callable");
    return result;
  };
  const constructor = new Proxy(NativeFunction, {
    apply(_target, _receiver, args: unknown[]) { return compile(args); },
    construct(_target, args: unknown[], newTarget) {
      if (newTarget !== constructor) throw new TypeError("Subclassed Function constructors are not supported");
      return compile(args);
    },
  });
  const restore: (() => void)[] = [];
  function replace(target: object, name: string, value: unknown): void {
    const previous = Object.getOwnPropertyDescriptor(target, name);
    if (previous === undefined || previous.configurable !== true) throw new TypeError(`Cannot isolate generated constructor ${name}`);
    Object.defineProperty(target, name, { ...previous, value });
    restore.push(() => { Object.defineProperty(target, name, previous); });
  }
  try {
    replace(realm, "Function", constructor);
    replace(prototype, "constructor", constructor);
    if (policy.eval === "refuse") {
      replace(realm, "eval", () => { throw new TypeError("Direct and indirect eval are not supported by the local-script profile"); });
    }
    // Obtain each intrinsic in its own realm; never return an untransformed
    // AsyncFunction/GeneratorFunction constructor to application code. AsyncFunction
    // compiles like Function (the compiler keeps `(async function () {}).constructor`
    // reaching it); the generator constructors stay refused.
    for (const expression of ["async function(){}", "function*(){}", "async function*(){}"] ) {
      const inspect: unknown = Reflect.apply(NativeFunction, undefined, [`return Object.getPrototypeOf(${expression});`]);
      if (typeof inspect !== "function") throw new TypeError("Invalid constructor inspector");
      const functionPrototype = object(Reflect.apply(inspect, undefined, []));
      const intrinsic: unknown = Reflect.get(functionPrototype, "constructor");
      replace(functionPrototype, "constructor", expression === "async function(){}" && typeof intrinsic === "function"
        ? new Proxy(intrinsic, {
            apply(_target, _receiver, args: unknown[]) { return compile(args, intrinsic); },
            construct(_target, args: unknown[]) { return compile(args, intrinsic); },
          })
        : () => { throw new TypeError("This dynamic function constructor is not supported"); });
    }
  } catch (error) {
    for (const reset of restore.reverse()) reset();
    throw error;
  }
  return () => { for (const reset of restore.reverse()) reset(); restore.length = 0; };
}

function object(value: unknown): object {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") throw new TypeError("Invalid function prototype");
  return value;
}
