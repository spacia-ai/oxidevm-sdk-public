import { describe, expect, it, vi } from "vitest";
import { VMError } from "../../runtime/errors.js";
import { preverifiedArtifacts } from "./artifacts.js";
import { commandLaunch } from "./harness.test-support.js";
import { COMMAND_DECLARATION, buildRelease, type Release } from "./fixtures.test-support.js";

const wasm = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
const release = (): Promise<Release> => buildRelease({ adapter: "export default () => ({ main: () => 0 });", artifacts: { "tool.wasm": wasm, "data.bin": Uint8Array.of(1, 2, 3, 4) }, declaration: COMMAND_DECLARATION });

// Engine ADR 0028: every start uses the copies the VM's verified-copy store checked before the process existed.
describe("pre-verified copies", () => {
  it("never fetches or hashes: compile returns the verified module, bytes read the copy and url is a blob: URL until close", async () => {
    const { descriptor, ...rest } = await release(), copies = await commandLaunch({ descriptor, ...rest }, "tool");
    const compile = vi.spyOn(WebAssembly, "compile"), digest = vi.spyOn(crypto.subtle, "digest");
    try {
      const artifacts = preverifiedArtifacts(descriptor, copies);
      expect(await artifacts.adapter()).toBe(copies.adapter);
      expect(await artifacts.compile("tool.wasm")).toBe(copies.artifacts["tool.wasm"]?.module);
      const first = await artifacts.bytes("data.bin");
      first.fill(9);
      expect([...await artifacts.bytes("data.bin")]).toEqual([1, 2, 3, 4]);
      const url = artifacts.url("data.bin");
      expect(url.startsWith("blob:")).toBe(true);
      expect(artifacts.url("data.bin")).toBe(url);
      expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3, 4));
      expect(compile).not.toHaveBeenCalled();
      expect(digest).not.toHaveBeenCalled();
      artifacts.close();
      await expect(fetch(url)).rejects.toThrow();
      expect(() => artifacts.url("__proto__")).toThrow(VMError);
      await expect(artifacts.bytes("other.bin")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    } finally { compile.mockRestore(); digest.mockRestore(); }
  });

  it("compiles the verified bytes of a file that did not compile when the commands were turned on", async () => {
    const { descriptor, ...rest } = await release(), copies = await commandLaunch({ descriptor, ...rest }, "tool");
    const artifacts = preverifiedArtifacts(descriptor, { ...copies, artifacts: { ...copies.artifacts, "tool.wasm": { blob: new Blob([wasm]), module: null } } });
    expect(await artifacts.compile("tool.wasm")).toBeInstanceOf(WebAssembly.Module);
    await expect(artifacts.compile("data.bin")).rejects.toBeInstanceOf(WebAssembly.CompileError);
  });

  it("refuses copies that are not exactly the description's files with a launch failure", async () => {
    const { descriptor, ...rest } = await release(), copies = await commandLaunch({ descriptor, ...rest }, "tool");
    const fewer = Object.fromEntries(Object.entries(copies.artifacts).filter(([name]) => name !== "data.bin"));
    for (const changed of [
      { ...copies, artifacts: fewer }, { ...copies, artifacts: { ...copies.artifacts, "extra.bin": { blob: new Blob([]), module: null } } },
      { ...copies, artifacts: { ...copies.artifacts, "data.bin": { blob: new Blob([Uint8Array.of(1, 2, 3)]), module: null } } }, { ...copies, adapter: new Blob(["export {};"]) },
    ]) {
      let refused: unknown;
      try { preverifiedArtifacts(descriptor, changed); } catch (error: unknown) { refused = error; }
      expect(refused).toMatchObject({ status: 120, kind: "launch", detail: { reason: "wasm-module-launch" } });
    }
  });

  it("reads a verified copy synchronously, for an interpreter that installs on import without JSPI: the same copy, no fetch, no second check", async () => {
    const { descriptor, ...rest } = await release(), copies = await commandLaunch({ descriptor, ...rest }, "tool");
    const read = vi.fn((blob: Blob): Uint8Array<ArrayBuffer> => blob === copies.artifacts["data.bin"]?.blob ? Uint8Array.of(1, 2, 3, 4) : new Uint8Array());
    const fetching = vi.spyOn(globalThis, "fetch"), digest = vi.spyOn(crypto.subtle, "digest");
    try {
      const artifacts = preverifiedArtifacts(descriptor, copies, read);
      expect(artifacts.blob("data.bin")).toBe(copies.artifacts["data.bin"]?.blob);
      const bytes = artifacts.bytesSync("data.bin");
      expect([...bytes]).toEqual([1, 2, 3, 4]);
      expect(read).toHaveBeenCalledWith(copies.artifacts["data.bin"]?.blob);
      expect(fetching).not.toHaveBeenCalled();
      expect(digest).not.toHaveBeenCalled();
      for (const name of ["other.bin", "__proto__"]) {
        expect(() => artifacts.blob(name), name).toThrow(VMError);
        expect(() => artifacts.bytesSync(name), name).toThrow(VMError);
      }
    } finally { fetching.mockRestore(); digest.mockRestore(); }
  });

  it("reads synchronously with the worker's FileReaderSync, and says so where a scope has none", async () => {
    const { descriptor, ...rest } = await release(), copies = await commandLaunch({ descriptor, ...rest }, "tool");
    let refused: unknown;
    try { preverifiedArtifacts(descriptor, copies).bytesSync("data.bin"); } catch (error: unknown) { refused = error; }
    expect(refused).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "wasm-artifact-sync-read" } });
    class FakeFileReaderSync { readAsArrayBuffer(blob: Blob): ArrayBuffer { return blob === copies.artifacts["data.bin"]?.blob ? Uint8Array.of(5, 6, 7, 8).buffer : new ArrayBuffer(0); } }
    vi.stubGlobal("FileReaderSync", FakeFileReaderSync);
    try { expect([...preverifiedArtifacts(descriptor, copies).bytesSync("data.bin")]).toEqual([5, 6, 7, 8]); }
    finally { vi.unstubAllGlobals(); }
  });
});
