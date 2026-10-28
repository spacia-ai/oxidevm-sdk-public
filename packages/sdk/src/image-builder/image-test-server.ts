import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";
import { VMError } from "../runtime/errors.js";
import {isolatedHeaders,serveStaticFile} from "./static-files.js";

interface ImageTestServingOptions {
  readonly bundleDir: string;
  readonly manifestPath: string;
  readonly engineDir: string;
  readonly engineCompliance?: { readonly directory: string; readonly sha256: string };
  readonly browserDir: string;
  readonly configuration: unknown;
}
export interface ImageTestServer { readonly origin: string; close(): Promise<void> }

export async function startImageTestServer(options: ImageTestServingOptions): Promise<ImageTestServer> {
  if (!options.manifestPath.startsWith("/") || !options.manifestPath.endsWith("/manifest.json")) throw new VMError("PROTOCOL_ERROR", "image manifest requires a static directory serving path");
  const imagePrefix = `${dirname(options.manifestPath)}/`;
  const configuration = JSON.stringify(options.configuration);
  const compliance = options.engineCompliance;
  if (compliance !== undefined && !/^[a-f0-9]{64}$/u.test(compliance.sha256)) throw new VMError("PROTOCOL_ERROR", "invalid engine compliance serving revision");
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    isolatedHeaders(response);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if ((request.method !== "GET" && request.method !== "HEAD") || url.search !== "") { response.writeHead(404); response.end(); return; }
    if (url.pathname === "/fixture.json") { response.setHeader("Content-Type", "application/json"); response.end(request.method === "HEAD" ? undefined : configuration); return; }
    if (url.pathname === "/") { response.setHeader("Content-Type", "text/html"); response.end(request.method === "HEAD" ? undefined : '<!doctype html><html><head><meta charset="UTF-8"><title>OxideVM image qualification</title></head><body><script type="module" src="/qualification/client.js"></script></body></html>'); return; }
    const compliancePrefix = compliance === undefined ? undefined : `/oxidevm/runtime/compliance/${compliance.sha256}/`;
    const route = compliancePrefix !== undefined && compliance !== undefined && url.pathname.startsWith(compliancePrefix) ? { prefix: compliancePrefix, directory: compliance.directory }
      : url.pathname.startsWith(imagePrefix) ? { prefix: imagePrefix, directory: options.bundleDir }
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
  return { origin: `http://127.0.0.1:${String(address.port)}`, close: () => new Promise<void>((complete, reject) => { server.closeAllConnections(); server.close(error => error === undefined ? complete() : reject(error)); }) };
}
