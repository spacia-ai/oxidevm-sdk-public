import { VMError } from "../../errors.js";
export { nativeIsPromise } from "../../promise-brand.js";
export { nativeIsError } from "../../error-brand.js";

const apply = Reflect.apply, prototypeOf = Reflect.getPrototypeOf, typeErrorPrototype = TypeError.prototype;
const isView = ArrayBuffer.isView.bind(ArrayBuffer);
const arrayBufferLength = getter(ArrayBuffer.prototype, "byteLength");
const arrayBufferDetached = getter(ArrayBuffer.prototype, "detached");
const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = typedArrayPrototype === null ? undefined : getter(typedArrayPrototype, Symbol.toStringTag);
type Query = "napi_is_arraybuffer" | "napi_is_dataview" | "napi_is_detached_arraybuffer" | "napi_is_typedarray";

function getter(prototype: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
  return descriptor === undefined ? undefined : Reflect.get(descriptor, "get");
}

function readIntrinsic(value: unknown, getter: unknown, api: Query): unknown {
  if (typeof getter !== "function") throw new VMError("FEATURE_NOT_AVAILABLE", "Native value query intrinsic is unavailable", { api });
  try { const result: unknown = apply(getter, value, []); return result; }
  catch (error) {
    // A failed internal-slot check must not inspect application-controlled error properties.
    if (typeof error === "object" && error !== null && prototypeOf(error) === typeErrorPrototype) return undefined;
    throw error;
  }
}

export function nativeIsArrayBuffer(value: unknown): boolean {
  return typeof readIntrinsic(value, arrayBufferLength, "napi_is_arraybuffer") === "number";
}
export function nativeIsDataView(value: unknown): boolean {
  return isView(value) && readIntrinsic(value, typedArrayTag, "napi_is_dataview") === undefined;
}
export function nativeIsDetachedArrayBuffer(value: unknown): boolean {
  return readIntrinsic(value, arrayBufferDetached, "napi_is_detached_arraybuffer") === true;
}
export function nativeIsTypedArray(value: unknown): boolean {
  return typeof readIntrinsic(value, typedArrayTag, "napi_is_typedarray") === "string";
}
