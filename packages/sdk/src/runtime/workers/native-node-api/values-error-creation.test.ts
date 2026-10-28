import { expect, it } from "vitest";
import { NativeValues, type NativeResult } from "./values.js";
import { NapiFailure } from "./errors.js";
import { VMError } from "../../errors.js";

const empty = new Uint8Array();
const operations = [
  ["napi_create_error", "Error", Error],
  ["napi_create_type_error", "TypeError", TypeError],
  ["napi_create_range_error", "RangeError", RangeError],
  ["node_api_create_syntax_error", "SyntaxError", SyntaxError],
] as const;
function fixture(runtime: "node" | "bun" = "node") { return new NativeValues(() => undefined, () => undefined, undefined, 0, undefined, { runtime, claim: () => undefined, retire: () => undefined }); }
function created(values: NativeValues, result: NativeResult): unknown {
  const handle = result.args[0];
  if (result.status !== 0 || handle === undefined) throw new Error("Missing created error");
  return values.get(handle);
}

it("uses intrinsic error constructors after application code replaces the globals", () => {
  for (const [operation, name, constructor] of operations) {
    const values = fixture(), message = values.add("native message");
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    if (descriptor === undefined) throw new Error("Missing intrinsic constructor descriptor");
    let calls = 0, result: NativeResult;
    Object.defineProperty(globalThis, name, { configurable: true, value: class Replaced { readonly replacement = true; constructor() { calls++; } } });
    try { result = values.dispatch(operation, [0n, message], empty); }
    finally { Object.defineProperty(globalThis, name, descriptor); }
    expect(calls).toBe(0);
    expect(created(values, result)).toBeInstanceOf(constructor);
    expect(Object.getPrototypeOf(created(values, result))).toBe(constructor.prototype);
    expect(created(values, result)).toMatchObject({ message: "native message" });
    values.dispose();
  }
});

it("distinguishes a NULL code argument from a handle containing undefined", () => {
  for (const [operation] of operations) {
    const values = fixture(), message = values.add("native message");
    for (const code of [undefined, null, 0, Symbol("code"), Object("code")]) {
      const result = values.dispatch(operation, [values.add(code), message], empty);
      expect(result.status).toBe(3);
      expect(result.args).toEqual([]);
      expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([0n]);
    }
    expect(values.dispatch(operation, [0n, message], empty).status).toBe(0);
    values.dispose();
  }
});

it("uses inherited code setters and preserves their receiver and ordinary assignment attributes", () => {
  for (const [operation, , constructor] of operations) {
    const values = fixture(), code = values.add("ERR_NATIVE"), message = values.add("native message");
    const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, "code");
    const effects: { readonly receiver: unknown; readonly value: unknown }[] = [];
    let result: NativeResult;
    Object.defineProperty(constructor.prototype, "code", { configurable: true, set(this: unknown, value: unknown) { effects.push({ receiver: this, value }); } });
    try { result = values.dispatch(operation, [code, message], empty); }
    finally {
      if (descriptor === undefined) Reflect.deleteProperty(constructor.prototype, "code");
      else Object.defineProperty(constructor.prototype, "code", descriptor);
    }
    const error = created(values, result);
    expect(effects).toEqual([{ receiver: error, value: "ERR_NATIVE" }]);
    expect(Object.getOwnPropertyDescriptor(error, "code")).toBeUndefined();
    const ordinary = created(values, values.dispatch(operation, [code, message], empty));
    expect(Object.getOwnPropertyDescriptor(ordinary, "code")).toEqual({ value: "ERR_NATIVE", writable: true, enumerable: true, configurable: true });
    values.dispose();
  }
});

it("silently retains inherited read-only and getter-only code properties like the pinned V8 assignment", () => {
  for (const [operation, , constructor] of operations) {
    for (const property of [{ value: "inherited", writable: false }, { get() { return "inherited"; } }]) {
      const values = fixture(), descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, "code");
      let result: NativeResult;
      Object.defineProperty(constructor.prototype, "code", { configurable: true, ...property });
      try { result = values.dispatch(operation, [values.add("ERR_NATIVE"), values.add("native message")], empty); }
      finally {
        if (descriptor === undefined) Reflect.deleteProperty(constructor.prototype, "code");
        else Object.defineProperty(constructor.prototype, "code", descriptor);
      }
      expect(result.status).toBe(0);
      expect(Object.getOwnPropertyDescriptor(created(values, result), "code")).toBeUndefined();
      values.dispose();
    }
  }
});

it("returns generic failure for throwing code setters and retains the environment's pending exception", () => {
  for (const [operation, , constructor] of operations) {
    for (const pending of [false, true]) {
      const values = fixture(), marker: unknown = Symbol("setter failure"), original = values.add(null);
      if (pending) values.dispatch("napi_throw", [original], empty);
      const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, "code");
      let calls = 0, result: NativeResult;
      Object.defineProperty(constructor.prototype, "code", { configurable: true, set() { calls++; throw marker; } });
      try { result = values.dispatch(operation, [values.add("ERR_NATIVE"), values.add("native message")], empty); }
      finally {
        if (descriptor === undefined) Reflect.deleteProperty(constructor.prototype, "code");
        else Object.defineProperty(constructor.prototype, "code", descriptor);
      }
      expect(calls).toBe(1);
      expect(result.status).toBe(9);
      expect(result.args).toEqual([]);
      expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([pending ? 1n : 0n]);
      expect(created(values, values.dispatch("napi_get_and_clear_last_exception", [], empty))).toBe(pending ? null : undefined);
      values.dispose();
    }
  }
});

