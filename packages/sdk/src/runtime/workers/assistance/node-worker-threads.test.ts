import { describe, expect, it } from "vitest";
import { createNodeWorkerThreads } from "./node-worker-threads.js";

describe("node worker_threads builtin", () => {
  it("describes the main thread and hands out the platform's message ports", () => {
    const module = createNodeWorkerThreads(globalThis);
    expect(module["isMainThread"]).toBe(true);
    expect(module["threadId"]).toBe(0);
    expect(module["parentPort"]).toBeNull();
    expect(module["MessageChannel"]).toBe(globalThis.MessageChannel);
    expect(module["MessagePort"]).toBe(globalThis.MessagePort);
    const mark = module["markAsUncloneable"];
    expect(typeof mark).toBe("function");
    if (typeof mark === "function") { const marked: unknown = Reflect.apply(mark, undefined, [{}]); expect(marked).toBeUndefined(); }
  });

  it("refuses to construct a Worker with a stable typed error", () => {
    const module = createNodeWorkerThreads(globalThis);
    const Worker = module["Worker"];
    expect(typeof Worker).toBe("function");
    if (typeof Worker === "function") expect(() => { Reflect.construct(Worker, ["./worker.js"]); }).toThrow(/Worker is not supported/u);
  });
});
