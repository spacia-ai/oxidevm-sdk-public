import { VMError } from "../../errors.ts";

const PLATFORM_EXPORTS = ["performance", "PerformanceObserver", "PerformanceEntry", "PerformanceMark", "PerformanceMeasure",
  "PerformanceObserverEntryList", "PerformanceResourceTiming"] as const;

function unsupported(name: string): () => never {
  return () => { throw new VMError("FEATURE_NOT_AVAILABLE", `perf_hooks.${name} is not supported`, { builtin: "perf_hooks", export: name }); };
}

/** The `perf_hooks` builtin: the platform's performance clock and observer
 * classes; Node's event-loop histograms have no platform equivalent and refuse. */
export function createNodePerfHooks(globals: unknown): Readonly<Record<string, unknown>> {
  if (typeof globals !== "object" || globals === null) throw new VMError("FEATURE_NOT_AVAILABLE", "perf_hooks requires the platform's global scope");
  const module: Record<string, unknown> = {};
  for (const name of PLATFORM_EXPORTS) {
    const value: unknown = Reflect.get(globals, name);
    if (value === undefined || value === null) {
      throw new VMError("FEATURE_NOT_AVAILABLE", `perf_hooks is unavailable: the platform lacks ${name}`, { builtin: "perf_hooks", missing: name });
    }
    module[name] = value;
  }
  module["monitorEventLoopDelay"] = unsupported("monitorEventLoopDelay");
  module["createHistogram"] = unsupported("createHistogram");
  module["constants"] = Object.freeze({ NODE_PERFORMANCE_GC_MAJOR: 4, NODE_PERFORMANCE_GC_MINOR: 1, NODE_PERFORMANCE_GC_INCREMENTAL: 8, NODE_PERFORMANCE_GC_WEAKCB: 16 });
  return Object.freeze(module);
}
