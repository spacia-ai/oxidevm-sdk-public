import { productionJavaScript } from "../../../../scripts/production-javascript.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);
const compiler = dirname(require.resolve("@swc/wasm-web"));
const metadata: unknown = JSON.parse(readFileSync(join(compiler, "package.json"), "utf8"));
assert(typeof metadata === "object" && metadata !== null && "version" in metadata && metadata.version === "1.16.18");
const parser: unknown = require("undici/lib/llhttp/llhttp-wasm.js");
assert(Buffer.isBuffer(parser));
// Vite 8 bundles with Rolldown, which, unlike Vite 7's CommonJS plugin, leaves Node's free `global` in CommonJS
// dependencies (@babel/traverse's evaluator reads global[name]) as is; a worker has no `global`.
const defines = {
  global: "globalThis",
  NATIVE_COMPILER_WASM_BASE64: JSON.stringify(readFileSync(join(compiler, "wasm_bg.wasm")).toString("base64")),
  NATIVE_HTTP_PARSER_BASE64: JSON.stringify(parser.toString("base64")),
  ASSISTANCE_SYSTEM_SOURCE: JSON.stringify(readFileSync(require.resolve("systemjs/dist/s.min.js"), "utf8").replace(/^\/\/# sourceMappingURL=.*$/gmu, "")),
};
export default defineConfig({ plugins: [productionJavaScript()], root: import.meta.dirname, base: "./", define: defines,
  build: { outDir: "../../assets/native-process", emptyOutDir: true, target: "esnext" },
  worker: { format: "es", plugins: () => [productionJavaScript(), { name: "native-runtime-build-inputs", config: () => ({ define: defines }) }] },
});
