import { defineConfig } from "vite";
import { previewHost } from "./dev/preview-host.ts";
import { runtimeAssets } from "./dev/runtime-assets.ts";

export default defineConfig({
  plugins: [previewHost(), runtimeAssets()],
  server: { host: "127.0.0.1", headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } },
  preview: { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } },
  worker: { format: "es" },
  optimizeDeps: { noDiscovery: true, include: ["@xterm/xterm", "@xterm/addon-fit"], exclude: ["@oxidevm/sdk"] },
});
