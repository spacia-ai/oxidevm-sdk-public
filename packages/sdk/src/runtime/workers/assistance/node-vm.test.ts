import { describe, expect, it } from "vitest";
import { createNodeVm, realmEvaluator } from "./node-vm.js";

describe("node vm builtin", () => {
  it("runs scripts in this realm and refuses separate contexts explicitly", () => {
    const vm = createNodeVm(realmEvaluator());
    expect(vm.runInThisContext("1 + 2")).toBe(3);
    const script = new vm.Script("40 + 2", { filename: "answer.js" });
    expect(script.runInThisContext()).toBe(42);
    expect(vm.isContext({})).toBe(false);
    expect(() => vm.createContext({})).toThrow(/createContext/u);
    expect(() => vm.runInNewContext("1", {})).toThrow(/runInNewContext/u);
    expect(() => script.runInNewContext({})).toThrow(/runInNewContext/u);
  });

  it("serves data contexts through the bounded evaluator when the runtime supplies one", () => {
    const seen: unknown[][] = [];
    const vm = createNodeVm(realmEvaluator(), (source, context, filename) => { seen.push([source, context, filename]); return 7; });
    const context = vm.createContext(undefined, { name: "Webpack Magic Comment Parser", codeGeneration: { strings: false, wasm: false } });
    expect(vm.isContext(context)).toBe(true);
    expect(vm.isContext({})).toBe(false);
    expect(vm.runInContext("(function(){return {};})()", context)).toBe(7);
    expect(new vm.Script("1", { filename: "one.js" }).runInContext(context)).toBe(7);
    expect(seen).toEqual([["(function(){return {};})()", context, "evalmachine.<anonymous>"], ["1", context, "one.js"]]);
    const own = { value: 1 };
    expect(vm.createContext(own)).toBe(own);
    expect(() => vm.runInContext("1", {})).toThrow(TypeError);
    expect(() => vm.createContext("text")).toThrow(TypeError);
    for (const options of [{ microtaskMode: "afterEvaluate" }, { codeGeneration: { strings: true } }, { importModuleDynamically: () => undefined }, "name"]) {
      expect(() => vm.createContext({}, options)).toThrow(/createContext options/u);
    }
    expect(() => vm.runInContext("1", context, { timeout: 5 })).toThrow(/runInContext options/u);
  });
});
