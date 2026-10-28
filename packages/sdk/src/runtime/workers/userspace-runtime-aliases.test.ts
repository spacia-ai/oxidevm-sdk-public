import { expect, it } from "vitest";
import { instantiateRuntime } from "./userspace-runtime.js";

it("rejects API142 and requires alias provenance exports under API143", async () => {
  for (const version of [142, 143]) {
    const name = new TextEncoder().encode("oxidevm_userspace_api_version");
    const exports = [2, 6, ...new TextEncoder().encode("memory"), 2, 0, name.length, ...name, 0, 0];
    const module = new WebAssembly.Module(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0,
      1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 5, 3, 1, 0, 1,
      7, exports.length, ...exports,
      10, 7, 1, 5, 0, 65, (version & 127) | 128, 1, 11,
    ]));
    await expect(instantiateRuntime(module, "alias-api.wasm", { kind: "disabled" })).rejects.toMatchObject({
      code: "CORE_LOAD_FAILED",
      message: version === 142 ? "Userspace Wasm API is unsupported" : "Userspace JIT alias exports are missing",
    });
  }
});
