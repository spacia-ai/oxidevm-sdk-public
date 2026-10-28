import type Emitter from "events/";
import type { NodeAsyncHooks } from "./node-async-hooks.js";
import { createEventEmitterAsyncResource } from "./node-event-resource.js";
import { createNodeAbortListeners } from "./node-abort-listener.js";
import { unavailableNodeApi } from "./node-capability.js";

/** Node's `events` builtin is the EventEmitter class; the vendored emitter
 * lacks the listener inspection statics undici and Next consult. Platform
 * event targets never expose their listeners, and Node's listener limit is a
 * warning threshold, so those answer an empty list and accept a limit. */
interface EmitterLike {
  listeners(name: string | symbol): unknown[];
  getMaxListeners(): number;
  setMaxListeners(count: number): unknown;
}

function isEmitter(value: unknown): value is EmitterLike {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "listeners") === "function"
    && typeof Reflect.get(value, "getMaxListeners") === "function" && typeof Reflect.get(value, "setMaxListeners") === "function";
}

function isEventTarget(value: unknown): boolean {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "addEventListener") === "function";
}

function invalid(): never {
  throw Object.assign(new TypeError("The \"emitter\" argument must be an instance of EventEmitter or EventTarget"), { code: "ERR_INVALID_ARG_TYPE" });
}

export function createNodeEvents(EventEmitter: typeof Emitter, hooks: NodeAsyncHooks) {
  const aborts = createNodeAbortListeners();
  const defaultMaxListeners = (): number => { const value: unknown = Reflect.get(EventEmitter, "defaultMaxListeners"); return typeof value === "number" ? value : 10; };
  const statics = {
    EventEmitter,
    addAbortListener: aborts.addAbortListener,
    on: () => unavailableNodeApi("events.on"),
    EventEmitterAsyncResource: createEventEmitterAsyncResource(EventEmitter, hooks),
    getEventListeners(target: unknown, name: string | symbol): unknown[] {
      if (isEmitter(target)) return target.listeners(name);
      if (isEventTarget(target)) return [];
      return invalid();
    },
    getMaxListeners(target: unknown): number {
      if (isEmitter(target)) return target.getMaxListeners();
      if (isEventTarget(target)) return defaultMaxListeners();
      return invalid();
    },
    setMaxListeners(count: unknown, ...targets: unknown[]): void {
      if (typeof count !== "number" || Number.isNaN(count) || count < 0) throw Object.assign(new RangeError("The value of \"n\" is out of range"), { code: "ERR_OUT_OF_RANGE" });
      if (targets.length === 0) { Reflect.set(EventEmitter, "defaultMaxListeners", count); return; }
      for (const target of targets) {
        if (isEmitter(target)) target.setMaxListeners(count);
        else if (!isEventTarget(target)) invalid();
      }
    },
  };
  for (const [name, value] of Object.entries(statics)) {
    const existing: unknown = Reflect.get(EventEmitter, name);
    if (existing === undefined) Object.defineProperty(EventEmitter, name, { value, configurable: true, writable: true, enumerable: true });
  }
  // The class now carries the statics; read them back through a checked view
  // instead of asserting the augmented type.
  const augmented: unknown = EventEmitter;
  if (typeof augmented !== "function" || typeof Reflect.get(augmented, "getEventListeners") !== "function") {
    throw new TypeError("EventEmitter statics were not installed");
  }
  return { module: Object.assign(EventEmitter, statics), restore: aborts.restore };
}
