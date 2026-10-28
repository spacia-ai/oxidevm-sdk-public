import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { decodeEngineCompliancePin, resolveEngineCompliance, verifyEngineCompliance } from "./engine-compliance.js";
import { hash } from "./files.js";

it("binds engine terms, notices, SBOM and policy to one engine without trusting a local file name", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-engine-compliance-"));
  try {
    const engine = "a".repeat(64);
    const files = ["RUNTIME-LICENSE.txt", "THIRD_PARTY_NOTICES.txt", "sbom.cdx.json", "license-policy.json"].map(name => ({ name, bytes: name.length, sha256: hash(name) }));
    const bytes = JSON.stringify({ schemaVersion: 1, engineRelease: engine, files });
    const pin = decodeEngineCompliancePin({ url: `https://cdn.oxidevm.dev/engine/${engine}/compliance/${hash(bytes)}/compliance.json`, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) }, engine);
    await writeFile(join(root, "compliance.json"), bytes); for (const file of files) await writeFile(join(root, file.name), file.name);
    await expect(verifyEngineCompliance(root, pin, engine)).resolves.toHaveProperty("engineRelease", engine);
    await expect(verifyEngineCompliance(root, pin, "b".repeat(64))).rejects.toThrow(/engine/u);
    await writeFile(join(root, "RUNTIME-LICENSE.txt"), "different terms");
    await expect(verifyEngineCompliance(root, pin, engine)).rejects.toThrow(/integrity|identity/u);
    expect(() => decodeEngineCompliancePin({ ...pin, url: pin.url.replace(engine, "c".repeat(64)) }, engine)).toThrow();
    const outside = join(root, "outside.json"); await writeFile(outside, bytes); await rm(join(root, "compliance.json")); await symlink(outside, join(root, "compliance.json"));
    await expect(verifyEngineCompliance(root, pin, engine)).rejects.toThrow(/symlink|regular/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("downloads and reuses only a fully verified immutable compliance cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-compliance-cache-"));
  try {
    const engine = "a".repeat(64), names = ["RUNTIME-LICENSE.txt", "THIRD_PARTY_NOTICES.txt", "sbom.cdx.json", "license-policy.json"];
    const manifest = JSON.stringify({ schemaVersion: 1, engineRelease: engine, files: names.map(name => ({ name, bytes: name.length, sha256: hash(name) })) });
    const pin = decodeEngineCompliancePin({ url: `https://cdn.oxidevm.dev/engine/${engine}/compliance/${hash(manifest)}/compliance.json`, bytes: Buffer.byteLength(manifest), sha256: hash(manifest) }, engine);
    const fetcher = vi.fn((url: string | URL) => Promise.resolve(new Response(String(url).endsWith("compliance.json") ? manifest : names.find(name => String(url).endsWith(name)) ?? "missing")));
    vi.stubGlobal("fetch", fetcher);
    const options = { cacheDir: root };
    const directory = await resolveEngineCompliance(pin, engine, options); expect(fetcher).toHaveBeenCalledTimes(5);
    expect(await resolveEngineCompliance(pin, engine, options)).toBe(directory); expect(fetcher).toHaveBeenCalledTimes(5);
  } finally { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); }
});
