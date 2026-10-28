import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const runtimes = ["node", "bun"] as const;
function fixture(runtime: "node" | "bun") {
  const seen: unknown[] = [];
  const values = new NativeValues((_callback, receiver) => { seen.push(receiver); }, () => undefined, () => undefined, 0, () => undefined,
    { runtime, claim: () => undefined, retire: () => undefined });
  const result = values.dispatch("napi_create_function", [4103n], new TextEncoder().encode("inspect"));
  expect(result.status).toBe(0);
  const handle = result.args[0]; if (handle === undefined) throw new Error("Missing callback handle");
  const fn = values.get(handle); if (typeof fn !== "function") throw new Error("Missing callback");
  return { values, seen, fn };
}

it.each(runtimes)("uses the realm global and fresh primitive receivers for %s callbacks", runtime => {
  const { values, seen, fn } = fixture(runtime), target = {};
  for (const receiver of [undefined, null, 17, "value", true, Symbol("value"), 17n, target]) {
    Reflect.apply(fn, receiver, []);
    const actual = seen.at(-1);
    if (receiver === undefined || receiver === null) expect(actual).toBe(globalThis);
    else if (receiver === target) expect(actual).toBe(target);
    else {
      if (typeof actual !== "object" || actual === null) throw new Error("A primitive receiver must be boxed");
      expect(Object.getPrototypeOf(actual)).toBe(Object.getPrototypeOf(Object(receiver)));
    }
  }
  Reflect.apply(fn, 17, []); const first = seen.at(-1);
  Reflect.apply(fn, 17, []); expect(seen.at(-1)).not.toBe(first);
  values.dispose();
});

it.each(runtimes)("preserves %s receiver identity without Proxy traps", runtime => {
  const { values, seen, fn } = fixture(runtime); let traps = 0;
  const trap = (): never => { traps++; throw new Error("Receiver trap"); };
  const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const receiver of [proxy, revoked.proxy, function receiver() {}]) {
    Reflect.apply(fn, receiver, []); expect(seen.at(-1)).toBe(receiver);
  }
  expect(traps).toBe(0); values.dispose();
});

it.each(runtimes)("does not read mutable globalThis or Object for %s receiver conversion", runtime => {
  const { values, seen, fn } = fixture(runtime), root = globalThis, define = Object.defineProperty;
  const globalDescriptor = Object.getOwnPropertyDescriptor(root, "globalThis"), objectDescriptor = Object.getOwnPropertyDescriptor(root, "Object");
  if (globalDescriptor === undefined || objectDescriptor === undefined) throw new Error("Missing global intrinsics");
  let traps = 0, error: unknown;
  const getter = (): never => { traps++; throw new Error("Application global getter"); };
  try {
    define(root, "globalThis", { configurable: true, get: getter });
    define(root, "Object", { configurable: true, get: getter });
    Reflect.apply(fn, undefined, []); Reflect.apply(fn, null, []); Reflect.apply(fn, 17, []);
  } catch (caught) { error = caught; }
  finally { define(root, "globalThis", globalDescriptor); define(root, "Object", objectDescriptor); }
  expect(error).toBeUndefined(); expect(traps).toBe(0);
  expect(seen[0]).toBe(root); expect(seen[1]).toBe(root);
  const boxed = seen[2]; if (typeof boxed !== "object" || boxed === null) throw new Error("Missing boxed receiver");
  expect(Object.getPrototypeOf(boxed)).toBe(Number.prototype);
  values.dispose();
});
