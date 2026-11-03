import { productionJavaScript } from "../../../../scripts/production-javascript.ts";
import { fileURLToPath, URL } from "node:url";
import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

import { defineConfig } from "vite";

import { RUNTIME_HOST_HEADERS } from "./headers.ts";

/** The module frame directory (ADR 0028), built by scripts/build-module-frame.ts, served beside the frame as `module-frame/`. */
const MODULE_FRAME_FILES = ["index.html", "broker.js", "runner.js", "frame.json"] as const;
const moduleFrameFile = (name: string): URL => new URL(`../../assets/module-frame/${name}`, import.meta.url);
async function moduleFrameHeaders(): Promise<Readonly<Record<string, string>>> {
  const frame: unknown = JSON.parse(await readFile(moduleFrameFile("frame.json"), "utf8"));
  const headers: unknown = typeof frame === "object" && frame !== null ? Reflect.get(frame, "headers") : undefined;
  if (typeof headers !== "object" || headers === null) throw new Error("assets/module-frame/frame.json has no headers: run scripts/build-module-frame.ts");
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)]));
}

/** Serves `module-frame/` in development with the frame's own headers, never the runtime frame's. */
function moduleFrameServer(): Plugin {
  return {
    name: "oxidevm-module-frame",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? "/", "http://frame.invalid").pathname, match = /\/module-frame\/([^/]*)$/u.exec(path);
        const name = match === null ? undefined : match[1] === "" ? "index.html" : match[1];
        if (name === undefined || !MODULE_FRAME_FILES.some(file => file === name)) { next(); return; }
        void Promise.all([readFile(moduleFrameFile(name)), moduleFrameHeaders()]).then(([body, headers]) => {
          response.writeHead(200, { ...headers, "Content-Type": name.endsWith(".html") ? "text/html; charset=utf-8" : name.endsWith(".json") ? "application/json" : "text/javascript" });
          response.end(body);
        }, (error: unknown) => { next(error); });
      });
    },
  };
}

// The runtime frame's page: built with relative URLs so one build serves under /v/<sdkVersion>/
// on any origin, with the engine release one level up in /engine/<release-id>/.
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  // The boot ping goes to the frame's own origin (ADR 0021; on since 2026-10-09): only Spacia's
  // run.oxidevm.dev records it. OXIDEVM_TELEMETRY_ENDPOINT="" builds a frame that sends none.
  define: { OXIDEVM_TELEMETRY_ENDPOINT: JSON.stringify(process.env["OXIDEVM_TELEMETRY_ENDPOINT"] ?? "/__t/v1/boot") },
  plugins: [productionJavaScript(), moduleFrameServer(), {
    name: "oxidevm-runtime-host-contract",
    async generateBundle(_options, bundle) {
      this.emitFile({ type: "asset", fileName: "headers.json", source: `${JSON.stringify(RUNTIME_HOST_HEADERS, null, 2)}\n` });
      // The module frame directory ships beside the frame, outside the offline shell: it keeps its own headers.
      for (const name of MODULE_FRAME_FILES) this.emitFile({ type: "asset", fileName: `module-frame/${name}`, source: await readFile(moduleFrameFile(name)) });
      for (const name of ["esbuild-LICENSE.txt", "Go-LICENSE.txt", "esbuild.provenance.json"]) this.emitFile({ type: "asset", fileName: `licenses/esbuild/${name}`, source: await readFile(new URL(`../../assets/compilers/${name}`, import.meta.url), "utf8") });
      // Everything the offline shell precaches: every built file except the worker and contract files.
      const files = Object.keys(bundle).filter(name => name !== "sw.js" && name !== "headers.json" && !name.startsWith("module-frame/")
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
