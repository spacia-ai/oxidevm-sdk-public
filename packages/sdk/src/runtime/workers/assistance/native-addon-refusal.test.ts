import { expect, it } from "vitest";
import { VMError } from "../../errors.js";
import { refusingAddonLoader } from "./native-addon-refusal.js";

const refuse = (path: string): never => { throw new VMError("PROTOCOL_ERROR", `Unqualified native addon: ${path}`, { lateFailure: "unqualified-addon", subject: "gnu.node" }); };

it("gives a program Node's error for an add-on the fast path did not admit, and keeps the limitation for the process's end", () => {
  const loader = refusingAddonLoader(refuse);
  expect(loader.refused()).toBeUndefined();
  let error: unknown;
  try { loader.load("/workspace/node_modules/pkg/gnu.node"); } catch (caught) { error = caught; }
  // What a program that probes for an optional build sees in Node when the file cannot be loaded.
  expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(VMError);
  expect(error).toMatchObject({ code: "ERR_DLOPEN_FAILED" });
  expect(error instanceof Error ? error.message : "").toContain("/workspace/node_modules/pkg/gnu.node");
  expect(loader.refused()).toEqual({ kind: "unqualified-addon", detail: "gnu.node" });
  // The first refusal is the one remembered.
  expect(() => loader.load("/other.node")).toThrow(/other\.node/u);
  expect(loader.refused()).toEqual({ kind: "unqualified-addon", detail: "gnu.node" });
});

it("passes an admitted add-on and every other failure through unchanged", () => {
  const exports = {}, failure = new VMError("PROTOCOL_ERROR", "Native process is retired"), unsupported = new VMError("FEATURE_NOT_AVAILABLE", "x", { lateFailure: "unsupported-node-api", subject: "napi_x" });
  expect(refusingAddonLoader(() => exports).load("/a.node")).toBe(exports);
  for (const thrown of [failure, unsupported, new TypeError("add-on's own error")]) {
    const loader = refusingAddonLoader(() => { throw thrown; });
    expect(() => loader.load("/a.node")).toThrow(thrown); expect(loader.refused()).toBeUndefined();
  }
});
