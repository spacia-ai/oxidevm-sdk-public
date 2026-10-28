import { expect, it } from "vitest";
import { createCommonJSLoader } from "./commonjs.js";
import { ExecutableSources } from "./executable-sources.js";
import type { LocalModuleFiles } from "./module-files.js";

function loader(loadNative?: (path: string) => unknown) {
  const files: LocalModuleFiles = { resolve: path => path, read: () => { throw new Error("Native bytes must not be decoded as JavaScript"); }, ...(loadNative === undefined ? {} : { loadNative }) };
  return createCommonJSLoader(files, {}, request => { if (typeof request !== "string") throw new Error("invalid path"); return request; }, () => undefined,
    () => { throw new Error("Native modules must not enter the JavaScript evaluator"); }, { cwd: () => "/workspace", sources: new ExecutableSources() });
}
it("loads a native module through the admitted backend and preserves require cache identity", () => {
  const paths: string[] = [], native = { call: () => "native" };
  const modules = loader(path => { paths.push(path); return native; });
  expect(modules.require("/workspace/addon.node")).toBe(native);
  expect(modules.require("/workspace/addon.node")).toBe(native);
  expect(paths).toEqual(["/workspace/addon.node"]);
});
it("keeps native loading unavailable when no native backend is admitted", () => {
  expect(() => loader().require("/workspace/addon.node")).toThrow("native addons is not available");
});
