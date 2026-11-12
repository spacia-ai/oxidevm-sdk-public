// The preview worker and the scripts it injects into pages are classic scripts:
// a module Service Worker would differ between development and builds, and an
// injected <script src> runs without type="module". Development serves each one
// bundled by esbuild under the /__oxidevm/ base, and builds emit the same bundles. Each one is
// wrapped in a function by esbuild's iife, because a classic script's top-level names share the
// page's global scope with the app's own scripts.
import { resolve } from "node:path";

import { build } from "esbuild";
import type { Plugin } from "vite";

/** Each classic script, by its published name under /__oxidevm/, and its source. */
export const CLASSIC_ENTRIES = {
  "sw.js": "src/service-worker.ts",
  "websocket.js": "src/websocket.ts",
  "location.js": "src/location.ts",
} as const;
export type ClassicFile = keyof typeof CLASSIC_ENTRIES;
export const CLASSIC_FILES: readonly ClassicFile[] = ["sw.js", "websocket.js", "location.js"];

const BASE = "/__oxidevm/";

/** The classic script a request path names, if any. */
export function classicEntryFor(pathname: string): ClassicFile | undefined {
  if (!pathname.startsWith(BASE)) return undefined;
  const name = pathname.slice(BASE.length);
  return CLASSIC_FILES.find((file) => file === name);
}

/**
 * One classic script, bundled self-contained for the development server (inline source map) and,
 * minified, for builds. A warning fails it: esbuild turns `import.meta` into an empty object with
 * only a warning, and a classic script that used it would break at runtime.
 */
export async function bundleClassicEntry(root: string, file: ClassicFile, minify = false): Promise<string> {
  const result = await build({
    entryPoints: [resolve(root, CLASSIC_ENTRIES[file])],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2024",
    sourcemap: minify ? false : "inline",
    minify,
    logLevel: "silent",
  });
  const warning = result.warnings[0];
  if (warning !== undefined) throw new Error(`${file} must be a classic script: ${warning.text}`);
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error(`${file} produced no output`);
  return output.text;
}

/** Serves the classic scripts in development and emits them in builds. */
export function classicEntries(root: string, headers: Readonly<Record<string, string>>): Plugin {
  return {
    name: "oxidevm-classic-entries",
    configureServer(server) {
      // Added before Vite's own middlewares, so the base is still on the path.
      server.middlewares.use((request, response, next) => {
        if (request.method !== "GET" && request.method !== "HEAD") {
          next();
          return;
        }
        const file = classicEntryFor(new URL(request.url ?? "/", "http://preview.invalid").pathname);
        if (file === undefined) {
          next();
          return;
        }
        bundleClassicEntry(root, file).then((code) => {
          for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.end(request.method === "HEAD" ? undefined : code);
        }, (error: unknown) => {
          next(error);
        });
      });
    },
    // Each classic script is bundled on its own, as in development, so a module that two of them
    // (or the bootstrap page) share is copied into each instead of becoming a shared chunk.
    async generateBundle() {
      for (const file of CLASSIC_FILES) {
        this.emitFile({ type: "asset", fileName: file, source: await bundleClassicEntry(root, file, true) });
      }
    },
  };
}
