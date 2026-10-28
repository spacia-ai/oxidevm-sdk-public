import { productionJavaScript } from "../../../../scripts/production-javascript.ts";
import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

import { classicEntries } from "./classic-entries";
import { PREVIEW_HEADERS } from "./headers.ts";
export { PREVIEW_HEADERS } from "./headers.ts";

export default defineConfig({
  root: import.meta.dirname,
  base: "/__oxidevm/",
  plugins: [productionJavaScript(), classicEntries(import.meta.dirname, PREVIEW_HEADERS), {
    name: "oxidevm-preview-hosting-contract",
    generateBundle() { this.emitFile({ type: "asset", fileName: "headers.json", source: `${JSON.stringify(PREVIEW_HEADERS, null, 2)}\n` }); },
  }],
  build: {
    outDir: "../../assets/preview", emptyOutDir: true,
    rollupOptions: {
      input: {
        bootstrap: fileURLToPath(new URL("./index.html", import.meta.url)),
        "service-worker": fileURLToPath(new URL("./src/service-worker.ts", import.meta.url)),
        websocket: fileURLToPath(new URL("./src/websocket.ts", import.meta.url)),
        location: fileURLToPath(new URL("./src/location.ts", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => chunk.name === "service-worker" ? "sw.js"
          : chunk.name === "bootstrap" || chunk.name === "websocket" || chunk.name === "location" ? `${chunk.name}.js`
            : "assets/[name]-[hash].js",
      },
    },
  },
  // Sessions run on <session>.localhost in development; the shared address over Tailscale is on .ts.net.
  server: { headers: PREVIEW_HEADERS, allowedHosts: [".localhost", "localhost", ".ts.net"] },
  preview: { headers: PREVIEW_HEADERS },
});
