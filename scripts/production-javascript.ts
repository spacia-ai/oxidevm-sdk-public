import { transform } from "esbuild";
import type { Plugin } from "vite";

/** Keep public exports and observable function names while shortening implementation identifiers. */
export async function minifyJavaScript(code: string, keepNames = true): Promise<string> {
  return (await transform(code, { loader: "js", target: "es2024", format: "esm", minify: true,
    keepNames, sourcemap: false, legalComments: "eof" })).code;
}

/** Runs before Rollup computes asset names, including ES libraries Vite leaves partly formatted. */
export function productionJavaScript(): Plugin {
  return { name: "oxidevm-production-javascript", enforce: "post", apply: "build",
    async renderChunk(code) { return { code: await minifyJavaScript(code, false), map: null }; } };
}
