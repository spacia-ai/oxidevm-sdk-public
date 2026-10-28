import { VMError } from "./errors.js";

const apply = Reflect.apply;
const descriptor = Object.getOwnPropertyDescriptor(Promise, "isPromise");
const intrinsic: unknown = descriptor !== undefined && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
type NativePredicate = (value: unknown) => unknown;
function callable(value: unknown): value is NativePredicate { return typeof value === "function"; }
type Predicate = { readonly kind: "available"; readonly invoke: NativePredicate } | { readonly kind: "unavailable" };
// The authenticated worker bootstrap runs before application modules or polyfills.
const predicate: Predicate = callable(intrinsic) ? { kind: "available", invoke: intrinsic } : { kind: "unavailable" };
export const nativePromiseCapability: 0 | 1 = predicate.kind === "available" ? 1 : 0;

export function nativeIsPromise(value: unknown): boolean {
  if (predicate.kind === "unavailable") throw new VMError("FEATURE_NOT_AVAILABLE", "Native Promise predicate is unavailable", { api: "napi_is_promise" });
  let result: unknown;
  try { result = apply(predicate.invoke, undefined, [value]); }
  catch { throw new VMError("PROTOCOL_ERROR", "Native Promise predicate failed"); }
  if (typeof result !== "boolean") throw new VMError("PROTOCOL_ERROR", "Invalid native Promise predicate result");
  return result;
}
