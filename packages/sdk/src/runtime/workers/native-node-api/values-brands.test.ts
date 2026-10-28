import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { NativeValues } from "./values.js";

const empty = new Uint8Array();
const queries = ["napi_is_arraybuffer", "napi_is_dataview", "napi_is_detached_arraybuffer", "napi_is_typedarray"] as const;
function inspect(values: NativeValues, input: unknown): readonly bigint[] {
  const handle = values.add(input);
  return queries.map(operation => {
    const result = values.dispatch(operation, [handle], empty);
    expect(result.status).toBe(0); expect(result.bytes.byteLength).toBe(0);
    expect(result.args).toHaveLength(1);
    const answer = result.args[0]; if (answer === undefined) throw new Error("Missing query result");
    return answer;
  });
}

it("classifies ordinary, shared and empty buffers and their views without reading user properties", () => {
  const values = new NativeValues(() => undefined, () => undefined), backing = new ArrayBuffer(8), shared = new SharedArrayBuffer(8);
  for (const input of [undefined, null, false, 3, 4n, "bytes", Symbol("bytes"), [], {}, () => undefined]) {
    expect(inspect(values, input)).toEqual([0n, 0n, 0n, 0n]);
  }
  for (const input of [backing, new ArrayBuffer(0)]) expect(inspect(values, input)).toEqual([1n, 0n, 0n, 0n]);
  expect(inspect(values, shared)).toEqual([0n, 0n, 0n, 0n]);
  for (const input of [new DataView(backing), new DataView(shared)]) expect(inspect(values, input)).toEqual([0n, 1n, 0n, 0n]);
  for (const input of [new Uint8Array(backing), new Uint16Array(shared), new BigInt64Array(1)]) expect(inspect(values, input)).toEqual([0n, 0n, 0n, 1n]);
  const trapped = { get [Symbol.toStringTag](): never { throw new Error("tag getter must not run"); } };
  expect(inspect(values, trapped)).toEqual([0n, 0n, 0n, 0n]);
  for (const target of [backing, new DataView(backing), new Uint8Array(backing)]) {
    const proxy = new Proxy(target, { get(): never { throw new Error("proxy get must not run"); }, getPrototypeOf(): never { throw new Error("proxy prototype must not run"); } });
    expect(inspect(values, proxy)).toEqual([0n, 0n, 0n, 0n]);
    const revoked = Proxy.revocable(target, {}); revoked.revoke();
    expect(inspect(values, revoked.proxy)).toEqual([0n, 0n, 0n, 0n]);
  }
});

it("uses brands instead of prototype chains for the existing typed-array query", () => {
  const values = new NativeValues(() => undefined, () => undefined);
  const foreignView: unknown = runInNewContext("new DataView(new ArrayBuffer(8))");
  const alteredView = new DataView(new ArrayBuffer(8)); Object.setPrototypeOf(alteredView, Uint8Array.prototype);
  const alteredArray = new Uint8Array(8); Object.setPrototypeOf(alteredArray, DataView.prototype);
  for (const input of [foreignView, alteredView]) expect(values.dispatch("napi_is_typedarray", [values.add(input)], empty)).toMatchObject({ status: 0, args: [0n] });
  expect(values.dispatch("napi_is_typedarray", [values.add(alteredArray)], empty)).toMatchObject({ status: 0, args: [1n] });
});

it("keeps the typed-array query independent of replaced global predicates", () => {
  const values = new NativeValues(() => undefined, () => undefined), input = values.add(new Uint8Array(8));
  const original = Object.getOwnPropertyDescriptor(ArrayBuffer, "isView");
  if (original === undefined) throw new Error("Missing isView descriptor");
  try {
    Object.defineProperty(ArrayBuffer, "isView", { ...original, value: (): never => { throw new Error("replacement must not run"); } });
    expect(values.dispatch("napi_is_typedarray", [input], empty)).toMatchObject({ status: 0, args: [1n] });
  } finally { Object.defineProperty(ArrayBuffer, "isView", original); }
});

