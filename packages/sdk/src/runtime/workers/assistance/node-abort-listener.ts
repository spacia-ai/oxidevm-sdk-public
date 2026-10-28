/// <reference lib="esnext.disposable" />
type Listener = (this: AbortSignal, event?: Event) => unknown;
function callable(value: unknown): value is Listener { return typeof value === "function"; }
function disposable(remove: () => void): Disposable {
  const value = { [Symbol.dispose]: remove };
  Object.setPrototypeOf(value, null);
  return value;
}

/** Node protects these listeners from stopImmediatePropagation. Keep the actual
 * browser event and subscription order inside the isolated process realm. */
export function createNodeAbortListeners() {
  const protectedListeners = new WeakMap<AbortSignal, Map<Listener, EventListener>>();
  const prototype = Event.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "stopImmediatePropagation");
  const stop: unknown = descriptor?.value;
  let active = true;
  if (descriptor === undefined || typeof stop !== "function") throw new TypeError("Missing Event.stopImmediatePropagation");
  Object.defineProperty(prototype, "stopImmediatePropagation", { ...descriptor, value(this: Event): void {
    Reflect.apply(stop, this, []);
    const target = this.currentTarget;
    if (!(target instanceof AbortSignal) || this.type !== "abort") return;
    const listeners = protectedListeners.get(target);
    if (listeners !== undefined) for (const deliver of [...listeners.values()]) deliver(this);
  } });
  return {
    addAbortListener: (signal: unknown, listener: unknown): Disposable => {
      if (!(signal instanceof AbortSignal)) throw Object.assign(new TypeError("The \"signal\" argument must be an AbortSignal"), { code: "ERR_INVALID_ARG_TYPE" });
      if (!callable(listener)) throw Object.assign(new TypeError("The \"listener\" argument must be a function"), { code: "ERR_INVALID_ARG_TYPE" });
      if (!active) throw new TypeError("Abort listener owner is retired");
      if (signal.aborted) {
        // Node 24 calls without an event and disposal cannot cancel this microtask.
        queueMicrotask(() => { Reflect.apply(listener, undefined, []); });
        return disposable(() => {});
      }
      let listeners = protectedListeners.get(signal);
      if (listeners === undefined) { listeners = new Map(); protectedListeners.set(signal, listeners); }
      const pending = listeners;
      let deliver = pending.get(listener);
      const remove = (): void => {
        const registered = pending.get(listener);
        if (registered !== undefined) { pending.delete(listener); signal.removeEventListener("abort", registered); }
      };
      if (deliver === undefined) {
        deliver = event => {
          if (!active || !pending.has(listener)) return;
          remove();
          try { Reflect.apply(listener, signal, [event]); }
          catch (error) { queueMicrotask(() => { throw error; }); }
        };
        pending.set(listener, deliver);
        signal.addEventListener("abort", deliver, { once: true });
      }
      return disposable(remove);
    },
    restore: (): void => {
      if (!active) return;
      active = false;
      Object.defineProperty(prototype, "stopImmediatePropagation", descriptor);
    },
  };
}
