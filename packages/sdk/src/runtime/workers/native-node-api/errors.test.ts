import { expect, it } from "vitest";
import { NapiFailure, NativeErrorCodeFailure } from "./errors.js";

it("recognizes only owned status failures without inspecting application objects", () => {
  const status = new NapiFailure(18), marker = new Error("application trap"), code = new NativeErrorCodeFailure(marker);
  let traps = 0;
  const handler = { get() { traps++; throw marker; }, getPrototypeOf() { traps++; throw marker; }, has() { traps++; throw marker; } };
  const revoked = Proxy.revocable(status, handler); revoked.revoke();
  const inputs: readonly unknown[] = [status, code, Object.create(NapiFailure.prototype), Object.create(NativeErrorCodeFailure.prototype), new Proxy(status, handler), revoked.proxy, {}, null, undefined, 18];
  const descriptor = Object.getOwnPropertyDescriptor(Error, Symbol.hasInstance);
  let result: readonly (readonly boolean[])[];
  Object.defineProperty(Error, Symbol.hasInstance, { configurable: true, get() { traps++; throw marker; } });
  try { result = inputs.map((input) => [NapiFailure.is(input), NativeErrorCodeFailure.is(input)]); }
  finally {
    if (descriptor === undefined) Reflect.deleteProperty(Error, Symbol.hasInstance);
    else Object.defineProperty(Error, Symbol.hasInstance, descriptor);
  }
  expect(result).toEqual(inputs.map((_, index) => [index < 2, index === 1]));
  expect(status.status).toBe(18);
  expect(code.status).toBe(9);
  expect(code.exception).toBe(marker);
  expect(traps).toBe(0);
});

it("formats owned numeric statuses without reading the application String constructor", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "String"), marker = new Error("application String getter");
  if (descriptor === undefined) throw new Error("Missing String descriptor");
  let getters = 0, failure: NapiFailure | undefined, escaped = false;
  Object.defineProperty(globalThis, "String", { configurable: true, get() { getters++; throw marker; } });
  try { failure = new NapiFailure(18); }
  catch { escaped = true; }
  finally { Object.defineProperty(globalThis, "String", descriptor); }
  expect({ getters, escaped, status: failure?.status, message: failure?.message }).toEqual({ getters: 0, escaped: false, status: 18, message: "Node-API status 18" });
});
