import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import type { Connect, Plugin } from "vite";
import { isPreviewHost } from "./preview-host.ts";

export async function developmentAsset(root: string, request: string, prefix: "/oxvm/" | "/.oxvm/modules/" = "/oxvm/"): Promise<string | undefined> {
  let path: string;
  try { path = decodeURIComponent(request.split("?")[0] ?? ""); } catch { return undefined; }
  if (!path.startsWith(prefix) || path.includes("\\") || path.split("/").slice(1).some(part => ["", ".", ".."].includes(part)) || Array.from(path).some(char => char.charCodeAt(0) < 32)) return undefined;
  const target = resolve(root, `.${path}`), base = resolve(root);
  if (!target.startsWith(`${base}${sep}`)) return undefined;
  let current = base;
  for (const item of [dirname(base), base, ...target.slice(base.length + 1).split(sep).map(part => { current = join(current, part); return current; })]) {
    const metadata = await lstat(item).catch(() => undefined);
    if (metadata === undefined || metadata.isSymbolicLink()) return undefined;
  }
  const metadata = await lstat(target);
  // The image builder admits rootfs files up to 1 GiB (MAX_ROOTFS_FILE_BYTES), so their loose blobs are served too.
  return metadata.isFile() && metadata.size <= 1024 ** 3 ? target : undefined;
}

/** Development binaries stay outside public/, so Vite cannot copy them into production output. */
export function runtimeAssets(): Plugin {
  let projectRoot = "", publicDir = "";
  return { name: "oxidevm-development-assets", configResolved(config) { projectRoot = config.root; publicDir = config.publicDir; }, configureServer(server) {
    const root = join(server.config.root, ".oxvm/assets");
    const middleware: Connect.NextHandleFunction = (request, response, next) => {
      const url = request.url ?? "";
      const moduleFile = url.startsWith("/.oxvm/modules/") && !new URLSearchParams(url.split("?")[1]).has("import");
      if (isPreviewHost(request.headers.host ?? "") || !url.startsWith("/oxvm/") && !moduleFile) { next(); return; }
      void (async () => {
        if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
        // Vite treats extensionless notices as JavaScript; module fetches must retain their authenticated bytes.
        const file = moduleFile ? await developmentAsset(server.config.root, url, "/.oxvm/modules/") : await developmentAsset(root, url);
        if (file === undefined) { response.writeHead(404).end(); return; }
        response.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : file.endsWith(".json") ? "application/json" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".html") ? "text/html" : "application/octet-stream");
        response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.end(request.method === "HEAD" ? undefined : await readFile(file));
      })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
    };
    server.middlewares.use(middleware);
  }, async generateBundle(_options, bundle) {
    for (const directory of ["oxvm", "oxidevm"]) {
      if (publicDir !== "" && await lstat(join(publicDir, directory)).catch(() => undefined) !== undefined) throw new Error(`Move development assets from public/${directory} to .oxvm/assets before building for production`);
    }
    for (const name of Object.keys(bundle)) if (/oxidevm_(?:core|core_shared|userspace|netstack)(?:[.-]|$)/u.test(name)) throw new Error("The starter production build must not redistribute engine binaries");
    const sdk = resolve(dirname(createRequire(import.meta.url).resolve("@oxvm/sdk")), "..");
    for (const [source, name] of [[join(projectRoot, "LICENSE"), "LICENSE.txt"], [join(projectRoot, "NOTICE"), "NOTICE.txt"], [join(projectRoot, "LICENSES.md"), "GUIDE.md"], [join(sdk, "LICENSE"), "SDK-LICENSE.txt"], [join(sdk, "NOTICE"), "SDK-NOTICE.txt"], [join(sdk, "THIRD_PARTY_NOTICES.txt"), "THIRD_PARTY_NOTICES.txt"]]) {
      if (source === undefined || name === undefined) throw new Error("Invalid production notice mapping");
      this.emitFile({ type: "asset", fileName: `licenses/${name}`, source: await readFile(source, "utf8") });
    }
  } };
}
