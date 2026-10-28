import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { record } from "../../decode.js";
import { NodeProcess } from "../assistance/node-process.js";
import { nativeProcessBuild } from "./runtime-build.js";
import { nodeInspector } from "../assistance/node-inspector.js";

const profiles = {
  node: { runtime: "node", runtimeSHA256: "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab" },
  bun: { runtime: "bun", runtimeSHA256: "500e6edbf321ddf490adcc55a6a01639993a07924616ab67492e1256c15557e2" },
} as const;

function descriptor(input: PropertyDescriptor | undefined) {
  if (input === undefined) throw new TypeError("Missing feature descriptor");
  const fn = (value: unknown) => {
    if (value === undefined) return null;
    if (typeof value !== "function") throw new TypeError("Invalid feature accessor");
    const name: unknown = Reflect.get(value, "name"), length: unknown = Reflect.get(value, "length");
    if (typeof name !== "string" || typeof length !== "number") throw new TypeError("Invalid feature accessor identity");
    return { name, length };
  };
  const getter: unknown = Reflect.get(input, "get"), setter: unknown = Reflect.get(input, "set");
  return { enumerable: input.enumerable, configurable: input.configurable, writable: input.writable ?? null, get: fn(getter), set: fn(setter) };
}
function snapshot(process: NodeProcess) {
  const features = record(Reflect.get(process, "features"), "process features");
  const property = descriptor(Object.getOwnPropertyDescriptor(process, "features"));
  const values = { ...features }, descriptors: Record<string, unknown> = {};
  for (const key of Object.keys(features)) descriptors[key] = descriptor(Object.getOwnPropertyDescriptor(features, key));
  const changedValue = Reflect.set(features, "inspector", "changed"), afterValue = features["inspector"];
  if (changedValue) Reflect.set(features, "inspector", values["inspector"]);
  const changedProperty = Reflect.set(process, "features", { changed: true });
  if (changedProperty) Reflect.set(process, "features", features);
  return { values, property, descriptors, frozen: Object.isFrozen(features), prototype: Object.getPrototypeOf(features) === Object.prototype ? "object" : "other", changedValue, afterValue, changedProperty };
}
it.each(["node", "bun"] as const)("matches the complete pinned %s feature values, accessors and property contract", runtime => {
  const control = record(JSON.parse(readFileSync(new URL("./runtime-features.controls.json", import.meta.url), "utf8")), "features controls");
  const expected = record(control[runtime], "runtime features");
  expect(expected["binarySHA256"]).toBe(profiles[runtime].runtimeSHA256);
  const process = new NodeProcess(() => { throw new Error("unexpected exit"); }, runtime === "node" ? "24.18.1" : "24.3.0", undefined, undefined, nativeProcessBuild(profiles[runtime]));
  expect(snapshot(process)).toEqual(expected["parent"]);
  expect(snapshot(process)).toEqual(expected["worker"]);
});

it("keeps mutable feature objects private to each admitted environment", () => {
  const first = new NodeProcess(() => { throw new Error("unexpected exit"); }, "24.18.1", undefined, undefined, nativeProcessBuild(profiles.node));
  const second = new NodeProcess(() => { throw new Error("unexpected exit"); }, "24.18.1", undefined, undefined, nativeProcessBuild(profiles.node));
  const features = record(Reflect.get(first, "features"), "first features");
  expect(Reflect.set(features, "inspector", false)).toBe(true);
  expect(record(Reflect.get(second, "features"), "second features")["inspector"]).toBe(true);
  expect(Reflect.set(features, "require_module", false)).toBe(false);
});

it("retains compiled inspector metadata while unavailable inspector operations fail explicitly", () => {
  const build = nativeProcessBuild(profiles.node);
  expect(Reflect.get(build.features.value, "inspector")).toBe(true);
  for (const run of [() => nodeInspector.open(), () => new nodeInspector.Session()]) {
    let error: unknown;
    try { run(); } catch (failure) { error = failure; }
    expect(error).toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
  }
});
