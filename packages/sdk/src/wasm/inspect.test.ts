import { describe, expect, it } from "vitest";
import { VMError } from "../runtime/errors.js";
import { inspectWasm } from "./inspect.js";
import { assemble } from "./inspect.test-support.js";

describe("inspecting a WebAssembly binary", () => {
  it("reports imports by namespace, exports, memories and custom sections of a plain module", async () => {
    const report = await inspectWasm(assemble({ exports: ["run", "memory"], memories: [[2, 16, 0]], custom: ["name", "producers"] }));
    expect(report).toMatchObject({ kind: "module", abi: "raw", imports: [], exports: ["run", "memory"], customSections: ["name", "producers"], targetFeatures: false });
    expect(report.memories).toEqual([{ minPages: 2, maxPages: 16, shared: false, memory64: false }]);
  });

  it("recognizes shared and 64-bit memories", async () => {
    const report = await inspectWasm(assemble({ memories: [[1, 4, 2], [1, null, 4]] }));
    expect(report.memories).toEqual([{ minPages: 1, maxPages: 4, shared: true, memory64: false }, { minPages: 1, maxPages: null, shared: false, memory64: true }]);
  });

  it("classifies by the evidence each convention leaves behind", async () => {
    const cases: readonly (readonly [string, Parameters<typeof assemble>[0], string, RegExp])[] = [
      ["wasi", { imports: [["wasi_snapshot_preview1", "fd_write"]], exports: ["_start"] }, "wasi", /wasi_snapshot_preview1/u],
      ["wasi 0.2 names", { imports: [["wasi:cli/stdout@0.2.0", "get-stdout"]] }, "wasi", /wasi:cli/u],
      ["emscripten by dylink", { imports: [["env", "memory_base"]], custom: ["dylink.0"] }, "emscripten", /dylink\.0/u],
      ["emscripten by GOT", { imports: [["GOT.func", "x"], ["wasi_snapshot_preview1", "fd_write"]] }, "emscripten", /GOT/u],
      ["emscripten by exports", { exports: ["__indirect_function_table", "_emscripten_stack_init"] }, "emscripten", /emscripten runtime/u],
      ["wasm-bindgen", { imports: [["__wbindgen_placeholder__", "__wbindgen_throw"]], exports: ["memory", "greet"] }, "bindgen", /wasm-bindgen/u],
      ["wasm-bindgen by exports", { exports: ["__wbindgen_malloc"] }, "bindgen", /wasm-bindgen/u],
      ["raw", { imports: [["host", "log"]], exports: ["add"] }, "raw", /imports nothing/u],
    ];
    for (const [label, spec, abi, evidence] of cases) {
      const report = await inspectWasm(assemble(spec));
      expect(report.abi, label).toBe(abi);
      expect(report.evidence.join(" "), label).toMatch(evidence);
    }
  });

  it("prefers emscripten when a binary also imports WASI, as PGlite and Pyodide do", async () => {
    const report = await inspectWasm(assemble({ imports: [["env", "invoke_vi"], ["wasi_snapshot_preview1", "fd_close"]], custom: ["dylink.0"] }));
    expect(report.abi).toBe("emscripten");
    expect(report.imports).toEqual([{ module: "env", names: 1 }, { module: "wasi_snapshot_preview1", names: 1 }]);
  });

  it("recognizes a component by its header without reading further", async () => {
    const header = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00, 0xff, 0xff);
    expect(await inspectWasm(header)).toMatchObject({ kind: "component", abi: "component" });
  });

  it("refuses anything that is not a valid core module", async () => {
    const valid = assemble({ exports: ["run"] });
    const bad: readonly (readonly [string, Uint8Array<ArrayBuffer>])[] = [
      ["empty", new Uint8Array()], ["text", new TextEncoder().encode("not wasm at all")], ["short", valid.slice(0, 6)], ["truncated section", valid.slice(0, valid.length - 3)],
      ["unknown version", Uint8Array.of(0, 0x61, 0x73, 0x6d, 2, 0, 0, 0)], ["bad section length", Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 0xff, 0xff, 0xff, 0xff, 0xff)],
    ];
    for (const [label, bytes] of bad) await expect(inspectWasm(bytes), label).rejects.toBeInstanceOf(VMError);
  });
});