it("retains array-buffer and DataView brands across foreign realms and changed prototypes", () => {
  const values = new NativeValues(() => undefined, () => undefined);
  const backing: unknown = runInNewContext("new ArrayBuffer(8)");
  const view: unknown = runInNewContext("new DataView(new ArrayBuffer(8))");
  const array: unknown = runInNewContext("new Uint16Array(4)");
  expect(inspect(values, backing)).toEqual([1n, 0n, 0n, 0n]);
  expect(inspect(values, view)).toEqual([0n, 1n, 0n, 0n]);
  expect(inspect(values, array)).toEqual([0n, 0n, 0n, 1n]);
  const ordinary = new ArrayBuffer(8), data = new DataView(ordinary);
  Object.setPrototypeOf(ordinary, null); Object.setPrototypeOf(data, null);
  expect(inspect(values, ordinary)).toEqual([1n, 0n, 0n, 0n]);
  expect(inspect(values, data)).toEqual([0n, 1n, 0n, 0n]);
  for (const input of [Object.create(ArrayBuffer.prototype), Object.create(DataView.prototype), { [Symbol.toStringTag]: "ArrayBuffer" }, { [Symbol.toStringTag]: "DataView" }]) {
    expect(inspect(values, input)).toEqual([0n, 0n, 0n, 0n]);
  }
});

it("classifies detached and out-of-bounds views without accessing their byte lengths", () => {
  const values = new NativeValues(() => undefined, () => undefined), backing = new ArrayBuffer(8), view = new DataView(backing), array = new Uint8Array(backing);
  structuredClone(backing, { transfer: [backing] });
  expect(inspect(values, backing)).toEqual([1n, 0n, 1n, 0n]);
  expect(inspect(values, view)).toEqual([0n, 1n, 0n, 0n]);
  expect(inspect(values, array)).toEqual([0n, 0n, 0n, 1n]);
  const resized = new ArrayBuffer(8, { maxByteLength: 16 }), subview = new DataView(resized, 4, 4), subarray = new Uint8Array(resized, 4, 4);
  resized.resize(0);
  expect(inspect(values, resized)).toEqual([1n, 0n, 0n, 0n]);
  expect(inspect(values, subview)).toEqual([0n, 1n, 0n, 0n]);
  expect(inspect(values, subarray)).toEqual([0n, 0n, 0n, 1n]);
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 }), previous = memory.buffer;
  memory.grow(1);
  expect(inspect(values, previous)).toEqual([1n, 0n, 1n, 0n]);
  expect(inspect(values, memory.buffer)).toEqual([1n, 0n, 0n, 0n]);
});

it("preserves pending exceptions and allocates no native backing for repeated brand queries", () => {
  const release = vi.fn(), values = new NativeValues(() => undefined, () => undefined, release), backing = new ArrayBuffer(8), marker = new Error("brand query pending");
  expect(values.dispatch("napi_throw", [values.add(marker)], empty).status).toBe(0);
  for (let count = 0; count < 100; count++) expect(inspect(values, backing)).toEqual([1n, 0n, 0n, 0n]);
  expect(values.dispatch("napi_is_exception_pending", [], empty)).toMatchObject({ status: 0, args: [1n] });
  const result = values.dispatch("napi_get_and_clear_last_exception", [], empty), handle = result.args[0];
  if (handle === undefined) throw new Error("Missing exception result");
  expect(values.get(handle)).toBe(marker);
  values.dispose(); expect(release).not.toHaveBeenCalled();
});

it("rejects malformed requests and retired handles before querying values", () => {
  const values = new NativeValues(() => undefined, () => undefined), handle = values.add(new ArrayBuffer(0));
  values.createScope(2n); const retired = values.withScope(2n, () => values.add(new ArrayBuffer(0))); values.retireScope(2n);
  for (const operation of queries) {
    expect(() => values.dispatch(operation, [], empty)).toThrow(/argument shape/u);
    expect(() => values.dispatch(operation, [handle], new Uint8Array([1]))).toThrow(/argument shape/u);
    expect(() => values.dispatch(operation, [0n], empty)).toThrow(/value|handle/iu);
    expect(() => values.dispatch(operation, [retired], empty)).toThrow(/value|handle/iu);
  }
});

it("reports an unavailable detached-buffer intrinsic without returning a false result", async () => {
  vi.resetModules();
  const original = Object.getOwnPropertyDescriptor;
  const descriptor = vi.spyOn(Object, "getOwnPropertyDescriptor").mockImplementation((target, property) => target === ArrayBuffer.prototype && property === "detached" ? undefined : original(target, property));
  try {
    const { nativeIsDetachedArrayBuffer } = await import("./value-brands.js");
    for (const input of [new ArrayBuffer(0), {}]) {
      let failure: unknown;
      try { nativeIsDetachedArrayBuffer(input); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
    }
  } finally { descriptor.mockRestore(); vi.resetModules(); }
});
