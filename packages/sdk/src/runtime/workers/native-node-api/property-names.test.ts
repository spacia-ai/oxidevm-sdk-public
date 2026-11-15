import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it } from "vitest";
import { record } from "../../decode.js";
import { isVMError } from "../../errors.js";
import { installProxyRegistry } from "../../proxy-brand.js";
import { NativeValues } from "./values.js";

/** Pinned Node 24.18.1's answers to the engine's property-names fixture (ADR 0026, 2.11). */
const control = record(JSON.parse(readFileSync(new URL("./property-names.controls.json", import.meta.url), "utf8")), "property-names controls");
const require = createRequire(import.meta.url), driverPath = require.resolve("../../../../../../tests/fixtures/native-node-api/property-names.cjs");
const driver: unknown = require(driverPath);
/** Where V8's answer depends on how it stores the elements, which JavaScript cannot see. */
const ELEMENTS_KIND = ["frozen-array/writable", "frozen-object-indices/writable", "sealed-array/configurable", "frozen-dictionary-array/writable", "frozen-sparse-array/writable", "frozen-holey-array/writable", "arguments/frozen-writable"];
const empty = new Uint8Array();

it("replays the driver the engine recorded", () => {
  expect(createHash("sha256").update(readFileSync(driverPath)).digest("hex")).toBe(control["driverSHA256"]);
});

let restore: () => void;
beforeAll(() => { restore = installProxyRegistry(globalThis); });
afterAll(() => { restore(); });

/** The fixture's C side, through the value owner's dispatch: [status, keys | exception | undefined]. */
function through(values: NativeValues) {
  const row = (operation: string, args: readonly bigint[]): unknown[] => {
    let reply;
    try { reply = values.dispatch(operation, args, empty); }
    catch (error) {
      // The driver names errors; a late failure becomes one naming its kind and subject.
      if (isVMError(error)) return [-1, Object.assign(new Error(error.message), { name: `LateFailure:${String(error.detail?.["lateFailure"])}:${String(error.detail?.["subject"])}` })];
      throw error;
    }
    const pending = values.dispatch("napi_is_exception_pending", [], empty).args[0] === 1n;
    if (pending) return [reply.status, values.get(values.dispatch("napi_get_and_clear_last_exception", [], empty).args[0] ?? 0n)];
    return [reply.status, reply.status === 0 ? values.get(reply.args[0] ?? 0n) : undefined];
  };
  const inspect = (object: unknown, mode: number, filter: number, conversion: number) => row("napi_get_all_property_names", [values.add(object), BigInt(mode), BigInt(filter), BigInt(conversion)]);
  return Object.assign(inspect, { prototypeOf: (object: unknown) => row("napi_get_prototype", [values.add(object)]) });
}

it("collects keys as pinned Node does, and refuses where V8's elements kind decides", () => {
  if (typeof driver !== "function") throw new Error("Missing property-names driver");
  const observed: unknown = JSON.parse(String(Reflect.apply(driver, undefined, [through(new NativeValues(() => undefined, () => undefined))])));
  const rows: unknown = control["rows"];
  if (!Array.isArray(rows) || !Array.isArray(observed)) throw new Error("Invalid property-names rows");
  const expected = rows.map((value: unknown): unknown => {
    if (!Array.isArray(value)) throw new Error("Invalid control row");
    const row: readonly unknown[] = value, name = row[0];
    if (typeof name !== "string") throw new Error("Invalid control row name");
    return ELEMENTS_KIND.includes(name) ? [name, -1, "error:LateFailure:unsupported-node-api:napi_get_all_property_names", row[3]] : row;
  });
  expect(observed).toEqual(expected);
});
