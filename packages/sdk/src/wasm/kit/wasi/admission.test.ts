import { describe, expect, it } from "vitest";
import { admitProgram, AdmissionError } from "./admission.js";
import { PREVIEW1_IMPORTS } from "./imports.js";
import { wasm, type ModuleSpec } from "./wasm-builder.test-support.js";

const admit = (spec: ModuleSpec, bridge: readonly string[] = []) => { admitProgram(new WebAssembly.Module(wasm(spec)), new Set(bridge)); };

describe("program admission (OBL-VERSION)", () => {
  it("lists exactly the 46 Preview1 functions", () => {
    expect(new Set(PREVIEW1_IMPORTS).size).toBe(46);
  });

  it("admits known Preview1 imports and known bridge imports of this major", () => {
    expect(() => { admit({ functionImports: [["wasi_snapshot_preview1", "fd_write"], ["oxidevm_bridge_v1", "process_info"]] }, ["process_info"]); }).not.toThrow();
  });

  it("refuses an unknown Preview1 name, an unknown namespace, a future bridge major and an unknown bridge name", () => {
    expect(() => { admit({ functionImports: [["wasi_snapshot_preview1", "fd_frobnicate"]] }); }).toThrow(/does not define/u);
    expect(() => { admit({ functionImports: [["env", "abort"]] }); }).toThrow(/unknown namespace env/u);
    expect(() => { admit({ functionImports: [["oxidevm_bridge_v2", "process_info"]] }); }).toThrow(/bridge ABI major 2 is not supported/u);
    expect(() => { admit({ functionImports: [["oxidevm_bridge_v1", "raw_syscall"]] }); }).toThrow(/oxidevm_bridge_v1 does not define/u);
  });

  it("refuses an imported memory and a program without _start or memory exports", () => {
    expect(() => { admit({ importMemory: true, exportMemory: false }); }).toThrow(AdmissionError);
    expect(() => { admit({ exportStart: false }); }).toThrow(/_start/u);
    expect(() => { admit({ exportMemory: false }); }).toThrow(/memory/u);
  });
});
