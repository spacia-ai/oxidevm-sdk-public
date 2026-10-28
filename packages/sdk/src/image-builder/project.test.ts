import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createProjectLock, decodeProjectConfig, loadProjectConfig, validateProjectLock } from "./project.js";
import { legacyImageLocations as defaultImageLocations } from "../default-images.test-support.js";

vi.mock("../defaults.generated.js", async () => ({ defaultImageLocations: (await import("../default-images.test-support.js")).legacyImageLocations }));

it("pins the SDK-owned release and rejects changed project identities", () => {
  const config = decodeProjectConfig({ mode: "userspace" });
  const lock = createProjectLock(config);
  expect(lock.schemaVersion).toBe(2); expect(lock.mode).toBe("userspace");
  expect(lock.image.manifestSHA256).toMatch(/^[0-9a-f]{64}$/u);
  expect(() => validateProjectLock(JSON.parse(JSON.stringify(lock)) as unknown, config)).not.toThrow();
  expect(() => validateProjectLock({ ...lock, sdkVersion: "999.0.0" }, config)).toThrow(/explicit/u);
  expect(() => decodeProjectConfig({ mode: "auto" })).toThrow();
  expect(() => decodeProjectConfig({ mode: "system", memoryMiB: 1 })).toThrow();
  expect(() => decodeProjectConfig({ mode: "userspace", assetBaseUrl: "/assets/../escape/" })).toThrow();
});

it("loads only an explicitly selected author configuration and resolves its directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-project-config-"));
  try {
    await writeFile(join(root, "oxidevm.config.mjs"), 'export default { mode: "system", publicDir: "static", assetBaseUrl: "/custom/" };');
    const loaded = await loadProjectConfig(join(root, "oxidevm.config.mjs"));
    expect(loaded.directory).toBe(root); expect(loaded.config).toEqual({ mode: "system", publicDir: "static", assetBaseUrl: "/custom/" });
    expect(await readFile(join(root, "oxidevm.config.mjs"), "utf8")).toContain("export default");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("pins a supplied image and rejects mismatched modes or changed image identities", () => {
  const image = { ...defaultImageLocations.userspace, manifestUrl: "/custom/minimal/manifest.json", manifestSHA256: "a".repeat(64) };
  const config = decodeProjectConfig({ mode: "userspace", assetBaseUrl: "/custom/", image });
  const lock = createProjectLock(config);
  expect(lock.image).toMatchObject(image);
  expect(() => validateProjectLock(lock, config)).not.toThrow();
  expect(() => validateProjectLock({ ...lock, image: { ...lock.image, manifestSHA256: "b".repeat(64) } }, config)).toThrow();
  expect(() => decodeProjectConfig({ mode: "system", image })).toThrow();
  expect(() => decodeProjectConfig({ mode: "userspace", image: { ...image, extra: true } })).toThrow();
});
