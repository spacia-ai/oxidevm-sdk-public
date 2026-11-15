import { isVMError } from "../../errors.js";
import { protocol } from "../../js-process/codec.js";
import { NapiFailure } from "./errors.js";
import { nativeCreateObject, nativeDefineProperty } from "./properties.js";

/**
 * Two experimental Node-API object operations as pinned Node 24.18.1 answers them (ADR 0026,
 * 2.13; rows in experimental.controls.json). The other two are a brand check and a native
 * immediate, which their owners serve.
 */
const setPrototypeOf = Reflect.setPrototypeOf;

/** node_api_set_prototype (V8 SetPrototypeV2): a value that is neither an object nor null changes
 * nothing; a refusal, or a throwing proxy trap, is napi_generic_failure with nothing pending. */
export function nativeSetPrototype(target: object, value: unknown): void {
  if (value !== null && typeof value !== "object" && typeof value !== "function") return;
  let set: boolean;
  try { set = setPrototypeOf(target, value); }
  catch (error) { if (isVMError(error)) throw error; set = false; }
  if (!set) throw new NapiFailure(9);
}

function propertyName(value: unknown): string | symbol {
  if (typeof value !== "string" && typeof value !== "symbol") throw new NapiFailure(4);
  return value;
}

/** node_api_create_object_with_properties (V8 Object::New): every name is checked before the
 * prototype, whose invalidity aborts Node; data properties are defined in order, so a duplicate
 * name keeps its first place and its last value. */
export function nativeObjectWithProperties(prototype: unknown, names: readonly unknown[], values: readonly unknown[]): object {
  for (let index = 0; index < names.length; index++) propertyName(names[index]);
  if (prototype !== null && typeof prototype !== "object" && typeof prototype !== "function") protocol("Invalid native object prototype");
  const created: unknown = nativeCreateObject(prototype);
  if (typeof created !== "object" || created === null) protocol("Native object creation failed");
  for (let index = 0; index < names.length; index++) {
    nativeDefineProperty(created, propertyName(names[index]), { value: values[index], writable: true, enumerable: true, configurable: true });
  }
  return created;
}
