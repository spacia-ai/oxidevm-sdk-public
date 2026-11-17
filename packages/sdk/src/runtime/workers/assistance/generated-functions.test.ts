import { expect, it } from "vitest";
import type { AssistanceCompiler } from "./compiler.js";
import { installGeneratedFunctions } from "./generated-functions.js";

/** The realm's Function goes through the transforming compiler either way; only
 * the eval policy differs by profile. */
const compiler = {
  transform: (source: string) => ({ code: source, map: "" }),
  hasDynamicImport: () => false,
  scriptBindings: () => "none",
} satisfies AssistanceCompiler;

function realmWithEval(): { readonly realm: Record<string, unknown>; readonly evaluate: (code: string) => unknown } {
  const realm: Record<string, unknown> = {};
  Object.defineProperty(realm, "Function", { value: Function, configurable: true, writable: true });
  Object.defineProperty(realm, "eval", { value: globalThis.eval, configurable: true, writable: true });
  const evaluate = (code: string): unknown => {
    const evaluator = realm["eval"];
    if (typeof evaluator !== "function") throw new TypeError("realm lost its eval");
    return Reflect.apply(evaluator, undefined, [code]);
  };
  return { realm, evaluate };
}

it("refuses eval for the local-script profile and keeps refusing until restored", () => {
  const { realm, evaluate } = realmWithEval();
  const restore = installGeneratedFunctions(compiler, realm);
  try {
    expect(() => evaluate("2 + 3")).toThrow(/eval are not supported by the local-script profile/u);
  } finally { restore(); }
  expect(evaluate("2 + 3")).toBe(5);
});

it("keeps the realm's intrinsic eval for a profile whose bundler output evaluates module sources", () => {
  const { realm, evaluate } = realmWithEval();
  const restore = installGeneratedFunctions(compiler, realm, undefined, { eval: "native" });
  try {
    expect(evaluate("2 + 3")).toBe(5);
    expect(realm["eval"]).toBe(globalThis.eval);
    expect(realm["Function"]).not.toBe(Function);
  } finally { restore(); }
  expect(realm["Function"]).toBe(Function);
});

function constructorOf(value: unknown): (...args: unknown[]) => unknown {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (typeof prototype !== "object" || prototype === null) throw new TypeError("missing function prototype");
  const constructor: unknown = Reflect.get(prototype, "constructor");
  if (typeof constructor !== "function") throw new TypeError("missing function constructor");
  return (...args) => { const made: unknown = Reflect.apply(constructor, undefined, args); return made; };
}

it("compiles a body given to the AsyncFunction constructor, and still refuses the generator constructors", async () => {
  const { realm } = realmWithEval();
  const mapped = { ...compiler, transform: (source: string) => ({ code: source, map: JSON.stringify({ version: 3, sources: [], names: [], mappings: "" }) }) } satisfies AssistanceCompiler;
  const restore = installGeneratedFunctions(mapped, realm);
  try {
    const AsyncFunction = constructorOf(async () => { await Promise.resolve(); });
    const made: unknown = AsyncFunction("value", "return (await value) + 1;");
    if (typeof made !== "function") throw new TypeError("missing generated function");
    await expect(Reflect.apply(made, undefined, [Promise.resolve(41)])).resolves.toBe(42);
    expect(() => AsyncFunction("await")).toThrow(SyntaxError);
    const GeneratorFunction = constructorOf(function* () { yield 1; });
    expect(() => { GeneratorFunction(); }).toThrow(/not supported/u);
  } finally { restore(); }
});
