import { VMError } from "./errors.js";

/**
 * A Proxy registry (ADR 0026, 2.11). V8 tells a Proxy from any other object and JavaScript
 * cannot, so a process realm's `Proxy` is replaced, before application code runs, by a callable
 * proxy of the native constructor that records every proxy it or `Proxy.revocable` makes. It
 * forwards `name`, `length`, the absent `prototype`, a call without `new` and its own keys to
 * the native constructor; `Function.prototype.toString` of `Proxy` and `Proxy.revocable` is the
 * remaining difference. Proxies made before the registry, by the SDK itself, are not recorded.
 */
const apply = Reflect.apply, construct = Reflect.construct, define = Object.defineProperty;
const NativeProxy = Proxy, nativeRevocable = Proxy.revocable;
const recorded = new WeakSet<object>(), add = recorded.add.bind(recorded), has = recorded.has.bind(recorded);
let installed = 0;

function record(value: object): void { add(value); }

const revocable = new NativeProxy(nativeRevocable, {
  apply(target, receiver: unknown, args: unknown[]): unknown {
    const result: unknown = apply(target, receiver, args);
    if (typeof result === "object" && result !== null) {
      const proxy: unknown = Reflect.get(result, "proxy");
      if (typeof proxy === "object" && proxy !== null || typeof proxy === "function") record(proxy);
    }
    return result;
  },
});
const recordingProxy = new NativeProxy(NativeProxy, {
  construct(target, args: unknown[], newTarget: NewableFunction): object {
    const proxy: unknown = construct(target, args, newTarget);
    if (typeof proxy !== "object" && typeof proxy !== "function" || proxy === null) throw new VMError("PROTOCOL_ERROR", "Proxy made no object");
    record(proxy);
    return proxy;
  },
});

/** Installs the registry in `realm`; the returned function restores the native `Proxy`. */
export function installProxyRegistry(realm: typeof globalThis): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(realm, "Proxy"), own = Object.getOwnPropertyDescriptor(NativeProxy, "revocable");
  if (descriptor === undefined || own === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "This realm has no Proxy constructor");
  define(NativeProxy, "revocable", { ...own, value: revocable });
  define(realm, "Proxy", { ...descriptor, value: recordingProxy });
  installed++;
  return () => {
    installed--;
    define(realm, "Proxy", descriptor);
    define(NativeProxy, "revocable", own);
  };
}

/** Whether `value` is a proxy the registry recorded; only a realm that installed it can say. */
export function nativeIsProxy(value: unknown): boolean {
  if (installed === 0) throw new VMError("FEATURE_NOT_AVAILABLE", "The Proxy registry is not installed in this realm");
  return (typeof value === "object" && value !== null || typeof value === "function") && has(value);
}
