import { VMError } from "../../errors.js";
import { integer } from "../../decode.js";
import { protocol } from "../../js-process/codec.js";
import { createNativeError, NapiFailure, NativeErrorCodeFailure } from "./errors.js";
import { nativeIntrinsicGetter, nativeIsArrayBuffer, nativeIsDataView, nativeIsSharedArrayBuffer } from "./value-brands.js";

/*
 * The typed-array, DataView and ArrayBuffer operations of operation set 2 (engine ADR 0026, practical profile), as
 * pinned Node 24.18.1 answers them (js_native_api_v8.cc). Their bytes live in NativeBuffers like a Buffer's.
 */
const apply = Reflect.apply, BigInt = globalThis.BigInt, Number = globalThis.Number, NativeDataView = DataView;
const viewBuffer = nativeIntrinsicGetter(NativeDataView.prototype, "buffer");
const viewOffset = nativeIntrinsicGetter(NativeDataView.prototype, "byteOffset");
const viewLength = nativeIntrinsicGetter(NativeDataView.prototype, "byteLength");
const transfer: unknown = Reflect.get(ArrayBuffer.prototype, "transfer");
const float16: unknown = Reflect.get(globalThis, "Float16Array");
type TypedArrayConstructor = new (buffer: ArrayBuffer, byteOffset: number, length: number) => ArrayBufferView;
function constructor(value: unknown): value is TypedArrayConstructor { return typeof value === "function"; }
// napi_typedarray_type order; Float16Array (11) exists only in newer browsers.
export const nativeTypedArrayTypes: readonly (readonly [name: string, size: number, type: unknown])[] = [
  ["Int8Array", 1, Int8Array], ["Uint8Array", 1, Uint8Array], ["Uint8ClampedArray", 1, Uint8ClampedArray], ["Int16Array", 2, Int16Array], ["Uint16Array", 2, Uint16Array],
  ["Int32Array", 4, Int32Array], ["Uint32Array", 4, Uint32Array], ["Float32Array", 4, Float32Array], ["Float64Array", 8, Float64Array],
  ["BigInt64Array", 8, BigInt64Array], ["BigUint64Array", 8, BigUint64Array], ["Float16Array", 2, float16],
];

/** The current guest bridge validates copied native buffers as element kinds 0–10. */
export function nativeTypedArrayKind(type: number, operation: "napi_create_typedarray" | "napi_get_typedarray_info") {
  if (type === 11) throw new VMError("FEATURE_NOT_AVAILABLE", "Float16Array native buffers are unsupported by the current guest bridge", { lateFailure: "unsupported-node-api", subject: operation });
  return nativeTypedArrayTypes[type];
}

