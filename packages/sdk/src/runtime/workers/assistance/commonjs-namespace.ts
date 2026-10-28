import { initSync, parse } from "cjs-module-lexer";
import type { LocalModuleFiles } from "./module-files.ts";

// Initialize the embedded, pinned lexer before application code can change
// process globals. This module is part of the verified execution-worker bundle.
initSync();

/** Static names only: linking a CommonJS import must not run application code.
 * The lexer implements Node's frozen export-detection patterns. Re-export
 * discovery uses the same admitted Linux resolver as require(). */
export function commonJSNames(path: string, source: string, files: LocalModuleFiles,
  resolve: (specifier: string, parent: string) => string): string[] {
  const names = new Set<string>(["default", "module.exports"]);
  const visited = new Set<string>();
  function visit(filename: string, text: string): void {
    if (visited.has(filename)) return;
    visited.add(filename);
    let parsed: ReturnType<typeof parse>;
    try { parsed = parse(text, filename); }
    catch { return; } // Syntax errors belong to evaluation, as in Node's CJS loader.
    for (const name of parsed.exports) names.add(name);
    for (const specifier of parsed.reexports) {
      // A statically detected require can be in a branch that never executes.
      // Failure to discover its names must not execute or reject that branch.
      let target: string;
      let input: ReturnType<LocalModuleFiles["read"]>;
      try {
        target = resolve(specifier, filename);
        if (target.startsWith("node:")) continue;
        input = files.read(target);
      } catch { continue; }
      if (input.format === "commonjs") visit(target, input.source);
    }
  }
  visit(path, source);
  return [...names];
}

/** This wrapper executes in the existing ESM graph, after linking. It snapshots
 * named properties once; the default and module.exports bindings retain the
 * exact object owned by require.cache. */
export function commonJSSource(names: readonly string[]): string {
  return `const values = __oxidevm_commonjs();\n${names.map((name, index) =>
    `const binding${index} = values[${index}]; export { binding${index} as ${JSON.stringify(name)} };`).join("\n")}`;
}

export function commonJSValues(exports: unknown, names: readonly string[]): unknown[] {
  return names.map(name => {
    if (name === "default" || name === "module.exports") return exports;
    try {
      if (exports != null && Object.hasOwn(exports, name)) {
        const value: unknown = Reflect.get(Object(exports), name);
        return value;
      }
    } catch { /* Throwing getters do not fail CommonJS namespace construction. */ }
    return undefined;
  });
}
