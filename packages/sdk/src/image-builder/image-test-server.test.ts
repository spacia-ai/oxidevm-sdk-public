import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startImageTestServer } from "./image-test-server.js";

it("serves exact image paths and browser MIME with isolation, excluding escaping symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-image-server-test-"));
  await mkdir(join(root, "image")); await mkdir(join(root, "engine")); await mkdir(join(root, "browser"));
  await writeFile(join(root, "image/manifest.json"), "{}"); await writeFile(join(root, "engine/core.wasm"), Uint8Array.of(0, 97, 115, 109));
  await writeFile(join(root, "browser/client.js"), "export {};"); await writeFile(join(root, "private.txt"), "private");
  await symlink(join(root, "private.txt"), join(root, "image/escape"));
  const server = await startImageTestServer({ bundleDir: join(root, "image"), manifestPath: "/images/example/digest/manifest.json", engineDir: join(root, "engine"), browserDir: join(root, "browser"), configuration: { public: true } });
  try {
    const manifest = await fetch(`${server.origin}/images/example/digest/manifest.json`);
    expect(manifest.status).toBe(200); expect(manifest.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(manifest.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(await manifest.json()).toEqual({});
    expect((await fetch(`${server.origin}/oxidevm/runtime/core.wasm`)).headers.get("content-type")).toBe("application/wasm");
    expect((await fetch(`${server.origin}/qualification/client.js`)).headers.get("content-type")).toBe("text/javascript");
    expect(await (await fetch(`${server.origin}/fixture.json`)).json()).toEqual({ public: true });
    for (const path of ["/images/example/digest/escape", "/images/example/digest/%2e%2e/private.txt", "/private.txt", "/fixture.json?unexpected=true"]) expect((await fetch(`${server.origin}${path}`)).status).toBe(404);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
