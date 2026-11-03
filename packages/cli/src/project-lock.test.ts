import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type * as ImageBuilder from "@oxidevm/sdk/image-builder";
import { buildImage, createProjectLock, decodeImageDigest, generateImageKey, getSDKRelease } from "@oxidevm/sdk/image-builder";
import { lockChangeText, versionRefusal } from "./project-lock.js";
import { decodeCliReport } from "./report.js";
import { runCLI } from "./run.js";
import { object, text } from "./validation.js";

// `assets install` stages a self-hosted engine, which needs the real pinned engine release. These tests
// stage for the hosted runtime frame instead; image verification, staging and the lock work as in the CLI.
vi.mock("@oxidevm/sdk/image-builder", async importOriginal => {
  const builder = await importOriginal<typeof ImageBuilder>();
  return { ...builder, installProjectAssets: (directory: string, config: ImageBuilder.ProjectConfig, options: ImageBuilder.InstallAssetsOptions = {}) => builder.installProjectAssets(directory, config, { ...options, hosting: "frame" }) };
});

const cliVersion = text(object(JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as unknown, "CLI manifest")["version"]);
const sdk = getSDKRelease();

/** An application whose lock an earlier SDK release wrote, with a custom image its configuration names. */
async function application(root: string, installedSDK: string | null = sdk.sdkVersion) {
  await mkdir(join(root, "rootfs")); await writeFile(join(root, "rootfs/input"), "lock fixture");
  const key = await generateImageKey(join(root, "author.pem"));
  const built = await buildImage({ mode: "userspace", id: "custom", version: "1", source: { kind: "directory", path: "rootfs" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 } }, { recipeDir: root, signingKeyFile: key.privateKeyPath });
  const app = join(root, "app"), image = built.image.manifestSHA256;
  const config = { mode: "userspace" as const, image: { ...built.image, manifestUrl: `/oxidevm/images/${image}/manifest.json` } };
  await mkdir(app);
  await writeFile(join(app, "oxidevm.config.json"), JSON.stringify(config));
  if (installedSDK !== null) {
    await mkdir(join(app, "node_modules/@oxidevm/sdk"), { recursive: true });
    await writeFile(join(app, "node_modules/@oxidevm/sdk/package.json"), JSON.stringify({ name: "@oxidevm/sdk", version: installedSDK, type: "module" }));
  }
  const current = createProjectLock(config), engineRelease = `sha256:${"e".repeat(64)}`;
  await writeFile(join(app, "oxidevm.lock.json"), `${JSON.stringify({ ...current, sdkVersion: "0.0.8", cliVersion: "0.0.8", engineRelease }, null, 2)}\n`);
  return { app, bundle: built.bundleDir, image, current, engineRelease, staged: join(app, "public/oxidevm/images", image, "manifest.json") };
}

async function run(directory: string, args: readonly string[]) {
  const stdout: string[] = [], stderr: string[] = [];
  const code = await runCLI(args, { directory, environment: {}, signal: new AbortController().signal, stdout: text => { stdout.push(text); }, stderr: text => { stderr.push(text); } });
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), report: args.includes("--json") ? decodeCliReport(JSON.parse(stdout.join("")) as unknown) : undefined };
}

async function scratch(work: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-cli-lock-"));
  try { await work(root); } finally { await rm(root, { recursive: true, force: true }); }
}

it("explains a lock from another SDK release, then rewrites it only after staging and prints old → new", async () => {
  await scratch(async root => {
    const { app, bundle, image, current, engineRelease, staged } = await application(root);
    const install = ["assets", "install", "--config", "app/oxidevm.config.json", "--image", bundle];
    const refused = await run(root, install);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe(`INVALID_ARGUMENT: project lock oxidevm.lock.json does not match the installed SDK release and project configuration (differing fields: sdkVersion, cliVersion, engineRelease): locked SDK 0.0.8, engine ${engineRelease}, image sha256:${image}; installed SDK ${sdk.sdkVersion}, engine ${sdk.engineRelease}, image sha256:${image}; run \`npx oxidevm assets install --update-lock\` to stage this release's assets and rewrite the lock (pass --image and --trust again for an image the project configuration does not name)\n`);
    await expect(readdir(join(app, "public"))).rejects.toMatchObject({ code: "ENOENT" });

    const updated = await run(root, [...install, "--update-lock", "--json"]);
    expect(updated.code, updated.stdout).toBe(0);
    expect(updated.report).toMatchObject({ schemaVersion: 3, kind: "result", command: "assets install", result: { lock: {
      updated: true, from: { sdkVersion: "0.0.8", engineRelease, manifestSHA256: image }, to: { sdkVersion: sdk.sdkVersion, engineRelease: sdk.engineRelease, manifestSHA256: image },
    } } });
    expect(updated.stderr).toBe(`Updated oxidevm.lock.json for this SDK release:\n  SDK     0.0.8 → ${sdk.sdkVersion}\n  engine  ${engineRelease} → ${sdk.engineRelease}\n  image   sha256:${image} (unchanged)\n`);
    expect(await readFile(join(app, "oxidevm.lock.json"), "utf8")).toBe(`${JSON.stringify(current, null, 2)}\n`);
    expect((await readFile(staged)).length).toBeGreaterThan(0);

    // The lock now validates; asking again rewrites nothing and says so.
    expect((await run(root, [...install, "--json"])).report).toMatchObject({ result: { lock: { updated: false, to: { sdkVersion: sdk.sdkVersion } } } });
    const again = await run(root, [...install, "--update-lock"]);
    expect(again.code).toBe(0);
    expect(again.stderr).toBe(`oxidevm.lock.json already matches this SDK release (SDK ${sdk.sdkVersion}, engine ${sdk.engineRelease}, image sha256:${image}); nothing to rewrite\n`);
    expect(JSON.parse(again.stdout)).toMatchObject({ schemaVersion: 3, result: { lock: { updated: false } } });
  });
});

