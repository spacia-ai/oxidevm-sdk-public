import { describe, expect, it } from "vitest";
import { createNodePerfHooks } from "./node-perf-hooks.js";

describe("node perf_hooks builtin", () => {
  it("exposes the platform performance clock and observer classes", () => {
    const module = createNodePerfHooks(globalThis);
    expect(module["performance"]).toBe(globalThis.performance);
    expect(module["PerformanceObserver"]).toBe(globalThis.PerformanceObserver);
    expect(module["PerformanceEntry"]).toBe(globalThis.PerformanceEntry);
    expect(typeof Reflect.get(module["performance"] ?? {}, "now")).toBe("function");
  });

  it("refuses the histogram facilities explicitly instead of returning fakes", () => {
    const module = createNodePerfHooks(globalThis);
    const monitor = module["monitorEventLoopDelay"];
    expect(typeof monitor).toBe("function");
    if (typeof monitor === "function") expect(() => { Reflect.apply(monitor, undefined, []); }).toThrow(/monitorEventLoopDelay/u);
  });
});
