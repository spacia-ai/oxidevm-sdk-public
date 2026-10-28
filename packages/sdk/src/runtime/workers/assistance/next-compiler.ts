import { VMError } from "../../errors.ts";

export const NEXT_COMPILER_BUILTIN = "oxidevm/next-swc";
export const NEXT_COMPILER_DIRECTORY = "/usr/lib/oxidevm/registry/next-swc";
const methods = ["transform", "transformSync", "minify", "minifySync", "parse", "parseSync",
  "mdxCompile", "mdxCompileSync", "expandNextJsTemplate", "codeFrameColumns"] as const;
export type NextCompilerBindings = Readonly<Record<string, (...args: unknown[]) => unknown>>;

/** A real managed-image file, resolved and read through Linux like other ESM.
 * Only its finite compiler capability is supplied by the verified worker. */
export const NEXT_COMPILER_FACADE = `export { ${methods.join(", ")} } from "node:${NEXT_COMPILER_BUILTIN}";\n`;

export function verifyNextCompilerFacade(source: unknown): void {
  if (source !== NEXT_COMPILER_FACADE) throw new VMError("PROTOCOL_ERROR", "Managed Next compiler facade does not match the verified runtime", {
    path: `${NEXT_COMPILER_DIRECTORY}/wasm.js`,
  });
}

/** These are pinned Next 16.2.12 loader controls, not project configuration.
 * The official direct-bindings path avoids web init's raw Wasm return value.
 * The memory opt-out prevents automatic V8 heap flags that workers cannot enforce. */
export function nextCompilerEnvironment(env: Readonly<Record<string, string>>): Record<string, string> {
  return { ...env, NEXT_TEST_WASM: "1", NEXT_TEST_WASM_DIR: NEXT_COMPILER_DIRECTORY,
    NEXT_DISABLE_SWC_WASM: "", NEXT_IGNORE_INCORRECT_LOCKFILE: "1", NEXT_TELEMETRY_DISABLED: "1", NEXT_DISABLE_MEM_OVERRIDE: "1" };
}

/** Official bindings are bundled into the verified runtime. Initialization is
 * synchronous with a broker-supplied module, so it cannot download a compiler. */
export function initializeNextCompiler(namespace: unknown, module: WebAssembly.Module): NextCompilerBindings {
  if (typeof namespace !== "object" || namespace === null) throw new TypeError("Missing official Next compiler bindings");
  for (const name of ["initSync", ...methods]) {
    if (typeof Reflect.get(namespace, name) !== "function") throw new TypeError(`Official Next compiler is missing ${name}`);
  }
  const initialize: unknown = Reflect.get(namespace, "initSync");
  if (typeof initialize !== "function") throw new TypeError("Missing official Next compiler initializer");
  Reflect.apply(initialize, namespace, [{ module }]);
  const bindings: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of methods) {
    const operation: unknown = Reflect.get(namespace, name);
    if (typeof operation !== "function") throw new TypeError(`Official Next compiler is missing ${name}`);
    bindings[name] = (...args: unknown[]): unknown => Reflect.apply(operation, namespace, args);
  }
  return Object.freeze(bindings);
}
