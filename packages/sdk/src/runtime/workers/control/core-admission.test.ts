import { expect, it } from "vitest";
import { JIT_API_VERSION } from "../../core-abi/jit.js";
import { JIT_CACHE_BYTES } from "../../jit-cache.js";
import { CORE_API_VERSION, createCore } from "./core.js";

/** Loads a core that reports the given identities; every other export succeeds. */
function load(coreApi: number, jitApi: number): () => unknown {
  const reported: Record<string, unknown> = { oxidevm_api_version: () => coreApi, oxidevm_jit_api_version: () => jitApi };
  const exports = new Proxy(reported, {
    get: (target, key) => typeof key === "string" ? target[key] ?? (() => 0) : undefined,
  });
  return () => createCore(exports, new WebAssembly.Memory({ initial: 2 }), "admission-test", JIT_CACHE_BYTES);
}

it("admits only the merged engine's core API and JIT ABI", () => {
  expect(load(CORE_API_VERSION, JIT_API_VERSION)).not.toThrow();
  // Engine main and the extracted SDK each shipped a different core API 15; the SDK also kept JIT ABI 58.
  // Core API 16 predates the license admission export (ADR 0021).
  for (const coreApi of [14, 15, 16, 17, 18, 20]) expect(load(coreApi, JIT_API_VERSION)).toThrow(/unsupported core ABI version/u);
  for (const jitApi of [58, 59, 60, 61, 62, 84, 85, 86, 87, 89]) {
    expect(load(CORE_API_VERSION, jitApi)).toThrow(`unsupported JIT ABI version ${jitApi}; expected ${JIT_API_VERSION}`);
  }
});
