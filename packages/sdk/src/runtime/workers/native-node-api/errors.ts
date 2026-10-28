import { protocol } from "../../js-process/codec.js";
import { nativeSetProperty } from "./properties.js";

export type NativeStatus = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23;
export class NapiFailure extends Error {
  readonly #status: NativeStatus;
  constructor(status: NativeStatus) { super(`Node-API status ${status}`); this.#status = status; }
  get status(): NativeStatus { return this.#status; }
  static is(value: unknown): value is NapiFailure { return typeof value === "object" && value !== null && #status in value; }
}
export class NativeErrorCodeFailure extends NapiFailure {
  readonly #exception: unknown;
  constructor(exception: unknown) { super(9); this.#exception = exception; }
  get exception(): unknown { return this.#exception; }
  static override is(value: unknown): value is NativeErrorCodeFailure { return typeof value === "object" && value !== null && #exception in value; }
}
const NativeError = Error, NativeTypeError = TypeError, NativeRangeError = RangeError, NativeSyntaxError = SyntaxError;
const defineErrorCode = Object.defineProperty;
const isInteger = Number.isInteger;
function isStatus(value: unknown): value is NativeStatus { return typeof value === "number" && isInteger(value) && value >= 0 && value <= 23; }
export function nativeStatus(value: unknown): NativeStatus { if (!isStatus(value)) protocol("Invalid Node-API status"); return value; }

/** Pending-exception entry rules for pinned Node 24.18.1 and Bun 1.3.14. */
export function requiresClearException(operation: string, runtime: "node" | "bun"): boolean {
  switch (operation) {
    case "napi_wrap": return runtime === "node";
    case "napi_create_bigint_int64": case "napi_create_bigint_uint64": return runtime === "bun";
    case "napi_create_bigint_words": return runtime === "node";
    case "napi_create_function": case "napi_define_class": case "napi_define_properties":
    case "napi_get_property_names": case "napi_get_all_property_names":
    case "napi_set_property": case "napi_has_property": case "napi_get_property": case "napi_delete_property": case "napi_has_own_property":
    case "napi_set_named_property": case "napi_has_named_property": case "napi_get_named_property":
    case "napi_set_element": case "napi_has_element": case "napi_get_element": case "napi_delete_element":
    case "napi_object_freeze": case "napi_object_seal": case "napi_get_array_length": case "napi_strict_equals": case "napi_get_prototype":
    case "napi_call_function": case "napi_new_instance": case "napi_instanceof":
    case "napi_throw": case "napi_fatal_exception": case "napi_make_callback":
    case "napi_throw_error": case "napi_throw_type_error": case "napi_throw_range_error": case "node_api_throw_syntax_error":
    case "napi_coerce_to_bool": case "napi_coerce_to_number": case "napi_coerce_to_object": case "napi_coerce_to_string":
    case "napi_create_external": case "napi_unwrap": case "napi_remove_wrap":
    case "napi_type_tag_object": case "napi_check_object_type_tag":
    case "napi_create_arraybuffer": case "napi_create_external_arraybuffer": case "napi_create_typedarray": case "napi_create_dataview":
    case "napi_create_promise": case "napi_resolve_deferred": case "napi_reject_deferred":
    case "napi_create_date": case "napi_get_date_value": case "napi_run_script":
    case "napi_create_buffer": case "napi_create_external_buffer": case "napi_create_buffer_copy": case "node_api_create_buffer_from_arraybuffer":
      return true;
    default: return false;
  }
}

export function thrownNativeError(operation: "napi_throw_error" | "napi_throw_type_error" | "napi_throw_range_error" | "node_api_throw_syntax_error", codeBytes: number, bytes: Uint8Array, runtime: "node" | "bun"): Error {
  if (codeBytes > bytes.length || (codeBytes !== 0 && bytes[codeBytes - 1] !== 0) || bytes.subarray(codeBytes).includes(0) || bytes.subarray(0, Math.max(0, codeBytes - 1)).includes(0)) protocol("Invalid native error text");
  const decoder = new TextDecoder(), code = codeBytes === 0 ? undefined : decoder.decode(bytes.subarray(0, codeBytes - 1)), message = decoder.decode(bytes.subarray(codeBytes));
  switch (operation) {
    case "napi_throw_error": return createNativeError("napi_create_error", code, message, runtime);
    case "napi_throw_type_error": return createNativeError("napi_create_type_error", code, message, runtime);
    case "napi_throw_range_error": return createNativeError("napi_create_range_error", code, message, runtime);
    case "node_api_throw_syntax_error": return createNativeError("node_api_create_syntax_error", code, message, runtime);
  }
}

export function createNativeError(operation: "napi_create_error" | "napi_create_type_error" | "napi_create_range_error" | "node_api_create_syntax_error", code: unknown, message: unknown, runtime: "node" | "bun"): Error {
  if (typeof message !== "string" || (code !== undefined && typeof code !== "string")) throw new NapiFailure(3);
  let error: Error;
  switch (operation) {
    case "napi_create_error": error = new NativeError(message); break;
    case "napi_create_type_error": error = new NativeTypeError(message); break;
    case "napi_create_range_error": error = new NativeRangeError(message); break;
    case "node_api_create_syntax_error": error = new NativeSyntaxError(message); break;
  }
  if (code !== undefined) {
    // Pinned V8 invokes inherited setters and silently ignores a rejected assignment.
    try {
      if (runtime === "bun") defineErrorCode(error, "code", { value: code, writable: true, enumerable: true, configurable: true });
      else nativeSetProperty(error, "code", code);
    }
    catch (exception) { throw new NativeErrorCodeFailure(exception); }
  }
  return error;
}
