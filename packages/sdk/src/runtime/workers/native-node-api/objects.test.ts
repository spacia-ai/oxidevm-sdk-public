import { expect, it } from "vitest";
import { NativeValues } from "./values.js";

const empty = new Uint8Array();
it("keeps 128-bit type tags private and attached to the exact receiver", () => {
  const values = new NativeValues(() => undefined, () => undefined), target = Object.freeze({}), handle = values.add(target);
  const tag = [0xffff_ffff_ffff_ffffn, 0x8000_0000_0000_0001n];
  expect(values.dispatch("napi_check_object_type_tag", [handle, ...tag], empty).args).toEqual([0n]);
  expect(values.dispatch("napi_type_tag_object", [handle, ...tag], empty).status).toBe(0);
  expect(values.dispatch("napi_type_tag_object", [handle, ...tag], empty).status).toBe(1);
  expect(values.dispatch("napi_check_object_type_tag", [handle, ...tag], empty).args).toEqual([1n]);
  expect(values.dispatch("napi_check_object_type_tag", [handle, tag[0] ?? 0n, 0n], empty).args).toEqual([0n]);
  const child = {}; Object.setPrototypeOf(child, target);
  expect(values.dispatch("napi_check_object_type_tag", [values.add(child), ...tag], empty).args).toEqual([0n]);
  expect(Reflect.ownKeys(target)).toEqual([]);
  const proxy = values.add(new Proxy({}, { get() { throw new Error("get trap"); }, defineProperty() { throw new Error("define trap"); } }));
  expect(values.dispatch("napi_type_tag_object", [proxy, ...tag], empty).status).toBe(0);
  expect(values.dispatch("napi_check_object_type_tag", [proxy, ...tag], empty).args).toEqual([1n]);
});

it("requires a wrap finalizer for user references and cancels only the deleted reference's finalizer", () => {
  const finalized: bigint[] = [], values = new NativeValues(() => undefined, identity => { finalized.push(identity); });
  const handle = values.add({});
  expect(values.dispatch("napi_wrap", [handle, 42n, 0n, 1n], empty).status).toBe(1);
  expect(values.dispatch("napi_unwrap", [handle], empty).status).toBe(1);
  const wrapped = values.dispatch("napi_wrap", [handle, 42n, 4103n, 1n], empty), reference = wrapped.args[0];
  expect(wrapped.status).toBe(0); if (reference === undefined) throw new Error("Missing wrap reference");
  expect(values.dispatch("napi_add_finalizer", [handle, 4104n, 0n], empty).status).toBe(0);
  expect(values.dispatch("napi_delete_reference", [reference], empty).status).toBe(0);
  values.dispose(); values.dispose(); expect(finalized).toEqual([4104n]);
});

it("returns independent finalizer references and preserves an unrelated wrap on removal", () => {
  const finalized: bigint[] = [], values = new NativeValues(() => undefined, identity => { finalized.push(identity); });
  const handle = values.add({});
  expect(values.dispatch("napi_wrap", [handle, 42n, 4103n, 0n], empty).status).toBe(0);
  const added = values.dispatch("napi_add_finalizer", [handle, 4104n, 1n], empty), reference = added.args[0];
  expect(added.status).toBe(0); if (reference === undefined) throw new Error("Missing finalizer reference");
  expect(values.dispatch("napi_remove_wrap", [handle], empty)).toMatchObject({ status: 0, args: [42n] });
  expect(values.dispatch("napi_get_reference_value", [reference], empty).status).toBe(0);
  values.dispose(); expect(finalized).toEqual([4104n]);
});
