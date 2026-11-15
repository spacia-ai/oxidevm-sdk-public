import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const empty = new Uint8Array();
const owner = (operationSet = 2, runtime: "node" | "bun" = "node"): NativeValues =>
  new NativeValues(() => undefined, () => undefined, () => undefined, 0, error => { throw error; }, { claim: () => undefined, retire: () => undefined, operationSet, runtime });
function value(values: NativeValues, result: { readonly status: number; readonly args: readonly bigint[] }): unknown {
  const handle = result.args[0]; if (result.status !== 0 || handle === undefined) throw new Error(`Node-API status ${String(result.status)}`);
  return values.get(handle);
}
function pending(values: NativeValues): unknown { return value(values, values.dispatch("napi_get_and_clear_last_exception", [], empty)); }

it("creates every typed array kind over an ArrayBuffer, as napi_typedarray_type numbers them", () => {
  const values = owner(), buffer = new ArrayBuffer(64), handle = values.add(buffer);
  const kinds = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, Float16Array];
  kinds.forEach((kind, type) => {
    const made = value(values, values.dispatch("napi_create_typedarray", [BigInt(type), 2n, handle, 16n], empty));
    expect(made).toBeInstanceOf(kind);
    expect(made).toMatchObject({ buffer, byteOffset: 16, length: 2 });
  });
  expect(values.dispatch("napi_create_typedarray", [12n, 1n, handle, 0n], empty).status).toBe(1);
  expect(values.dispatch("napi_create_typedarray", [1n, 1n, values.add({}), 0n], empty).status).toBe(1);
  expect(values.dispatch("napi_create_typedarray", [1n, 1n, values.add(new Uint8Array(4)), 0n], empty).status).toBe(1);
  expect(() => values.dispatch("napi_create_typedarray", [1n, 1n, values.add(new SharedArrayBuffer(8)), 0n], empty)).toThrow(/SharedArrayBuffer/u);
  expect(() => values.dispatch("napi_create_typedarray", [1n, 1n, handle], empty)).toThrow(/argument shape/u);
});

it("refuses a misaligned or oversized typed array with Node's RangeError and napi_generic_failure", () => {
  const values = owner(), handle = values.add(new ArrayBuffer(8));
  expect(values.dispatch("napi_create_typedarray", [4n, 1n, handle, 3n], empty).status).toBe(9);
  expect(pending(values)).toMatchObject({ name: "RangeError", code: "ERR_NAPI_INVALID_TYPEDARRAY_ALIGNMENT", message: "start offset of Uint16Array should be a multiple of 2" });
  expect(values.dispatch("napi_create_typedarray", [8n, 2n, handle, 0n], empty).status).toBe(9);
  expect(pending(values)).toMatchObject({ name: "RangeError", code: "ERR_NAPI_INVALID_TYPEDARRAY_LENGTH", message: "Invalid typed array length" });
  expect(values.dispatch("napi_create_typedarray", [1n, 0xffff_ffff_ffff_ffffn, handle, 0n], empty).status).toBe(9);
  expect(pending(values)).toMatchObject({ code: "ERR_NAPI_INVALID_TYPEDARRAY_LENGTH" });
  // NAPI_PREAMBLE: a pending exception refuses the call before anything else.
  values.dispatch("napi_throw", [values.add(new Error("earlier"))], empty);
  expect(values.dispatch("napi_create_typedarray", [1n, 1n, handle, 0n], empty).status).toBe(10);
  expect(values.dispatch("napi_create_dataview", [1n, handle, 0n], empty).status).toBe(10);
});

it("creates a DataView, and leaves Node's RangeError pending for a range past the buffer", () => {
  const values = owner(), buffer = new ArrayBuffer(8), handle = values.add(buffer);
  const view = value(values, values.dispatch("napi_create_dataview", [4n, handle, 2n], empty));
  expect(view).toBeInstanceOf(DataView); expect(view).toMatchObject({ buffer, byteOffset: 2, byteLength: 4 });
  expect(values.dispatch("napi_create_dataview", [8n, handle, 1n], empty).status).toBe(10);
  expect(pending(values)).toMatchObject({ name: "RangeError", code: "ERR_NAPI_INVALID_DATAVIEW_ARGS", message: "byte_offset + byte_length should be less than or equal to the size in bytes of the array passed in" });
  expect(values.dispatch("napi_create_dataview", [1n, values.add(new Uint8Array(4)), 0n], empty).status).toBe(1);
});

