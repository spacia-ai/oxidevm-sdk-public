import { expect, it, vi } from "vitest";
import { initializeNextCompiler, nextCompilerEnvironment, NEXT_COMPILER_DIRECTORY, NEXT_COMPILER_FACADE, verifyNextCompilerFacade } from "./next-compiler.js";

it("initializes official callable bindings with the supplied module, not raw exports or a download", () => {
  const module = new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
  const initSync = vi.fn(() => ({ memory: new WebAssembly.Memory({ initial: 1 }) }));
  const bindings = { initSync, transformSync: vi.fn(() => ({ code: "verified" })), minifySync: vi.fn(), parseSync: vi.fn(),
    transform: vi.fn(), minify: vi.fn(), parse: vi.fn(), mdxCompile: vi.fn(), mdxCompileSync: vi.fn(), expandNextJsTemplate: vi.fn(), codeFrameColumns: vi.fn() };
  const exposed = initializeNextCompiler(bindings, module);
  expect(initSync).toHaveBeenCalledExactlyOnceWith({ module });
  expect(() => initializeNextCompiler(new WebAssembly.Instance(module).exports, module)).toThrow("initSync");
  expect(() => initializeNextCompiler({ ...bindings, transformSync: undefined }, module)).toThrow("transformSync");
  expect(initSync).toHaveBeenCalledTimes(1);
  expect(exposed["transformSync"]?.("source", {})).toEqual({ code: "verified" });
  expect(bindings.transformSync).toHaveBeenCalledWith("source", {});
  expect(Object.isFrozen(exposed)).toBe(true);
  expect(exposed).not.toHaveProperty("initSync");
  expect(exposed).not.toHaveProperty("default");
  expect(exposed).not.toHaveProperty("memory");
});

it("selects the pinned direct-bindings path without modifying caller environment or project metadata", () => {
  const env = { NEXT_DISABLE_MEM_OVERRIDE: "", CUSTOM: "retained", NEXT_DISABLE_SWC_WASM: "1", NEXT_TEST_WASM_DIR: "/unverified" };
  expect(nextCompilerEnvironment(env)).toEqual({ NEXT_DISABLE_MEM_OVERRIDE: "1", CUSTOM: "retained", NEXT_TEST_WASM: "1",
    NEXT_TEST_WASM_DIR: NEXT_COMPILER_DIRECTORY, NEXT_DISABLE_SWC_WASM: "",
    NEXT_IGNORE_INCORRECT_LOCKFILE: "1", NEXT_TELEMETRY_DISABLED: "1" });
  expect(env.NEXT_TEST_WASM_DIR).toBe("/unverified");
  expect(env.NEXT_DISABLE_MEM_OVERRIDE).toBe("");
  expect(() => verifyNextCompilerFacade(NEXT_COMPILER_FACADE)).not.toThrow();
  expect(() => verifyNextCompilerFacade("export default {};")).toThrow("does not match");
});
