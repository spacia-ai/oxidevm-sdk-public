import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startImageTestServer } from "./image-test-server.js";

it.each(["/oxvm/runtime/", "/oxidevm/runtime/"])("serves image, engine and compliance paths under %s with isolation, excluding escaping symlinks", async runtimePrefix => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-image-server-test-"));
  await mkdir(join(root, "image")); await mkdir(join(root, "engine")); await mkdir(join(root, "browser")); await mkdir(join(root, "compliance"));
  await writeFile(join(root, "image/manifest.json"), "{}"); await writeFile(join(root, "engine/core.wasm"), Uint8Array.of(0, 97, 115, 109));
  await writeFile(join(root, "browser/client.js"), "export {};"); await writeFile(join(root, "private.txt"), "private");
  await symlink(join(root, "private.txt"), join(root, "image/escape"));
  const complianceSHA256 = "a".repeat(64);
  await writeFile(join(root, "compliance/compliance.json"), '{"components":[]}');
  const server = await startImageTestServer({ bundleDir: join(root, "image"), manifestPath: "/images/example/digest/manifest.json", engineDir: join(root, "engine"), engineCompliance: { directory: join(root, "compliance"), sha256: complianceSHA256 }, browserDir: join(root, "browser"), configuration: { public: true } });
  try {
    const manifest = await fetch(`${server.origin}/images/example/digest/manifest.json`);
    expect(manifest.status).toBe(200); expect(manifest.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(manifest.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(await manifest.json()).toEqual({});
    const engine = await fetch(`${server.origin}${runtimePrefix}core.wasm`);
    expect(engine.status).toBe(200); expect(engine.headers.get("content-type")).toBe("application/wasm");
    expect(new Uint8Array(await engine.arrayBuffer())).toEqual(Uint8Array.of(0, 97, 115, 109));
    const compliance = await fetch(`${server.origin}${runtimePrefix}compliance/${complianceSHA256}/compliance.json`);
    expect(compliance.status).toBe(200); expect(await compliance.json()).toEqual({ components: [] });
    expect((await fetch(`${server.origin}/qualification/client.js`)).headers.get("content-type")).toBe("text/javascript");
    expect(await (await fetch(`${server.origin}/fixture.json`)).json()).toEqual({ public: true });
    for (const path of ["/images/example/digest/escape", "/images/example/digest/%2e%2e/private.txt", "/private.txt", "/fixture.json?unexpected=true", `${runtimePrefix}compliance/${"b".repeat(64)}/compliance.json`]) expect((await fetch(`${server.origin}${path}`)).status).toBe(404);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

it("serves a module release, a copy with one altered adapter byte, the wasm page entry and an origin-bound fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-module-server-test-"));
  await mkdir(join(root, "module")); await mkdir(join(root, "engine")); await mkdir(join(root, "browser"));
  const adapter = new TextEncoder().encode("export default () => ({ main: () => 0 });");
  await writeFile(join(root, "module/adapter.mjs"), adapter); await writeFile(join(root, "module/tiny.wasm"), Uint8Array.of(0, 97, 115, 109));
  const server = await startImageTestServer({ engineDir: join(root, "engine"), browserDir: join(root, "browser"), entry: "wasm-client.js", module: { directory: join(root, "module"), tamper: "adapter.mjs" }, configure: origin => ({ adapter: `${origin}/module/adapter.mjs` }) });
  try {
    const genuine = new Uint8Array(await (await fetch(`${server.origin}/module/adapter.mjs`)).arrayBuffer());
    expect(genuine).toEqual(adapter);
    const tampered = new Uint8Array(await (await fetch(`${server.origin}/module-tampered/adapter.mjs`)).arrayBuffer());
    expect(tampered.length).toBe(adapter.length);
    expect(tampered.findIndex((byte, index) => byte !== adapter[index])).toBe(0);
    expect(tampered.slice(1)).toEqual(adapter.slice(1));
    expect(new Uint8Array(await (await fetch(`${server.origin}/module-tampered/tiny.wasm`)).arrayBuffer())).toEqual(Uint8Array.of(0, 97, 115, 109));
    expect(await (await fetch(`${server.origin}/`)).text()).toContain('src="/qualification/wasm-client.js"');
    expect(await (await fetch(`${server.origin}/fixture.json`)).json()).toEqual({ adapter: `${server.origin}/module/adapter.mjs` });
    for (const path of ["/images/anything/manifest.json", "/module/%2e%2e/engine", "/module-tampered/missing.bin"]) expect((await fetch(`${server.origin}${path}`)).status, path).toBe(404);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

it.each(["/oxvm/runtime/", "/oxidevm/runtime/"])("serves the module frame under %s with its own headers, excluding unlisted files", async runtimePrefix => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-module-frame-server-test-"));
  await mkdir(join(root, "engine")); await mkdir(join(root, "browser")); await mkdir(join(root, "frame"));
  const headers = { "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "cross-origin", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  await writeFile(join(root, "frame/frame.json"), JSON.stringify({ schemaVersion: 1, headers }));
  await writeFile(join(root, "frame/index.html"), "<!doctype html><title>frame</title>"); await writeFile(join(root, "frame/broker.js"), "/* broker */"); await writeFile(join(root, "frame/runner.js"), "/* runner */");
  await writeFile(join(root, "frame/extra.js"), "/* not part of the frame */");
  const server = await startImageTestServer({ engineDir: join(root, "engine"), browserDir: join(root, "browser"), entry: "wasm-client.js", moduleFrameDir: join(root, "frame") });
  try {
    for (const [path, body, type] of [["broker.js", "/* broker */", "text/javascript"], ["runner.js", "/* runner */", "text/javascript"], ["", "<!doctype html><title>frame</title>", "text/html"], ["index.html", "<!doctype html><title>frame</title>", "text/html"]] as const) {
      const response = await fetch(`${server.origin}${runtimePrefix}module-frame/${path}`);
      expect(response.status, path).toBe(200);
      expect(await response.text()).toBe(body);
      expect(response.headers.get("content-type")).toBe(type);
      for (const [name, value] of Object.entries(headers)) expect(response.headers.get(name), name).toBe(value);
      // The frame's own headers replace the page's: no opener policy, and CORP cross-origin for the opaque frame.
      expect(response.headers.get("cross-origin-opener-policy")).toBeNull();
    }
    for (const path of ["frame.json", "extra.js", "%2e%2e/frame.json", "nested/broker.js"]) expect((await fetch(`${server.origin}${runtimePrefix}module-frame/${path}`)).status, path).toBe(404);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

it("refuses a module frame directory whose frame.json names no headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-module-frame-server-test-"));
  await writeFile(join(root, "frame.json"), JSON.stringify({ schemaVersion: 1 }));
  try {
    await expect(startImageTestServer({ engineDir: root, browserDir: root, moduleFrameDir: root })).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
