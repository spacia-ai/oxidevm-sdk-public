import { describe, expect, it } from "vitest";
import { kit } from "../index.js";
import { AdmissionError } from "./admission.js";
import { LIMITS } from "./limits.js";
import { compile, ProgramTooLarge, readProgram } from "./program.js";
import { streams } from "./streams.test-support.js";
import { wasm } from "./wasm-builder.test-support.js";

describe("kit.wasi programs", () => {
  it("reads a program through one descriptor, in chunks, and closes it", () => {
    const bytes = Uint8Array.from({ length: 200_000 }, (_, index) => index % 251);
    const fake = streams({ programs: { "/workspace/p.wasm": bytes } });
    expect(readProgram(fake.host, "/workspace/p.wasm")).toEqual(bytes);
    expect(() => readProgram(fake.host, "/workspace/missing.wasm")).toThrow(/errno 2/u);
  });

  it("refuses a program one byte past the limit", () => {
    const fake = streams({ programs: { "/big.wasm": new Uint8Array(LIMITS.programBytes + 1) } });
    expect(() => readProgram(fake.host, "/big.wasm")).toThrow(ProgramTooLarge);
  });

  it("compiles an admitted program and refuses a start section before any code runs", async () => {
    const program = await compile(wasm({ functionImports: [["wasi_snapshot_preview1", "fd_write"]] }));
    expect(WebAssembly.Module.exports(program).map(entry => entry.name)).toEqual(["_start", "memory"]);
    await expect(compile(wasm({ start: true }))).rejects.toThrow(AdmissionError);
    await expect(compile(wasm({ functionImports: [["env", "emscripten_memcpy_js"]] }))).rejects.toThrow(/unknown namespace env/u);
  });

  it("is part of the frozen kit every adapter receives", () => {
    expect(Object.isFrozen(kit.wasi)).toBe(true);
    expect(Object.isFrozen(kit.wasi.limits)).toBe(true);
    expect(kit.wasi.limits.memoryPages).toBe(4096);
    expect(kit.wasi.rootPreopen).toEqual({ guest: "/", host: "/", readOnly: false });
    expect(typeof kit.wasi.run).toBe("function");
  });
});
