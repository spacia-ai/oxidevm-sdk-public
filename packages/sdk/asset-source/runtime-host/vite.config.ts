import { productionJavaScript } from "../../../../scripts/production-javascript.ts";
import { fileURLToPath, URL } from "node:url";
import { readFile } from "node:fs/promises";

import { defineConfig } from "vite";

import { RUNTIME_HOST_HEADERS } from "./headers.ts";

// The runtime frame's page: built with relative URLs so one build serves under /v/<sdkVersion>/
// on any origin, with the engine release one level up in /engine/<release-id>/.
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  // The boot ping goes to the frame's own origin (ADR 0021; on since 2026-10-09): only Spacia's
  // run.oxidevm.dev records it. OXIDEVM_TELEMETRY_ENDPOINT="" builds a frame that sends none.
  define: { OXIDEVM_TELEMETRY_ENDPOINT: JSON.stringify(process.env["OXIDEVM_TELEMETRY_ENDPOINT"] ?? "/__t/v1/boot") },
  plugins: [productionJavaScript(), {
    name: "oxidevm-runtime-host-contract",
    async generateBundle(_options, bundle) {
      this.emitFile({ type: "asset", fileName: "headers.json", source: `${JSON.stringify(RUNTIME_HOST_HEADERS, null, 2)}\n` });
      for (const name of ["esbuild-LICENSE.txt", "Go-LICENSE.txt", "esbuild.provenance.json"]) this.emitFile({ type: "asset", fileName: `licenses/esbuild/${name}`, source: await readFile(new URL(`../../assets/compilers/${name}`, import.meta.url), "utf8") });
      // Everything the offline shell precaches: every built file except the worker and contract files.
      const files = Object.keys(bundle).filter(name => name !== "sw.js" && name !== "headers.json"
        && !name.startsWith("licenses/esbuild/")
        && !/^assets\/esbuild(?:\.worker)?-[A-Za-z\d_-]+\.(?:wasm|js)$/u.test(name)).sort();
      this.emitFile({ type: "asset", fileName: "shell-manifest.json", source: `${JSON.stringify(files)}\n` });
    },
  }],
  build: {
    outDir: "../../assets/runtime-host", emptyOutDir: true, sourcemap: false,
    rollupOptions: {
      input: { index: fileURLToPath(new URL("./index.html", import.meta.url)), sw: fileURLToPath(new URL("./src/sw.ts", import.meta.url)) },
      output: { entryFileNames: chunk => chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js" },
    },
  },
  worker: { format: "es", plugins: () => [productionJavaScript()] },
  server: { headers: RUNTIME_HOST_HEADERS },
  preview: { headers: RUNTIME_HOST_HEADERS },
});
