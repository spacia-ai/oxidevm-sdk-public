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
  expect(() => validateProjectLock({ ...lock, sdkVersion: "999.0.0" }, config)).toThrow(/--update-lock/u);
  expect(() => decodeProjectConfig({ mode: "auto" })).toThrow();
  expect(() => decodeProjectConfig({ mode: "system", memoryMiB: 1 })).toThrow();
  expect(() => decodeProjectConfig({ mode: "userspace", assetBaseUrl: "/assets/../escape/" })).toThrow();
});

function failure(work: () => unknown): unknown {
  try { work(); } catch (error: unknown) { return error; }
  throw new Error("expected a failure");
}

it("explains a lock from another SDK release: both releases, the differing fields and the command that updates it", () => {
  const config = decodeProjectConfig({ mode: "userspace" });
  const lock = createProjectLock(config), image = lock.image.manifestSHA256, engineRelease = `sha256:${"e".repeat(64)}`;
  const error = failure(() => validateProjectLock({ ...lock, sdkVersion: "0.0.8", cliVersion: "0.0.8", engineRelease }, config));
  expect(error).toMatchObject({
    code: "INVALID_ARGUMENT",
    message: `project lock oxidevm.lock.json does not match the installed SDK release and project configuration (differing fields: sdkVersion, cliVersion, engineRelease): locked SDK 0.0.8, engine ${engineRelease}, image sha256:${image}; installed SDK ${lock.sdkVersion}, engine ${lock.engineRelease}, image sha256:${image}; run \`npx oxidevm assets install --update-lock\` to stage this release's assets and rewrite the lock (pass --image and --trust again for an image the project configuration does not name)`,
    detail: { reason: "project-lock-stale", fields: ["sdkVersion", "cliVersion", "engineRelease"], locked: { sdkVersion: "0.0.8", engineRelease, manifestSHA256: image }, installed: { sdkVersion: lock.sdkVersion, engineRelease: lock.engineRelease, manifestSHA256: image } },
  });
  // Every differing field is named, nested ones by their path.
  const moved = { ...lock, engine: { ...lock.engine, schemaVersion: 2 }, image: { ...lock.image, manifestUrl: "/oxidevm/images/other/manifest.json" }, staging: { ...lock.staging, publicDir: "static" } };
  expect(failure(() => validateProjectLock(moved, config))).toMatchObject({ detail: { fields: ["engine", "image.manifestUrl", "staging.publicDir"] } });
});

it("never echoes a lock it cannot read: malformed identities are protocol errors", () => {
  const config = decodeProjectConfig({ mode: "userspace" });
  const lock = createProjectLock(config);
  for (const broken of [{ ...lock, sdkVersion: "0.0.8\u001b[31m" }, { ...lock, sdkVersion: 8 }, { ...lock, engineRelease: "sha256:short" }, { ...lock, image: { ...lock.image, manifestSHA256: "A".repeat(64) } }, { ...lock, staging: { ...lock.staging, extra: true } }]) {
    const error = failure(() => validateProjectLock(broken, config));
    expect(error).toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(error instanceof Error ? error.message : "").not.toContain("\u001b");
  }
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