it("uses the same captured assignment for native throw errors", () => {
  const setters: unknown[] = [], values = fixture();
  const descriptor = Object.getOwnPropertyDescriptor(Error.prototype, "code");
  let result: NativeResult;
  Object.defineProperty(Error.prototype, "code", { configurable: true, set(value: unknown) { setters.push(value); } });
  try { result = values.dispatch("napi_throw_error", [7n, 1n], new TextEncoder().encode("E_TEST\0native message")); }
  finally {
    if (descriptor === undefined) Reflect.deleteProperty(Error.prototype, "code");
    else Object.defineProperty(Error.prototype, "code", descriptor);
  }
  expect(result.status).toBe(0);
  expect(setters).toEqual(["E_TEST"]);
  expect(created(values, values.dispatch("napi_get_and_clear_last_exception", [], empty))).toMatchObject({ message: "native message" });
  values.dispose();
});

it("preserves code-setter exceptions when Error.hasInstance is an application getter", () => {
  const values = fixture(), marker = new Error("code setter"), text = new TextEncoder().encode("E_TEST\0native message");
  const codeDescriptor = Object.getOwnPropertyDescriptor(Error.prototype, "code");
  const instanceDescriptor = Object.getOwnPropertyDescriptor(Error, Symbol.hasInstance);
  let getters = 0, result: NativeResult;
  Object.defineProperty(Error.prototype, "code", { configurable: true, set() { throw marker; } });
  Object.defineProperty(Error, Symbol.hasInstance, { configurable: true, get() { getters++; throw marker; } });
  try { result = values.dispatch("napi_throw_error", [7n, 1n], text); }
  finally {
    if (codeDescriptor === undefined) Reflect.deleteProperty(Error.prototype, "code");
    else Object.defineProperty(Error.prototype, "code", codeDescriptor);
    if (instanceDescriptor === undefined) Reflect.deleteProperty(Error, Symbol.hasInstance);
    else Object.defineProperty(Error, Symbol.hasInstance, instanceDescriptor);
  }
  expect(result).toMatchObject({ status: 9, args: [], bytes: empty });
  expect(created(values, values.dispatch("napi_get_and_clear_last_exception", [], empty))).toBe(marker);
  expect(getters).toBe(0);
  values.dispose();
});

it("preserves arbitrary setter exceptions through preamble calls without treating them as transport failures", () => {
  const markers: readonly unknown[] = [undefined, null, new NapiFailure(7), new VMError("PROTOCOL_ERROR", "application exception")];
  for (const marker of markers) {
    for (const operation of ["napi_throw_error", "napi_instanceof"] as const) {
      const values = fixture(), constructor = operation === "napi_instanceof" ? TypeError : Error;
      const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, "code");
      let result: NativeResult;
      Object.defineProperty(constructor.prototype, "code", { configurable: true, set() { throw marker; } });
      try {
        result = operation === "napi_instanceof"
          ? values.dispatch(operation, [values.add({}), values.add(0)], empty)
          : values.dispatch(operation, [7n, 1n], new TextEncoder().encode("E_TEST\0native message"));
      } finally {
        if (descriptor === undefined) Reflect.deleteProperty(constructor.prototype, "code");
        else Object.defineProperty(constructor.prototype, "code", descriptor);
      }
      expect(result.status).toBe(operation === "napi_instanceof" ? 5 : 9);
      expect(values.dispatch("napi_is_exception_pending", [], empty).args).toEqual([1n]);
      expect(created(values, values.dispatch("napi_get_and_clear_last_exception", [], empty))).toBe(marker);
      values.dispose();
    }
  }
});

it("captures Reflect.set before application replacement", () => {
  const values = fixture(), descriptor = Object.getOwnPropertyDescriptor(Reflect, "set");
  if (descriptor === undefined) throw new Error("Missing intrinsic assignment descriptor");
  let calls = 0, result: NativeResult;
  Object.defineProperty(Reflect, "set", { configurable: true, value() { calls++; throw new Error("application replacement"); } });
  try { result = values.dispatch("napi_create_error", [values.add("E_TEST"), values.add("native message")], empty); }
  finally { Object.defineProperty(Reflect, "set", descriptor); }
  expect(calls).toBe(0);
  expect(created(values, result)).toMatchObject({ code: "E_TEST", message: "native message" });
  values.dispose();
});

it("preserves pinned Bun direct code properties without calling inherited setters", () => {
  for (const [operation, , constructor] of operations) {
    const values = fixture("bun"), descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, "code");
    let calls = 0, result: NativeResult;
    Object.defineProperty(constructor.prototype, "code", { configurable: true, set() { calls++; throw new Error("unexpected Bun setter"); } });
    try { result = values.dispatch(operation, [values.add("E_TEST"), values.add("native message")], empty); }
    finally {
      if (descriptor === undefined) Reflect.deleteProperty(constructor.prototype, "code");
      else Object.defineProperty(constructor.prototype, "code", descriptor);
    }
    expect(calls).toBe(0);
    expect(Object.getOwnPropertyDescriptor(created(values, result), "code")).toEqual({ value: "E_TEST", writable: true, enumerable: true, configurable: true });
    values.dispose();
  }
});
