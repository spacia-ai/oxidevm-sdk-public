import { expect, it } from "vitest";
import type { AssistanceCompiler } from "./compiler.js";
import { installGeneratedFunctions } from "./generated-functions.js";

/** The realm's Function goes through the transforming compiler either way; only
 * the eval policy differs by profile. */
const compiler = {
  transform: (source: string) => ({ code: source, map: "" }),
  hasDynamicImport: () => false,
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
