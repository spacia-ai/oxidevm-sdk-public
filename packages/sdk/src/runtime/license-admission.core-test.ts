import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { admitLicense } from "../license-admission.js";
import { engineModulePath } from "./workers/engine-wasm.test-support.js";

it("admits a compiled native engine without compiling it again", async () => {
  const module = await WebAssembly.compile(await readFile(engineModulePath("oxidevm_userspace.wasm")));
  const compile = vi.spyOn(WebAssembly, "compile");
  try {
    await expect(admitLicense(module, { runtimeOrigin: "http://localhost:5173", embedderOrigin: "http://localhost:5173", nowSeconds: 1_800_000_000 })).resolves.toEqual({ tier: "development" });
    expect(compile).not.toHaveBeenCalled();
  } finally { compile.mockRestore(); }
});

// The pinned engine's own admission rules, through the module the SDK verifies (ADR 0021).
it.each(["oxidevm_core.wasm", "oxidevm_userspace.wasm"] as const)("%s admits the frame, development and refuses an unlicensed mirror", async name => {
  const bytes = await readFile(engineModulePath(name));
  const admit = (runtimeOrigin: string, embedderOrigin: string, token?: string) =>
    admitLicense(bytes, { runtimeOrigin, embedderOrigin, ...(token === undefined ? {} : { token }), nowSeconds: 1_800_000_000 });
  await expect(admit("https://run.oxidevm.dev", "https://shop.example.net")).rejects.toMatchObject({ code: "PERMISSION_DENIED", detail: { reason: "license-required", rejected: "public-requires-license" } });
  await expect(admit("https://run.oxidevm.dev", "https://shop.example.net", "oxl1.AQ.AA")).rejects.toMatchObject({ code: "PERMISSION_DENIED", detail: { reason: "license-invalid", rejected: "malformed" } });
  await expect(admit("http://localhost:5173", "http://localhost:5173")).resolves.toEqual({ tier: "development" });
  await expect(admit("https://vm.example.com", "https://vm.example.com")).rejects.toMatchObject({ code: "PERMISSION_DENIED", detail: { reason: "license-required" } });
});