it("answers an ArrayBuffer, its typed arrays and its DataViews with one backing identity and the whole store's bytes", () => {
  const values = owner(), buffer = new ArrayBuffer(8), bytes = new Uint8Array(buffer); bytes.set([1, 2, 3, 4, 5, 6, 7, 8]);
  const whole = values.dispatch("napi_get_arraybuffer_info", [values.add(buffer)], empty);
  expect(whole.status).toBe(0); expect(whole.args.slice(0, 4)).toEqual([1n, 1n, 8n, 0n]); expect(whole.bytes).toEqual(bytes);
  expect(values.get(whole.args[4] ?? 0n)).toBe(buffer);
  const window = values.dispatch("napi_get_dataview_info", [values.add(new DataView(buffer, 2, 4))], empty);
  expect(window.args.slice(0, 4)).toEqual([1n, 1n, 4n, 2n]); expect(window.bytes).toEqual(bytes); expect(values.get(window.args[4] ?? 0n)).toBe(buffer);
  expect(values.dispatch("napi_get_typedarray_info", [values.add(new Uint16Array(buffer, 4, 2))], empty).args.slice(0, 4)).toEqual([1n, 4n, 2n, 4n]);
  // Native code may change an ArrayBuffer JavaScript made (operation set 2).
  expect(values.dispatch("buffer-update", [1n], new Uint8Array(8).fill(9)).status).toBe(0); expect(bytes[7]).toBe(9);
  for (const other of [{}, new Uint8Array(4), new DataView(buffer)]) expect(values.dispatch("napi_get_arraybuffer_info", [values.add(other)], empty).status).toBe(1);
  for (const other of [{}, new Uint8Array(4), buffer]) expect(values.dispatch("napi_get_dataview_info", [values.add(other)], empty).status).toBe(1);
  expect(() => values.dispatch("napi_get_arraybuffer_info", [values.add(new SharedArrayBuffer(8))], empty)).toThrow(/SharedArrayBuffer/u);
});

it("detaches an ArrayBuffer and names what is not one", () => {
  const values = owner(), buffer = new ArrayBuffer(8), handle = values.add(buffer);
  expect(values.dispatch("napi_get_arraybuffer_info", [handle], empty).status).toBe(0);
  expect(values.dispatch("napi_detach_arraybuffer", [handle], empty)).toMatchObject({ status: 0, args: [0n] });
  expect(buffer.detached).toBe(true); expect(values.dispatch("napi_is_detached_arraybuffer", [handle], empty).args).toEqual([1n]);
  expect(values.dispatch("napi_detach_arraybuffer", [values.add(new Uint8Array(4))], empty).status).toBe(19);
  expect(values.dispatch("napi_detach_arraybuffer", [values.add(new WebAssembly.Memory({ initial: 1 }).buffer)], empty).status).toBe(20);
  // Native code still holds a pointer into the bytes it was given; asking again cannot be answered.
  let thrown: unknown;
  try { values.dispatch("napi_get_arraybuffer_info", [handle], empty); } catch (error) { thrown = error; }
  expect(thrown).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { lateFailure: "unsupported-node-api", subject: "detached-native-buffer" } });
});

for (const operation of ["napi_get_arraybuffer_info", "napi_get_dataview_info", "napi_detach_arraybuffer", "napi_create_typedarray", "napi_create_dataview"]) it(`${operation} stays refused for a host of an earlier operation set and for Bun`, () => {
  for (const values of [owner(1), owner(0), owner(2, "bun")]) {
    let thrown: unknown;
    // An earlier host forwards the bare name (its unserved stub).
    try { values.dispatch(operation, [], empty); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { lateFailure: "unsupported-node-api", subject: operation } });
  }
});
