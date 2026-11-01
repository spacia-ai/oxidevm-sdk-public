import { describe, expect, it, vi } from "vitest";
import { VMError } from "../../runtime/errors.js";
import { createArtifacts, preverifiedArtifacts } from "./artifacts.js";
import { IntegrityError, type Fetcher } from "./pinned.js";
import { commandLaunch } from "./harness.test-support.js";
import { COMMAND_DECLARATION, buildRelease, type Release } from "./fixtures.test-support.js";

const wasm = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
const release = (): Promise<Release> => buildRelease({ adapter: "export default () => ({ main: () => 0 });", artifacts: { "tool.wasm": wasm, "data.bin": Uint8Array.of(1, 2, 3, 4) }, declaration: COMMAND_DECLARATION });
const serve = (served: Release["served"], counter?: { count: number }): Fetcher => url => {
  if (counter !== undefined) counter.count += 1;
  const bytes = served.get(url);
  return Promise.resolve(bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes.slice()));
};
const signal = () => new AbortController().signal;

describe("pinned artifacts", () => {
  it("compiles, copies and names verified files, fetching each at most once", async () => {
    const { descriptor, served } = await release(), counter = { count: 0 };
    const artifacts = createArtifacts(descriptor, serve(served, counter), signal());
    expect(await artifacts.compile("tool.wasm")).toBeInstanceOf(WebAssembly.Module);
    const first = await artifacts.bytes("data.bin");
    first.fill(9);
    expect([...await artifacts.bytes("data.bin")]).toEqual([1, 2, 3, 4]);
    await artifacts.compile("tool.wasm");
    expect(counter.count).toBe(2);
    expect(artifacts.url("data.bin")).toBe(descriptor.artifacts["data.bin"]?.url);
    const adapter = await artifacts.adapter();
    expect([adapter.size, adapter.type]).toEqual([descriptor.adapter.bytes, "text/javascript"]);
  });

  it("rejects a name the manifest does not declare, for bytes, compile and url alike", async () => {
    const { descriptor, served } = await release();
    const artifacts = createArtifacts(descriptor, serve(served), signal());
    await expect(artifacts.bytes("other.bin")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(artifacts.compile("toString")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(() => artifacts.url("__proto__")).toThrow(VMError);
  });

  it("reports an integrity error for altered, longer or shorter bytes, and says which", async () => {
    const { descriptor, served } = await release();
    const url = descriptor.artifacts["data.bin"]?.url ?? "";
    const cases: readonly (readonly [Uint8Array<ArrayBuffer>, RegExp])[] = [
      [Uint8Array.of(1, 2, 3, 5), /does not match its sha256 pin/u], [Uint8Array.of(1, 2, 3, 4, 5), /larger than its pin/u], [Uint8Array.of(1, 2, 3), /shorter than its pin/u],
    ];
    for (const [bytes, message] of cases) {
      const artifacts = createArtifacts(descriptor, serve(new Map([...served, [url, bytes]])), signal());
      await expect(artifacts.bytes("data.bin"), String(bytes.length)).rejects.toBeInstanceOf(IntegrityError);
      await expect(artifacts.bytes("data.bin")).rejects.toMatchObject({ detail: { reason: "wasm-module-integrity" } });
      await expect(artifacts.bytes("data.bin")).rejects.toThrow(message);
    }
  });

  it("stops reading a body that exceeds its pin instead of buffering it", async () => {
    const { descriptor } = await release();
    let pulls = 0, cancelled = false;
    const endless: Fetcher = () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    })));
    await expect(createArtifacts(descriptor, endless, signal()).bytes("data.bin")).rejects.toBeInstanceOf(IntegrityError);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(5);
  });

  it("distinguishes a missing file or a network failure from tampering", async () => {
    const { descriptor, served } = await release();
    const gone = new Map(served);
    gone.delete(descriptor.artifacts["data.bin"]?.url ?? "");
    await expect(createArtifacts(descriptor, serve(gone), signal()).bytes("data.bin")).rejects.toMatchObject({ code: "CORE_LOAD_FAILED", detail: { reason: "wasm-module-artifact" } });
    const offline: Fetcher = () => Promise.reject(new TypeError("Failed to fetch"));
    await expect(createArtifacts(descriptor, offline, signal()).bytes("data.bin")).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
  });

  it("passes the module's cancellation to the fetch and rethrows it unchanged", async () => {
    const { descriptor } = await release(), controller = new AbortController();
    const seen = vi.fn();
    const hanging: Fetcher = (_url, init) => new Promise<Response>((_resolve, reject) => { seen(init.signal === controller.signal); init.signal.addEventListener("abort", () => { reject(init.signal.reason instanceof Error ? init.signal.reason : new Error("aborted")); }); });
    const pending = createArtifacts(descriptor, hanging, controller.signal).bytes("data.bin");
    controller.abort(new Error("module stopped"));
    await expect(pending).rejects.toThrow("module stopped");
    expect(seen).toHaveBeenCalledWith(true);
  });
});

// Engine ADR 0027: a command a program in the VM runs uses the copies the Userspace worker verified when it was turned on.
describe("pre-verified copies", () => {
  it("never fetches or hashes: compile returns the verified module, bytes read the copy and url is a blob: URL until close", async () => {
    const { descriptor, ...rest } = await release(), copies = await commandLaunch({ descriptor, ...rest }, "tool");
    const compile = vi.spyOn(WebAssembly, "compile"), digest = vi.spyOn(crypto.subtle, "digest");
    try {
      const artifacts = preverifiedArtifacts(descriptor, copies);
      expect(await artifacts.adapter()).toBe(copies.adapter);
      await artifacts.verifyAll();
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
});
