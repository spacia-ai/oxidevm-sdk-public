import { afterEach, expect, it, vi } from "vitest";
import { retainEngineCompliance } from "./engine-assets-compliance.js";
import { sha256Hex } from "./runtime/workers/snapshot-content.js";

afterEach(() => { vi.unstubAllGlobals(); });

it("browser startup retains and verifies all pinned engine legal materials before execution", async () => {
  const engine = "a".repeat(64), names = ["RUNTIME-LICENSE.txt", "THIRD_PARTY_NOTICES.txt", "sbom.cdx.json", "license-policy.json"];
  const encoder = new TextEncoder(), files = await Promise.all(names.map(async name => ({ name, bytes: name.length, sha256: await sha256Hex(encoder.encode(name)) })));
  const manifest = encoder.encode(JSON.stringify({ schemaVersion: 1, engineRelease: engine, files })), sha256 = await sha256Hex(manifest);
  const pin = { url: `https://cdn.oxidevm.dev/engine/${engine}/compliance/${sha256}/compliance.json`, bytes: manifest.length, sha256 };
  const fetcher = vi.fn((url: URL | RequestInfo) => { const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url; return Promise.resolve(new Response(href.endsWith("compliance.json") ? manifest : names.find(name => href.endsWith(name)) ?? "missing")); });
  vi.stubGlobal("fetch", fetcher);
  await expect(retainEngineCompliance("https://local.test/oxidevm/runtime/", pin, engine)).resolves.toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(5);
  fetcher.mockImplementation(() => Promise.resolve(new Response("tampered terms")));
  await expect(retainEngineCompliance("https://local.test/oxidevm/runtime/", pin, engine)).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
  await expect(retainEngineCompliance("https://local.test/oxidevm/runtime/", null, engine)).resolves.toBeUndefined();
});
