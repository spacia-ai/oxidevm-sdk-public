import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { instantiateRuntime } from "./userspace-runtime.js";
import { JitDeferredInstall } from "./control/jit-deferred-install.js";
import { engineModulePath } from "./engine-wasm.test-support.js";

const HIGH_ADDRESS = 2_384_564_760;

// Re-export real i32 host imports so JS calls cross Wasm's signed i32 boundary.
function hostProbe(): WebAssembly.Module {
  const name = (value: string) => [value.length, ...new TextEncoder().encode(value)];
  const imports = [2,
    ...name("oxidevm_userspace_host"), ...name("clock_gettime"), 0, 0,
    ...name("oxidevm_userspace_host"), ...name("entropy_fill"), 0, 0,
  ];
  const exports = [2, ...name("clock_gettime"), 0, 0, ...name("entropy_fill"), 0, 1];
  return new WebAssembly.Module(Uint8Array.from([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    1, 7, 1, 0x60, 2, 0x7f, 0x7f, 1, 0x7f,
    2, imports.length, ...imports,
    7, exports.length, ...exports,
  ]));
}

async function observedHostRuntime() {
  const bytes = await readFile(engineModulePath("oxidevm_userspace.wasm"));
  const module = await WebAssembly.compile(new Uint8Array(bytes).buffer);
  const original = WebAssembly.instantiate;
  let imports: WebAssembly.Imports | undefined;
  const observation = vi.spyOn(WebAssembly, "instantiate").mockImplementation(async (compiled, supplied) => {
    imports = supplied;
    return original(compiled, supplied);
  });
  try {
    const runtime = await instantiateRuntime(module, "userspace.wasm", { kind: "disabled" });
    if (imports === undefined) throw new Error("Userspace host imports missing");
    const probe = await original(hostProbe(), imports);
    return { runtime, probe };
  } finally { observation.mockRestore(); }
}

function invoke(instance: WebAssembly.Instance, name: string, ...args: number[]): unknown {
  const fn = instance.exports[name];
  if (typeof fn !== "function") throw new Error(`Missing probe export ${name}`);
  const result: unknown = Reflect.apply(fn, undefined, args);
  return result;
}

it("fills real high-address Wasm memory with entropy after the heap exceeds 2 GiB", async () => {
  const { runtime, probe } = await observedHostRuntime();
  const calls: number[] = [];
  const entropy = vi.spyOn(crypto, "getRandomValues").mockImplementation(array => {
    if (!(array instanceof Uint8Array) || array.byteLength > 65_536) throw new Error("Invalid WebCrypto entropy span");
    calls.push(array.byteLength);
    array.fill(0xa5);
    return array;
  });
  try {
    const length = 70_001;
    runtime.memory.grow(Math.ceil((HIGH_ADDRESS + length + 1) / 65_536) - runtime.memory.buffer.byteLength / 65_536);
    const bytes = new Uint8Array(runtime.memory.buffer, HIGH_ADDRESS - 1, length + 2);
    bytes.fill(0x5a);
    expect(invoke(probe, "entropy_fill", HIGH_ADDRESS, length)).toBe(0);
    expect(calls).toEqual([65_536, length - 65_536]);
    expect(bytes.subarray(1, -1).every(byte => byte === 0xa5)).toBe(true);
    expect([bytes[0], bytes.at(-1)]).toEqual([0x5a, 0x5a]);
  } finally { entropy.mockRestore(); await runtime.jitRuntime.dispose(); }
});

it("writes the host clock to a high Wasm address and rejects an unsupported clock", async () => {
  const { runtime, probe } = await observedHostRuntime();
  const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  try {
    runtime.memory.grow(Math.ceil((HIGH_ADDRESS + 8) / 65_536) - runtime.memory.buffer.byteLength / 65_536);
    const view = new DataView(runtime.memory.buffer);
    view.setBigUint64(HIGH_ADDRESS, 17n, true);
    expect(invoke(probe, "clock_gettime", 2, HIGH_ADDRESS)).toBe(1);
    expect(view.getBigUint64(HIGH_ADDRESS, true)).toBe(17n);
    expect(invoke(probe, "clock_gettime", 0, HIGH_ADDRESS)).toBe(0);
    expect(view.getBigUint64(HIGH_ADDRESS, true)).toBe(1_700_000_000_000_000_000n);
  } finally { now.mockRestore(); await runtime.jitRuntime.dispose(); }
});

// API 27 admits unbounded workspace snapshots; engine main and the extracted SDK each shipped a different API 28.
it.each([27, 28, 44, 56])("rejects superseded Userspace API %i before admission", async (version) => {
  const name = new TextEncoder().encode("oxidevm_userspace_api_version");
  const exports = [2, 6, ...new TextEncoder().encode("memory"), 2, 0, name.length, ...name, 0, 0];
  const legacy = new WebAssembly.Module(new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    1, 5, 1, 96, 0, 1, 127, // () -> i32
    3, 2, 1, 0,
    5, 3, 1, 0, 1, // one memory page
    7, exports.length, ...exports,
    10, 6, 1, 4, 0, 65, version, 11,
  ]));
  await expect(instantiateRuntime(legacy, "legacy.wasm", { kind: "disabled" })).rejects.toMatchObject({
    code: "CORE_LOAD_FAILED", message: "Userspace Wasm API is unsupported",
  });
});

it("keeps batched compilation on process-free mounting and permits immediate diagnostics", async () => {
  const bytes = await readFile(engineModulePath("oxidevm_userspace.wasm"));
  const module = await WebAssembly.compile(new Uint8Array(bytes).buffer);
  const invalidation = vi.spyOn(JitDeferredInstall.prototype, "invalidate");
  try {
    for (const mode of ["batched", "immediate"] as const) {
      const runtime = await instantiateRuntime(module, "userspace.wasm", { kind: "disabled" }, mode === "batched" ? undefined : mode);
      try {
        const install = invalidation.mock.contexts.at(-1);
        expect(install instanceof JitDeferredInstall && install.mode).toBe(mode);
      }
      finally { await runtime.jitRuntime.dispose(); }
    }
  } finally { invalidation.mockRestore(); }
});
