import { productionJavaScript } from "../../../../scripts/production-javascript.ts";
import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

import { classicEntries } from "./classic-entries.ts";
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
    rolldownOptions: {
      input: {
        bootstrap: fileURLToPath(new URL("./index.html", import.meta.url)),
      },
      output: { entryFileNames: (chunk) => chunk.name === "bootstrap" ? "bootstrap.js" : "assets/[name]-[hash].js" },
    },
  },
  // Sessions run on <session>.localhost in development; the shared address over Tailscale is on .ts.net.
  server: { headers: PREVIEW_HEADERS, allowedHosts: [".localhost", "localhost", ".ts.net"] },
  preview: { headers: PREVIEW_HEADERS },
});
