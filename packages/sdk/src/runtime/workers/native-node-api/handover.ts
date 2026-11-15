/**
 * Node-API requests whose service runs no application JavaScript (engine ADR 0026, practical profile). After one of
 * them no buffer can have changed since the last handover, so its reply needs no comparison of the shared buffers.
 * The list is closed and names only requests that read or create values without a getter, a trap, a coercion or a
 * callback; every other request, known or new, is followed by the comparison.
 */
export function nativeOperationRunsNoJavaScript(operation: string): boolean {
  switch (operation) {
    case "buffer-update":
    case "napi_get_value_bool": case "napi_get_value_double": case "napi_get_value_int32": case "napi_get_value_int64": case "napi_get_value_uint32":
    case "napi_get_value_bigint_int64": case "napi_get_value_bigint_uint64": case "napi_get_value_bigint_words": case "napi_get_value_external":
    case "napi_get_value_string_latin1": case "napi_get_value_string_utf16": case "napi_get_value_string_utf8":
    case "napi_create_double": case "napi_create_int32": case "napi_create_int64": case "napi_create_uint32":
    case "napi_create_bigint_int64": case "napi_create_bigint_uint64": case "napi_create_bigint_words":
    case "napi_create_string_latin1": case "napi_create_string_utf16": case "napi_create_string_utf8":
    case "napi_create_object": case "napi_create_array": case "napi_create_array_with_length": case "napi_create_external":
    case "napi_create_reference": case "napi_delete_reference": case "napi_reference_ref": case "napi_reference_unref": case "napi_get_reference_value":
    case "napi_get_undefined": case "napi_get_null": case "napi_get_global": case "napi_get_boolean": case "napi_typeof":
    case "napi_is_array": case "napi_is_arraybuffer": case "napi_is_buffer": case "napi_is_dataview": case "napi_is_date": case "napi_is_typedarray":
    case "napi_is_detached_arraybuffer": case "napi_is_error": case "napi_is_exception_pending": case "napi_get_and_clear_last_exception":
    case "napi_open_handle_scope": case "napi_close_handle_scope": case "napi_open_escapable_handle_scope": case "napi_close_escapable_handle_scope": case "napi_escape_handle":
    case "napi_get_buffer_info": case "napi_get_typedarray_info": case "napi_get_arraybuffer_info": case "napi_get_dataview_info":
    case "napi_create_buffer": case "napi_create_buffer_copy": case "napi_create_external_buffer":
    case "napi_unwrap": case "napi_adjust_external_memory":
      return true;
    default: return false;
  }
}
