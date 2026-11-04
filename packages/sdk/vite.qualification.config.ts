import { productionJavaScript } from "../../scripts/production-javascript.ts";
import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({ plugins: [productionJavaScript()],
  root: import.meta.dirname,
  base: "./",
  build: { outDir: "assets/qualification", emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0,
    rolldownOptions: { preserveEntrySignatures: "strict", input: { client: resolve(import.meta.dirname, "src/browser-test/client.ts"), "wasm-client": resolve(import.meta.dirname, "src/browser-test/wasm/client.ts") },
      output: { entryFileNames: "[name].js" } } },
  worker: { format: "es", plugins: () => [productionJavaScript()] },
});
