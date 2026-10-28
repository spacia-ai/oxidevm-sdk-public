import { VMError } from "./errors.js";

const apply = Reflect.apply;
const descriptor = Object.getOwnPropertyDescriptor(Error, "isError");
const intrinsic: unknown = descriptor !== undefined && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
const domDescriptor = Object.getOwnPropertyDescriptor(DOMException.prototype, "name");
const domName: unknown = domDescriptor === undefined ? undefined : Reflect.get(domDescriptor, "get");
type NativePredicate = (value: unknown) => unknown;
function callable(value: unknown): value is NativePredicate { return typeof value === "function"; }
type Predicate = { readonly kind: "available"; readonly invoke: NativePredicate; readonly domName: NativePredicate; readonly includesDOM: boolean }
  | { readonly kind: "unavailable" | "invalid" };

// Capture before application code. Pinned Node includes DOMException; pinned Bun does not.
function capture(): Predicate {
  if (!callable(intrinsic) || !callable(domName)) return { kind: "unavailable" };
  try {
    const dom = new DOMException("native Error capability");
    const includesDOM: unknown = apply(intrinsic, undefined, [dom]), name: unknown = apply(domName, dom, []);
    if (typeof includesDOM !== "boolean" || typeof name !== "string") return { kind: "invalid" };
    return { kind: "available", invoke: intrinsic, domName, includesDOM };
  } catch { return { kind: "invalid" }; }
}
const predicate = capture();
export const nativeErrorCapability: 0 | 2 = predicate.kind === "available" ? 2 : 0;

export function nativeIsError(value: unknown, runtime: "node" | "bun"): boolean {
  if (predicate.kind === "unavailable") throw new VMError("FEATURE_NOT_AVAILABLE", "Native Error predicate is unavailable", { api: "napi_is_error" });
  if (predicate.kind !== "available") throw new VMError("PROTOCOL_ERROR", "Invalid native Error capability");
  let result: unknown;
  try { result = apply(predicate.invoke, undefined, [value]); }
  catch { throw new VMError("PROTOCOL_ERROR", "Native Error predicate failed"); }
  if (typeof result !== "boolean") throw new VMError("PROTOCOL_ERROR", "Invalid native Error predicate result");
  const includesDOM = runtime === "node";
  if (predicate.includesDOM === includesDOM || result === includesDOM) return result;
  let name: unknown;
  // WebIDL's captured getter checks the DOM brand, including foreign realms, without reading input properties.
  try { name = apply(predicate.domName, value, []); }
  catch { return result; }
  if (typeof name !== "string") throw new VMError("PROTOCOL_ERROR", "Invalid native DOMException brand result");
  return includesDOM;
}
