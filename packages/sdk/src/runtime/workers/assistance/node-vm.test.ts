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
});
