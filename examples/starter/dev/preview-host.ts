import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Connect, Plugin } from "vite";

const files = new Map([["index.html", "text/html"], ["bootstrap.js", "text/javascript"], ["location.js", "text/javascript"], ["sw.js", "text/javascript"], ["websocket.js", "text/javascript"]]);

export function isPreviewHost(host: string): boolean {
  return /^(?:[a-f0-9]{32}\.)?preview\.localhost(?::[0-9]{1,5})?$/u.test(host);
}

/** One static Vite server serves the app and isolated preview hosts. Guest HTTP stays in the SDK. */
export function previewHost(): Plugin {
  const assets = new URL("../assets/preview/", pathToFileURL(createRequire(import.meta.url).resolve("@oxidevm/sdk")));
  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    if (!isPreviewHost(request.headers.host ?? "")) { next(); return; }
    const pathname = new URL(request.url ?? "/", "http://preview.localhost").pathname;
    const file = pathname === "/__oxidevm/" ? "index.html" : pathname.startsWith("/__oxidevm/") ? pathname.slice("/__oxidevm/".length) : "";
    const type = files.get(file);
    if ((request.method !== "GET" && request.method !== "HEAD") || type === undefined) { response.writeHead(404).end(); return; }
    void (async () => {
      response.setHeader("Content-Type", type);
      const headers: unknown = JSON.parse(await readFile(new URL("headers.json", assets), "utf8"));
      if (typeof headers !== "object" || headers === null || Array.isArray(headers)) throw new Error("Invalid SDK preview headers");
      const entries: [string, unknown][] = Object.entries(headers);
      for (const [name, value] of entries) {
        if (typeof value !== "string") throw new Error("Invalid SDK preview header");
        response.setHeader(name, value);
      }
      const body = await readFile(fileURLToPath(new URL(file, assets)));
      response.end(request.method === "HEAD" ? undefined : body);
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  };
  return { name: "oxidevm-starter-preview", configureServer(server) { server.middlewares.use(middleware); }, configurePreviewServer(server) { server.middlewares.use(middleware); } };
}
