// The preview worker and the scripts it injects into pages are classic scripts:
// a module Service Worker would differ between development and builds, and an
// injected <script src> runs without type="module". Development serves each one
// bundled by esbuild under the /__oxidevm/ base, as builds emit them; the build
// guard keeps Rollup from turning one into a module through a shared chunk, and
// wraps each one in a function as esbuild's iife does, because a classic script's
// top-level names share the page's global scope with the app's own scripts.
import { resolve } from "node:path";

import { build } from "esbuild";
import type { Plugin, Rollup } from "vite";

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

/** One classic script, bundled self-contained for the development server. */
export async function bundleClassicEntry(root: string, file: ClassicFile): Promise<string> {
  const result = await build({
    entryPoints: [resolve(root, CLASSIC_ENTRIES[file])],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2024",
    sourcemap: "inline",
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error(`${file} produced no output`);
  return output.text;
}

/** A built classic script in a function scope of its own, as esbuild's iife wraps it. */
export function classicScript(code: string): string {
  return `(() => {\n${code}\n})();\n`;
}

/** Fails the build when a classic script came out of Rollup as a module. */
export function assertClassicChunk(chunk: Pick<Rollup.OutputChunk, "fileName" | "imports" | "dynamicImports" | "exports" | "code">): void {
  if (chunk.imports.length !== 0 || chunk.dynamicImports.length !== 0 || chunk.exports.length !== 0 || /\bimport\.meta\b/u.test(chunk.code)) {
    throw new Error(`${chunk.fileName} must be a classic script`);
  }
}

/** Serves the classic scripts in development and checks them in builds. */
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
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk" || !CLASSIC_FILES.some((file) => file === output.fileName)) continue;
        assertClassicChunk(output);
        output.code = classicScript(output.code);
      }
    },
  };
}