/** Whether `operation` is one of the requests operation set 2 adds; an earlier host forwards the name only to have it refused. */
export function nativeSetTwoOperation(operation: string): boolean {
  switch (operation) {
    case "napi_get_arraybuffer_info": case "napi_get_dataview_info": case "napi_detach_arraybuffer": case "napi_create_typedarray": case "napi_create_dataview": return true;
    default: return false;
  }
}
function isArrayBuffer(value: unknown): value is ArrayBuffer { return nativeIsArrayBuffer(value); }
function isDataView(value: unknown): value is DataView { return nativeIsDataView(value); }
function unsigned(value: bigint | undefined): bigint { if (value === undefined || value < 0n) protocol("Missing native ArrayBuffer argument"); return value; }
/** Node accepts a SharedArrayBuffer here; bytes shared with other threads cannot be handed over at call boundaries. */
function arrayBuffer(value: unknown, operation: string): ArrayBuffer {
  if (isArrayBuffer(value)) return value;
  if (nativeIsSharedArrayBuffer(value)) throw new VMError("FEATURE_NOT_AVAILABLE", `${operation} on a SharedArrayBuffer is unsupported`, { lateFailure: "unsupported-node-api", subject: operation });
  throw new NapiFailure(1);
}
/** napi_get_arraybuffer_info's subject, or napi_invalid_arg. */
export function nativeArrayBuffer(value: unknown): ArrayBuffer { return arrayBuffer(value, "napi_get_arraybuffer_info"); }
function dataViewProperty(value: DataView, getter: unknown): unknown {
  if (typeof getter !== "function") throw new VMError("FEATURE_NOT_AVAILABLE", "DataView intrinsic getter is unavailable", { lateFailure: "unsupported-node-api", subject: "napi_get_dataview_info" });
  const result: unknown = apply(getter, value, []); return result;
}
/** napi_get_dataview_info's subject as its backing store and window, or napi_invalid_arg. */
export function nativeDataView(value: unknown): { readonly buffer: ArrayBuffer; readonly byteOffset: number; readonly byteLength: number } {
  if (!isDataView(value)) throw new NapiFailure(1);
  const buffer = dataViewProperty(value, viewBuffer);
  if (!isArrayBuffer(buffer)) throw new VMError("FEATURE_NOT_AVAILABLE", "napi_get_dataview_info on a SharedArrayBuffer is unsupported", { lateFailure: "unsupported-node-api", subject: "napi_get_dataview_info" });
  return { buffer, byteOffset: integer(dataViewProperty(value, viewOffset), "native DataView offset", 0), byteLength: integer(dataViewProperty(value, viewLength), "native DataView length", 0) };
}
/** napi_arraybuffer_expected (19) for another value, napi_detachable_arraybuffer_expected (20) for one that cannot be detached. */
export function detachNativeArrayBuffer(value: unknown): void {
  if (!isArrayBuffer(value)) throw new NapiFailure(19);
  if (typeof transfer !== "function") throw new VMError("FEATURE_NOT_AVAILABLE", "ArrayBuffer.prototype.transfer is unavailable", { lateFailure: "unsupported-node-api", subject: "napi_detach_arraybuffer" });
  try { apply(transfer, value, []); } catch { throw new NapiFailure(20); }
}
/** A misaligned offset or a length past the buffer leaves a RangeError pending and answers napi_generic_failure, as Node's macro does. */
export function createNativeTypedArray(type: bigint | undefined, length: bigint | undefined, value: unknown, offset: bigint | undefined, runtime: "node" | "bun"): ArrayBufferView {
  const count = unsigned(length), start = unsigned(offset), buffer = arrayBuffer(value, "napi_create_typedarray"), entry = nativeTypedArrayKind(Number(unsigned(type) > 11n ? 12n : unsigned(type)), "napi_create_typedarray");
  if (entry === undefined) throw new NapiFailure(1);
  const [name, size, target] = entry;
  if (size > 1 && start % BigInt(size) !== 0n) throw new NativeErrorCodeFailure(createNativeError("napi_create_range_error", "ERR_NAPI_INVALID_TYPEDARRAY_ALIGNMENT", `start offset of ${name} should be a multiple of ${String(size)}`, runtime));
  if (count * BigInt(size) + start > BigInt(buffer.byteLength)) throw new NativeErrorCodeFailure(createNativeError("napi_create_range_error", "ERR_NAPI_INVALID_TYPEDARRAY_LENGTH", "Invalid typed array length", runtime));
  if (!constructor(target)) throw new VMError("FEATURE_NOT_AVAILABLE", `${name} is unavailable in this browser`, { lateFailure: "unsupported-node-api", subject: "napi_create_typedarray" });
  return new target(buffer, Number(start), Number(count));
}
/** A range past the buffer leaves Node's RangeError pending (napi_pending_exception): the caller's ordinary thrown-error path. */
export function createNativeDataView(length: bigint | undefined, value: unknown, offset: bigint | undefined, runtime: "node" | "bun"): DataView {
  const count = unsigned(length), start = unsigned(offset), buffer = arrayBuffer(value, "napi_create_dataview");
  if (count + start > BigInt(buffer.byteLength)) throw createNativeError("napi_create_range_error", "ERR_NAPI_INVALID_DATAVIEW_ARGS", "byte_offset + byte_length should be less than or equal to the size in bytes of the array passed in", runtime);
  return new NativeDataView(buffer, Number(start), Number(count));
}
