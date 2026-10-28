import { VMError } from "../../errors.ts";
import type { AsyncContext } from "./async-context.js";
import type { ProcessScheduler } from "./process-scheduler.js";
import type { Writable } from "./node-streams.js";

export interface WorkerThreadProcess {
  readonly env: Readonly<Record<string, string>>;
  readonly execArgv: readonly string[];
  readonly stdout: Writable;
  readonly stderr: Writable;
  cwd(): string;
}
export interface WorkerThreadRuntime {
  readonly module: Readonly<Record<string, unknown>>;
  readonly hasPending: boolean;
  idle(): Promise<void>;
  dispose(): void;
}
export type WorkerThreadFactory = (context: AsyncContext, scheduler: ProcessScheduler, process: WorkerThreadProcess) => WorkerThreadRuntime;

/** The `worker_threads` builtin for the assisted process, which is always a
 * main thread: thread identity, the platform's message ports and the marking
 * helpers are real; constructing a `Worker` is refused explicitly. */
export function createNodeWorkerThreads(globals: unknown): Readonly<Record<string, unknown>> {
  if (typeof globals !== "object" || globals === null) throw new VMError("FEATURE_NOT_AVAILABLE", "worker_threads requires the platform's global scope");
  const port = (name: string): unknown => {
    const value: unknown = Reflect.get(globals, name);
    if (typeof value !== "function") throw new VMError("FEATURE_NOT_AVAILABLE", `worker_threads is unavailable: the platform lacks ${name}`, { builtin: "worker_threads", missing: name });
    return value;
  };
  const environmentData = new Map<unknown, unknown>();
  const untransferable = new WeakSet<object>();
  const refuseWorker = (): never => {
    throw new VMError("FEATURE_NOT_AVAILABLE", "worker_threads Worker is not supported in the assisted process", { builtin: "worker_threads", export: "Worker" });
  };
  class Worker {
    constructor() { refuseWorker(); }
    postMessage(): never { return refuseWorker(); }
    terminate(): never { return refuseWorker(); }
  }
  const unsupported = (name: string) => (): never => {
    throw new VMError("FEATURE_NOT_AVAILABLE", `worker_threads.${name} is not supported`, { builtin: "worker_threads", export: name });
  };
  return Object.freeze({
    isMainThread: true, threadId: 0, parentPort: null, workerData: null, resourceLimits: Object.freeze({}), SHARE_ENV: Symbol("nodejs.worker_threads.SHARE_ENV"),
    MessageChannel: port("MessageChannel"), MessagePort: port("MessagePort"), BroadcastChannel: port("BroadcastChannel"), Worker,
    markAsUncloneable: (): undefined => undefined,
    markAsUntransferable: (value: unknown): undefined => { if (typeof value === "object" && value !== null) untransferable.add(value); return undefined; },
    isMarkedAsUntransferable: (value: unknown): boolean => typeof value === "object" && value !== null && untransferable.has(value),
    getEnvironmentData: (key: unknown): unknown => environmentData.get(key),
    setEnvironmentData: (key: unknown, value?: unknown): undefined => { if (value === undefined) environmentData.delete(key); else environmentData.set(key, value); return undefined; },
    moveMessagePortToContext: unsupported("moveMessagePortToContext"), receiveMessageOnPort: unsupported("receiveMessageOnPort"),
    postMessageToThread: unsupported("postMessageToThread"),
  });
}
