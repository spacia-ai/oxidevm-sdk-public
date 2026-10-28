import { expect, it } from "vitest";
import { guardMissingExports } from "./builtin-guard.js";

const REAL = { http: ["METHODS", "STATUS_CODES", "createServer"], util: ["styleText", "format"], fs: ["readFileSync"] };

function modules() {
  return { http: { STATUS_CODES: {}, createServer: () => undefined }, util: Object.freeze({ format: () => "" }), fs: { readFileSync: () => "" }, path: { join: () => "" } };
}

it("reads a real export the fast path lacks as undefined, hides it from copies and keeps its exact name", () => {
  const builtins = modules();
  const touched = guardMissingExports(builtins, REAL);
  expect(Object.keys(builtins.http)).toEqual(["STATUS_CODES", "createServer"]);
  expect({ ...builtins.http }).not.toHaveProperty("METHODS");
  expect(Object.assign({}, builtins.http)).not.toHaveProperty("METHODS");
  expect(touched()).toBeUndefined();
  expect("METHODS" in builtins.http).toBe(true);
  expect(Reflect.get(builtins.http, "METHODS")).toBeUndefined();
  expect(touched()).toEqual({ kind: "unavailable-builtin", detail: "node:http.METHODS" });
  expect(Reflect.get(builtins.fs, "readFileSync")).toBeTypeOf("function");
  expect(touched()).toEqual({ kind: "unavailable-builtin", detail: "node:http.METHODS" });
});

it("lets a program assign the missing export, as it could on a real module", () => {
  const builtins = modules();
  const touched = guardMissingExports(builtins, REAL);
  Reflect.set(builtins.http, "METHODS", ["GET"]);
  expect(Reflect.get(builtins.http, "METHODS")).toEqual(["GET"]);
  expect(Object.keys(builtins.http)).toContain("METHODS");
  expect(touched()).toBeUndefined();
});

it("leaves frozen modules, modules without a real list and present exports as they are", () => {
  const builtins = modules();
  const touched = guardMissingExports(builtins, REAL);
  expect("styleText" in builtins.util).toBe(false);
  expect(Object.getOwnPropertyNames(builtins.path)).toEqual(["join"]);
  expect(Object.getOwnPropertyNames(builtins.fs)).toEqual(["readFileSync"]);
  expect(touched()).toBeUndefined();
});
