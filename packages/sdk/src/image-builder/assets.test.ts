import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { buildImage } from "./build.js";
import { generateImageKey } from "./keys.js";
import { cacheImageBundle, installProjectAssets } from "./assets.js";
import { createProjectLock } from "./project.js";
import { record } from "../runtime/decode.js";
import { hash } from "./files.js";
import { syntheticEngineRelease, writeSyntheticRelease } from "./engine-release.test-support.js";

// The SDK pins an engine release it does not contain; these tests pin a synthetic one.
vi.mock("../engine.generated.js", async () => {
  const support = await import("./engine-release.test-support.js");
  return support.syntheticGeneratedPin(support.syntheticEngineRelease());
});
const engine = syntheticEngineRelease();

it("stages verified custom artifacts and updates their reference without mutating signed bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-assets-test-"));
  try {
    await mkdir(join(root, "root")); await writeFile(join(root, "root/input"), "actual bytes");
    await writeSyntheticRelease(join(root, "engine"), engine);
    // A downloaded engine cache entry is private (0600); the staged runtime must still be readable.
    for (const name of await readdir(join(root, "engine"))) await chmod(join(root, "engine", name), 0o600);
    const key = await generateImageKey(join(root, "author.pem"));
    const built = await buildImage({ mode: "userspace", id: "custom", version: "1", source: { kind: "directory", path: "root" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 } }, { recipeDir: root, signingKeyFile: key.privateKeyPath });
    const config = { mode: "userspace" as const, image: { ...built.image, manifestUrl: `/oxidevm/images/${built.image.manifestSHA256}/manifest.json` } }; const lock = createProjectLock(config);
    await writeFile(join(root, "oxidevm.lock.json"), JSON.stringify(lock));
    const before = await readFile(built.manifestPath);
    const result = await installProjectAssets(root, config, { imageDir: built.bundleDir, referencePath: "src/generated/custom.image.ts", trust: key.trust, engineDir: "engine" });
    expect(result.files).toBeGreaterThan(4); expect(result.referencePath).toBe(join(root, "src/generated/custom.image.ts"));
    expect(await readFile(built.manifestPath)).toEqual(before);
    expect(await readFile(result.referencePath ?? "", "utf8")).toContain(built.image.manifestSHA256);
    const runtime = join(root, "public/oxidevm/runtime");
    expect((await readdir(runtime)).sort()).toEqual(["LICENSE", "release.json", ...engine.modules.keys()].sort());
    for (const name of await readdir(runtime)) expect([name, (await stat(join(runtime, name))).mode & 0o777]).toEqual([name, 0o644]);
    expect(hash(await readFile(join(runtime, "release.json")))).toBe(engine.id);
    expect(await readFile(join(runtime, "LICENSE"), "utf8")).toBe(engine.license);
    await writeFile(join(root, "oxidevm.lock.json"), JSON.stringify({ ...lock, sdkVersion: "999" }));
    await expect(installProjectAssets(root, config, { imageDir: built.bundleDir, trust: key.trust, engineDir: "engine" })).rejects.toThrow(/explicit/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("creates the project lock for an existing application that has only a config", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-assets-new-lock-"));
  try {
    await mkdir(join(root, "root")); await writeFile(join(root, "root/input"), "actual bytes");
    await writeSyntheticRelease(join(root, "engine"), engine);
    const key = await generateImageKey(join(root, "author.pem"));
    const built = await buildImage({ mode: "userspace", id: "custom", version: "1", source: { kind: "directory", path: "root" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 } }, { recipeDir: root, signingKeyFile: key.privateKeyPath });
    const config = { mode: "userspace" as const };
    const result = await installProjectAssets(root, config, { imageDir: built.bundleDir, trust: key.trust, engineDir: "engine" });
    expect(result.files).toBeGreaterThan(4);
    expect(JSON.parse(await readFile(join(root, "oxidevm.lock.json"), "utf8"))).toMatchObject({ image: { manifestSHA256: built.image.manifestSHA256 } });
    // An existing lock is validated, never replaced.
    const installedLock = record(JSON.parse(await readFile(join(root, "oxidevm.lock.json"), "utf8")) as unknown, "project lock");
    await writeFile(join(root, "oxidevm.lock.json"), JSON.stringify({ ...installedLock, sdkVersion: "999" }));
    await expect(installProjectAssets(root, config, { imageDir: built.bundleDir, trust: key.trust, engineDir: "engine" })).rejects.toThrow(/explicit/u);
    expect(JSON.parse(await readFile(join(root, "oxidevm.lock.json"), "utf8"))).toMatchObject({ sdkVersion: "999" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("refuses an engine directory that is not the pinned release before staging anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-assets-engine-"));
  try {
    await mkdir(join(root, "root")); await writeFile(join(root, "root/input"), "actual bytes");
    await writeSyntheticRelease(join(root, "engine"), syntheticEngineRelease(1));
    const key = await generateImageKey(join(root, "author.pem"));
    const built = await buildImage({ mode: "userspace", id: "custom", version: "1", source: { kind: "directory", path: "root" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 } }, { recipeDir: root, signingKeyFile: key.privateKeyPath });
    const config = { mode: "userspace" as const, image: { ...built.image, manifestUrl: `/oxidevm/images/${built.image.manifestSHA256}/manifest.json` } };
    await writeFile(join(root, "oxidevm.lock.json"), JSON.stringify(createProjectLock(config)));
    await expect(installProjectAssets(root, config, { imageDir: built.bundleDir, trust: key.trust, engineDir: "engine" })).rejects.toMatchObject({ code: "CORE_LOAD_FAILED" });
    await expect(readdir(join(root, "public"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("caches an authenticated rootfs manifest larger than the generic metadata bound without changing its bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-large-manifest-cache-"));
  try {
    await mkdir(join(root, "root")); await writeFile(join(root, "root/input"), "actual bytes");
    const key = await generateImageKey(join(root, "author.pem"));
    const built = await buildImage({ mode: "userspace", id: "custom", version: "1", source: { kind: "directory", path: "root" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 } }, { recipeDir: root, signingKeyFile: key.privateKeyPath });
    // JSON whitespace preserves the authenticated manifest's semantics and signature.
    // Its raw digest still has to be pinned by the author lock and preserved in the cache.
    const manifest = `${await readFile(built.manifestPath, "utf8")}${" ".repeat(16 * 1024 ** 2)}`;
    const digest = hash(manifest);
    const lock = record(JSON.parse(await readFile(built.lockPath, "utf8")) as unknown, "image lock");
    await writeFile(built.manifestPath, manifest);
    await writeFile(built.lockPath, JSON.stringify({ ...lock, manifestSHA256: digest }));
    const cache = await cacheImageBundle(built.bundleDir, key.trust, join(root, "cache"));
    expect(cache).toBe(join(root, "cache", digest));
    expect(await readFile(join(cache, "manifest.json"), "utf8")).toBe(manifest);
    expect(await readdir(cache)).not.toContain("custom.image.ts");
    await writeFile(built.manifestPath, `${manifest}\n`);
    await expect(cacheImageBundle(built.bundleDir, key.trust, join(root, "cache"))).rejects.toThrow(/manifest digest mismatch/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("stages an explicit image for the hosted runtime without resolving or copying an engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-hosted-image-"));
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Hosted image installation must not download an engine"));
  try {
    await mkdir(join(root, "root")); await writeFile(join(root, "root/input"), "hosted image fixture");
    const key = await generateImageKey(join(root, "author.pem"));
    const built = await buildImage({ mode: "userspace", id: "custom", version: "1", source: { kind: "directory", path: "root" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 } }, { recipeDir: root, signingKeyFile: key.privateKeyPath });
    const config = { mode: "userspace" as const, image: { ...built.image, manifestUrl: `/oxidevm/images/${built.image.manifestSHA256}/manifest.json` } };
    await writeFile(join(root, "oxidevm.lock.json"), JSON.stringify(createProjectLock(config)));
    const result = await installProjectAssets(root, config, { hosting: "frame", imageDir: built.bundleDir, trust: key.trust });
    const invalid: unknown = Reflect.apply(installProjectAssets, undefined, [root, config, { hosting: "unexpected" }]);
    await expect(invalid).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(result.files).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
    await expect(readdir(join(root, "public/oxidevm/runtime"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(installProjectAssets(root, config, { hosting: "frame", engineDir: "engine", imageDir: built.bundleDir, trust: key.trust })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  } finally { fetch.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