it("keeps the old lock when staging fails after copying the image", async () => {
  await scratch(async root => {
    const { app, bundle, staged } = await application(root);
    const before = await readFile(join(app, "oxidevm.lock.json"));
    await mkdir(join(app, "src")); await writeFile(join(app, "src/custom.image.ts"), "export const authored = true;\n");
    const failed = await run(root, ["assets", "install", "--config", "app/oxidevm.config.json", "--image", bundle, "--reference", "app/src/custom.image.ts", "--update-lock", "--json"]);
    expect(failed.code).toBe(1);
    expect(failed.report).toMatchObject({ kind: "error", command: "assets install", error: { code: "PERMISSION_DENIED" } });
    expect((await readFile(staged)).length).toBeGreaterThan(0);
    expect(await readFile(join(app, "oxidevm.lock.json"))).toEqual(before);
    expect(failed.stderr).toBe("");
  });
});

it("refuses --update-lock unless the project's SDK and this CLI are one release, before staging anything", async () => {
  await scratch(async root => {
    const { app, bundle } = await application(root, "0.0.1");
    const before = await readFile(join(app, "oxidevm.lock.json"));
    const install = ["assets", "install", "--config", "app/oxidevm.config.json", "--image", bundle, "--update-lock", "--json"];
    const mismatch = await run(root, install);
    expect(mismatch.code).toBe(2);
    expect(mismatch.report).toMatchObject({ kind: "error", error: { code: "INVALID_ARGUMENT", message: `--update-lock writes the lock for one release, but this project has @oxidevm/sdk 0.0.1 and @oxidevm/cli ${cliVersion}; install both at the same version, then run \`npx oxidevm assets install --update-lock\` again` } });
    await rm(join(app, "node_modules"), { recursive: true });
    const missing = await run(root, install);
    expect(missing.report).toMatchObject({ kind: "error", error: { code: "INVALID_ARGUMENT", message: `--update-lock writes the lock for one release, but this project has no @oxidevm/sdk installed beside @oxidevm/cli ${cliVersion}; install both at the same version, then run \`npx oxidevm assets install --update-lock\` again` } });
    expect(await readFile(join(app, "oxidevm.lock.json"))).toEqual(before);
    await expect(readdir(join(app, "public"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("names every version that differs when the CLI, the SDK it runs and the project's SDK are not one release", () => {
  expect(versionRefusal({ cli: "0.0.9", runtime: "0.0.9", project: "0.0.9" })).toBeUndefined();
  expect(versionRefusal({ cli: "0.0.9", runtime: "0.0.9", project: "0.0.10" })).toBe("--update-lock writes the lock for one release, but this project has @oxidevm/sdk 0.0.10 and @oxidevm/cli 0.0.9; install both at the same version, then run `npx oxidevm assets install --update-lock` again");
  expect(versionRefusal({ cli: "0.0.9", runtime: "0.0.9", project: null })).toBe("--update-lock writes the lock for one release, but this project has no @oxidevm/sdk installed beside @oxidevm/cli 0.0.9; install both at the same version, then run `npx oxidevm assets install --update-lock` again");
  expect(versionRefusal({ cli: "0.0.9", runtime: "0.0.8", project: "0.0.9" })).toBe("--update-lock writes the lock for one release, but this project has @oxidevm/sdk 0.0.9 and @oxidevm/cli 0.0.9, which runs @oxidevm/sdk 0.0.8; install both at the same version, then run `npx oxidevm assets install --update-lock` again");
});

it("prints the lock a first install writes, and nothing when a run neither writes nor is asked to", () => {
  const to = { sdkVersion: "0.0.9", engineRelease: `sha256:${"f".repeat(64)}`, manifestSHA256: decodeImageDigest("b".repeat(64), "image") };
  expect(lockChangeText({ updated: true, to }, false)).toBe(`Wrote oxidevm.lock.json for this SDK release:\n  SDK     0.0.9\n  engine  sha256:${"f".repeat(64)}\n  image   sha256:${"b".repeat(64)}\n`);
  expect(lockChangeText({ updated: false, to }, false)).toBe("");
});
