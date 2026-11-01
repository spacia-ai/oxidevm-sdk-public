import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { VMError } from "../runtime/errors.js";
import { MAX_ARTIFACT_BYTES } from "../wasm/manifest-parts.js";
import {isolatedHeaders,serveStaticFile} from "./static-files.js";

interface ImageTestServingOptions {
  /** The image bundle and the manifest path it is served under; both or neither. */
  readonly bundleDir?: string;
  readonly manifestPath?: string;
  readonly engineDir: string;
  readonly engineCompliance?: { readonly directory: string; readonly sha256: string };
  readonly browserDir: string;
  readonly configuration?: unknown;
  /** Builds the configuration once the origin is known; it takes precedence over `configuration`. */
  readonly configure?: (origin: string) => unknown;
  /** The qualification page script; `client.js` unless the page tests a module. */
  readonly entry?: "client.js" | "wasm-client.js";
  /** A built module release served at /module/, and again at /module-tampered/ with the first byte of `tamper` inverted. */
  readonly module?: { readonly directory: string; readonly tamper: string };
}
export interface ImageTestServer { readonly origin: string; close(): Promise<void> }

export async function startImageTestServer(options: ImageTestServingOptions): Promise<ImageTestServer> {
  const { bundleDir, manifestPath } = options;
  if ((bundleDir === undefined) !== (manifestPath === undefined)) throw new VMError("PROTOCOL_ERROR", "an image bundle needs its manifest serving path");
  if (manifestPath !== undefined && (!manifestPath.startsWith("/") || !manifestPath.endsWith("/manifest.json"))) throw new VMError("PROTOCOL_ERROR", "image manifest requires a static directory serving path");
  const imagePrefix = manifestPath === undefined ? undefined : `${dirname(manifestPath)}/`;
  let configuration = JSON.stringify(options.configuration ?? null);
  const entry = options.entry ?? "client.js", module = options.module;
  const compliance = options.engineCompliance;
  if (compliance !== undefined && !/^[a-f0-9]{64}$/u.test(compliance.sha256)) throw new VMError("PROTOCOL_ERROR", "invalid engine compliance serving revision");
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    isolatedHeaders(response);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if ((request.method !== "GET" && request.method !== "HEAD") || url.search !== "") { response.writeHead(404); response.end(); return; }
    if (url.pathname === "/fixture.json") { response.setHeader("Content-Type", "application/json"); response.end(request.method === "HEAD" ? undefined : configuration); return; }
    if (url.pathname === "/") { response.setHeader("Content-Type", "text/html"); response.end(request.method === "HEAD" ? undefined : '<!doctype html><html><head><meta charset="UTF-8"><title>OxideVM image qualification</title></head><body><script type="module" src="/qualification/' + entry + '"></script></body></html>'); return; }
    if (module !== undefined && url.pathname.startsWith("/module-tampered/") && decodeURIComponent(url.pathname.slice("/module-tampered/".length)) === module.tamper) {
      const bytes = await readFile(join(module.directory, module.tamper));
      if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) { response.writeHead(404); response.end(); return; }
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      response.setHeader("Content-Type", "application/octet-stream");
      response.end(request.method === "HEAD" ? undefined : bytes); return;
    }
    const compliancePrefix = compliance === undefined ? undefined : `/oxidevm/runtime/compliance/${compliance.sha256}/`;
    const route = compliancePrefix !== undefined && compliance !== undefined && url.pathname.startsWith(compliancePrefix) ? { prefix: compliancePrefix, directory: compliance.directory }
      : imagePrefix !== undefined && bundleDir !== undefined && url.pathname.startsWith(imagePrefix) ? { prefix: imagePrefix, directory: bundleDir }
      : module !== undefined && url.pathname.startsWith("/module/") ? { prefix: "/module/", directory: module.directory }
      : module !== undefined && url.pathname.startsWith("/module-tampered/") ? { prefix: "/module-tampered/", directory: module.directory }
      : url.pathname.startsWith("/oxidevm/runtime/") ? { prefix: "/oxidevm/runtime/", directory: options.engineDir }
        : url.pathname.startsWith("/qualification/") ? { prefix: "/qualification/", directory: options.browserDir } : undefined;
    if (route === undefined) { response.writeHead(404); response.end(); return; }
    const relative = decodeURIComponent(url.pathname.slice(route.prefix.length));
    await serveStaticFile(request,response,route.directory,relative);
  }
  const server = createServer((request, response) => { void handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(404); response.end(); }); });
  await new Promise<void>((complete, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", complete); });
  const address = server.address();
  if (address === null || typeof address === "string") { server.closeAllConnections(); server.close(); throw new VMError("STORAGE_ERROR", "image-test server did not open a loopback port"); }
  const origin = `http://127.0.0.1:${String(address.port)}`;
  if (options.configure !== undefined) configuration = JSON.stringify(options.configure(origin));
  return { origin, close: () => new Promise<void>((complete, reject) => { server.closeAllConnections(); server.close(error => error === undefined ? complete() : reject(error)); }) };
}
