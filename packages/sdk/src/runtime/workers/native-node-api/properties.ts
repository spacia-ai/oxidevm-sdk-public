import { protocol } from "../../js-process/codec.js";

const toBoolean = Boolean, toNumber = Math.max.bind(Math);
const stringIntrinsic: unknown = Reflect.get(String.prototype, "concat"), objectIntrinsic: unknown = Reflect.get(Object.prototype, "valueOf");
if (typeof stringIntrinsic !== "function" || typeof objectIntrinsic !== "function") protocol("Native coercion intrinsics are unavailable");
const toString = stringIntrinsic, toObject = objectIntrinsic;
const ordinaryInstanceOf: unknown = Reflect.get(Function.prototype, Symbol.hasInstance);
const assign = Reflect.set, apply = Reflect.apply;
export const nativeApply = apply, nativeConstruct = Reflect.construct;
const readProperty = Reflect.get, hasProperty = Reflect.has, deleteProperty = Reflect.deleteProperty;
export const nativeDefineProperty = Object.defineProperty, nativeFreeze = Object.freeze, nativeSeal = Object.seal, nativeCreateObject = Object.create;
export const nativePrototypeOf = Reflect.getPrototypeOf, nativeHasOwn = Object.hasOwn;

export function nativeGetProperty(target: object, key: unknown): unknown { return apply(readProperty, undefined, [target, key]); }
export function nativeHasProperty(target: object, key: unknown): boolean {
  const value: unknown = apply(hasProperty, undefined, [target, key]);
  if (typeof value !== "boolean") protocol("Invalid native property presence result"); return value;
}
export function nativeDeleteProperty(target: object, key: unknown): boolean {
  const value: unknown = apply(deleteProperty, undefined, [target, key]);
  if (typeof value !== "boolean") protocol("Invalid native property deletion result"); return value;
}

export function nativeSetProperty(target: object, key: unknown, value: unknown): boolean {
  const result: unknown = apply(assign, undefined, [target, key, value]);
  if (typeof result !== "boolean") protocol("Invalid native property assignment result");
  return result;
}

export function nativeNumber(value: unknown): unknown {
  // A single Math.max argument uses ToNumber, including rejection of BigInt after object coercion.
  return apply(toNumber, undefined, [value]);
}

export function nativeBoolean(value: unknown): boolean { return toBoolean(value); }
export function nativeString(value: unknown): unknown { return apply(toString, "", [value]); }
export function nativeObject(value: unknown): unknown { return apply(toObject, value, []); }

export function nativeInstanceOf(value: unknown, constructor: object): boolean {
  const method: unknown = nativeGetProperty(constructor, Symbol.hasInstance);
  if (method !== undefined && method !== null) {
    if (typeof method !== "function") throw new TypeError("Symbol.hasInstance is not callable");
    return Boolean(apply(method, constructor, [value]));
  }
  if (typeof ordinaryInstanceOf !== "function") throw new TypeError("Missing ordinary instance operation");
  return Boolean(apply(ordinaryInstanceOf, constructor, [value]));
}
