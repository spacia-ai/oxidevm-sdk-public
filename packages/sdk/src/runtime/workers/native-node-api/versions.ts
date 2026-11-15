/** The highest Node-API operation set this value owner serves (ADR 0026, 2.8). Set 0 is the
 * earlier hosts' 145 functions; set 1 adds the six of nativeSetOneOperation (2.11 to
 * 2.13); set 2 syncs buffers in both directions at every handover (buffer-push frames) and
 * serves the typed-array, DataView and ArrayBuffer operations of arraybuffers.ts. A
 * host names its set in its ELF. */
export const NATIVE_OPERATION_SET = 2;

/** Whether `operation` is one of the functions operation set 1 adds. Their answers are pinned
 * Node's; with no Bun oracle recorded, a Bun process that calls one fails explicitly. */
export function nativeSetOneOperation(operation: string): boolean {
  switch (operation) {
    case "napi_get_all_property_names": case "napi_run_script": case "node_api_set_prototype":
    case "node_api_create_object_with_properties": case "node_api_is_sharedarraybuffer": case "node_api_post_finalizer":
      return true;
    default: return false;
  }
}
