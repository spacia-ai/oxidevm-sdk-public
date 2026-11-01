import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "vite";
import { servedName } from "./release.js";
import { buildReleaseFiles, sha } from "./release.test-support.js";
import { DEFAULT_GENERATED_FILE, stageModules } from "./stage.js";
import { releaseInput } from "./stage.test-support.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const directory = await mkdtemp(join(tmpdir(), "oxidevm-dev-server-")); directories.push(directory); return directory; }

describe("staged files under a development server", () => {
  it("are sent with exactly the bytes the lock pins, because the handles name the served copies", async () => {
    const project = await temporary();
    const release = buildReleaseFiles({ id: "tool", artifacts: {
      "worker.js": new TextEncoder().encode("export const worker = 1;\n"), "style.css": new TextEncoder().encode("body { color: red; }\n"),
      "tool.wasm": Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0), "lock.json": new TextEncoder().encode("{\"a\": 1}\n"),
    } });
    const staged = await releaseInput(release, await temporary());
    await stageModules(new Map([["tool", staged]]), { projectDir: project });
    const generatedFile = resolve(project, DEFAULT_GENERATED_FILE);
    const generated = await readFile(generatedFile, "utf8");
    const urls = new Map([...generated.matchAll(/new URL\("([^"]+)", import\.meta\.url\)/gu)].map(match => {
      const path = match[1] ?? "";
      return [posix.basename(path), `/${relative(project, resolve(dirname(generatedFile), path)).split("\\").join("/")}`] as const;
    }));
    expect([...urls.keys()].sort()).toEqual(["adapter.mjs.bin", "lock.json", "style.css.bin", "tool.wasm", "worker.js.bin"]);

    const server = await createServer({ root: project, configFile: false, logLevel: "silent", appType: "custom", server: { host: "127.0.0.1", watch: null, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
    try {
      await server.listen();
      const address = server.httpServer?.address();
      const origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? String(address.port) : "0"}`;
      for (const file of staged.release.files) {
        const url = urls.get(servedName(file.name));
        expect(url, file.name).toBeDefined();
        const response = await fetch(`${origin}${url ?? ""}`, { headers: { connection: "close" } });
        expect(response.status, file.name).toBe(200);
        expect(sha(new Uint8Array(await response.arrayBuffer())), `${file.name} as served`).toBe(file.sha256);
      }
    } finally {
      await server.close();
    }
  });
});
