import { record } from "../../decode.js";
import type { AsyncContext } from "./async-context.js";
import type { AsyncScope } from "./async-resources.js";

interface Timer {
  ref(): Timer;
  unref(): Timer;
  hasRef(): boolean;
  refresh(): Timer;
  [Symbol.toPrimitive](): number;
}
interface Entry {
  readonly handle: Timer;
  readonly id: number;
  readonly repeat: boolean;
  readonly callback: (scope: AsyncScope) => void;
  readonly delay: number;
  native: unknown;
  referenced: boolean;
  active: boolean;
  cancelled: boolean;
  scope?: AsyncScope;
}

/** Wrap the already context-bound scheduler. Only referenced timers contribute
 * to process lifetime; their handles never escape their owning worker. */
export function createProcessTimers(target: unknown, context: AsyncContext, dispatch: (callback: () => void) => void = callback => callback()) {
  const realm = record(target, "process timers");
  const timeout = callable(realm["setTimeout"]);
  const interval = callable(realm["setInterval"]);
  const clearTimeout = callable(realm["clearTimeout"]);
  const clearInterval = callable(realm["clearInterval"]);
  const entries = new Map<number, Entry>();
  const handles = new WeakMap<object, Entry>();
  let next = 1;
  let disposed = false;
  let waiting: PromiseWithResolvers<undefined> | undefined;
  const hasReferences = () => [...entries.values()].some(entry => entry.active && entry.referenced);
  function changed(): void {
    if (!hasReferences()) { waiting?.resolve(undefined); waiting = undefined; }
  }
  function cancel(entry: Entry): void {
    if (!entry.active) return;
    Reflect.apply(entry.repeat ? clearInterval : clearTimeout, realm, [entry.native]);
    entry.scope?.destroy();
    entry.active = false;
    entries.delete(entry.id);
    changed();
  }
  function arm(entry: Entry): void {
    if (disposed) throw new Error("Process timers are disposed");
    entry.active = true;
    entries.set(entry.id, entry);
    const scope = context.resources.create("Timeout", entry.handle);
    entry.scope = scope;
    entry.native = Reflect.apply(entry.repeat ? interval : timeout, realm, [() => dispatch(() => {
      if (!entry.active || entry.scope !== scope) return;
      if (!entry.repeat) {
        entry.active = false;
        entries.delete(entry.id);
      }
      try { entry.callback(scope); } finally { if (!entry.repeat) scope.destroy(); changed(); }
    }), entry.delay]);
  }
  function schedule(repeat: boolean, callback: unknown, delay: unknown = 1, args: unknown[]): Timer {
    if (typeof callback !== "function") throw new TypeError("Timer callback must be a function");
    if (typeof delay !== "number") throw new TypeError("Only numeric timer delays are supported");
    if (next > 0xffff_ffff) throw new RangeError("Timer identity exhausted");
    const id = next++;
    const run = context.capture();
    const milliseconds = !Number.isFinite(delay) || delay < 1 || delay > 0x7fff_ffff ? 1 : Math.trunc(delay);
    const handle: Timer = {
      ref() { entry.referenced = true; return handle; },
      unref() { entry.referenced = false; changed(); return handle; },
      hasRef() { return entry.referenced; },
      refresh() { if (!entry.cancelled) { cancel(entry); arm(entry); } return handle; },
      [Symbol.toPrimitive]() { return id; },
    };
    const entry: Entry = {
      handle, id, repeat, delay: milliseconds, callback: scope => run(() => scope.run(() => { Reflect.apply(callback, handle, args); })),
      native: undefined, referenced: true, active: false, cancelled: false,
    };
    handles.set(handle, entry);
    arm(entry);
    return handle;
  }
  function clear(value: unknown): void {
    if (value === undefined || value === null) return;
    let entry: Entry | undefined;
    if (typeof value === "number" || (typeof value === "string" && String(Number(value)) === value)) entry = entries.get(Number(value));
    else if (typeof value === "object") entry = handles.get(value);
    if (entry !== undefined) { entry.cancelled = true; cancel(entry); }
  }
  return {
    setTimeout: (callback: unknown, delay?: unknown, ...args: unknown[]) => schedule(false, callback, delay, args),
    setInterval: (callback: unknown, delay?: unknown, ...args: unknown[]) => schedule(true, callback, delay, args),
    clear,
    get hasReferences() { return hasReferences(); },
    async idle(): Promise<void> {
      while (hasReferences()) { waiting ??= Promise.withResolvers<undefined>(); await waiting.promise; }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const entry of entries.values()) cancel(entry);
      changed();
    },
  };
}
function callable(value: unknown): (...args: unknown[]) => unknown {
  if (typeof value !== "function") throw new TypeError("Missing process scheduler");
  return (...args) => { const result: unknown = Reflect.apply(value, undefined, args); return result; };
}
