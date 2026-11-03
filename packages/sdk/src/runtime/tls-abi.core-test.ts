import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { TLS_API_VERSION, TLS_EXPORTS, TLS_LINKER_EXPORTS } from "./tls-abi.js";
import { engineModulePath } from "./workers/engine-wasm.test-support.js";

it("pins the engine's TLS module (release.json schema 4): exactly its oxidevm_tls_* functions and linker exports, no imports, and TLS API 2", async () => {
  const module = await WebAssembly.compile(await readFile(engineModulePath("oxidevm_tls.wasm")));
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const exports = WebAssembly.Module.exports(module).map(entry => `${entry.kind} ${entry.name}`).sort();
  expect(exports).toEqual([...TLS_EXPORTS.map(name => `function ${name}`), ...TLS_LINKER_EXPORTS.map(([name, kind]) => `${kind} ${name}`)].sort());
  const instance = await WebAssembly.instantiate(module, {});
  const version: unknown = instance.exports["oxidevm_tls_api_version"];
  if (typeof version !== "function") throw new Error("oxidevm_tls_api_version is not a function");
  expect(Reflect.apply(version, undefined, [])).toBe(TLS_API_VERSION);
});
