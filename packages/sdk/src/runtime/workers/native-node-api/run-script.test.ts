import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import * as compilerNamespace from "@swc/wasm-web";
import { record } from "../../decode.js";
import { isVMError } from "../../errors.js";
import { initializeCompiler } from "../assistance/compiler.js";
import { nativeScriptRunner } from "./scripts.js";
import { NativeValues } from "./values.js";

/** Pinned Node 24.18.1's napi_run_script answers to the engine's run-script driver (ADR 0026, 2.12). */
const control = record(JSON.parse(readFileSync(new URL("./run-script.controls.json", import.meta.url), "utf8")), "run-script controls");
const require = createRequire(import.meta.url);
const driverPath = require.resolve("../../../../../../tests/fixtures/native-node-api/run-script.cjs");
const driver: unknown = require(driverPath);
const empty = new Uint8Array();

it("replays the driver the engine recorded", () => {
  expect(createHash("sha256").update(readFileSync(driverPath)).digest("hex")).toBe(control["driverSHA256"]);
});

it("runs declaration-free scripts as Node does and refuses scripts that declare global bindings", async () => {
  const root = dirname(require.resolve("@swc/wasm-web"));
  const compiler = initializeCompiler(compilerNamespace, await WebAssembly.compile(await readFile(join(root, "wasm_bg.wasm"))));
  const values = new NativeValues(() => undefined, () => undefined);
  values.bindScriptRunner(nativeScriptRunner(compiler));
  const inspect = (source: unknown): unknown[] => {
    let reply;
    try { reply = values.dispatch("napi_run_script", [values.add(source)], empty); }
    catch (error) {
      if (isVMError(error)) return [-1, Object.assign(new Error(error.message), { name: `LateFailure:${String(error.detail?.["lateFailure"])}:${String(error.detail?.["subject"])}` })];
      throw error;
    }
    const pending = values.dispatch("napi_is_exception_pending", [], empty).args[0] === 1n;
    if (pending) return [reply.status, values.get(values.dispatch("napi_get_and_clear_last_exception", [], empty).args[0] ?? 0n)];
    return [reply.status, reply.status === 0 ? values.get(reply.args[0] ?? 0n) : undefined];
  };
  if (typeof driver !== "function") throw new Error("Missing run-script driver");
  const observed: unknown = JSON.parse(String(Reflect.apply(driver, undefined, [inspect])));
  const rows: unknown = control["rows"];
  if (!Array.isArray(rows)) throw new Error("Invalid run-script rows");
  const expected = rows.map((value: unknown): unknown => {
    if (!Array.isArray(value)) throw new Error("Invalid control row");
    const row: readonly unknown[] = value, name = row[0];
    if (typeof name !== "string") throw new Error("Invalid control row name");
    // A Script's global bindings need a classic script in the process realm (path B, ADR 0026).
    return name.startsWith("declares/") ? [name, -1, "error:LateFailure:unsupported-node-api:napi_run_script"] : row;
  });
  expect(observed).toEqual(expected);
});
