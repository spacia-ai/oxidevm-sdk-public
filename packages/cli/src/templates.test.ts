import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImage, generateImageKey, getSDKRelease } from "@oxidevm/sdk/image-builder";
import { expect, it, vi } from "vitest";
import { initializeApplication, initializeImage } from "./templates.js";
import { object, text } from "./validation.js";

async function scratch(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "oxidevm-cli-templates-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function settings(npmrc: string): readonly string[] {
  return npmrc.split("\n").map(line => line.trim()).filter(line => line !== "" && !line.startsWith("#") && !line.startsWith(";"));
}

async function imageInputs(root: string) {
  await mkdir(join(root, "rootfs"));
  await writeFile(join(root, "rootfs/input"), "fixture");
  const key = await generateImageKey(join(root, "author.pem"));
  const built = await buildImage({ mode: "userspace", id: "minimal", version: "1", source: { kind: "directory", path: "rootfs" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 } }, { recipeDir: root, signingKeyFile: key.privateKeyPath });
  return { image: { bundle: built.bundleDir, trust: key.trust } };
}

it("scaffolds System images from explicit kernel and disk files without a managed bootstrap", async () => {
  await scratch(async root => {
    const directory = join(root, "system");
    await initializeImage(directory, "system");
    const recipe = await readFile(join(directory, "oxidevm.image.ts"), "utf8");
    expect(recipe).toContain('"kind": "boot-files"');
    expect(recipe).not.toContain("managed-default");
    await expect(readFile(join(directory, "Dockerfile"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("maps the package's configured registry only when this release has one", async () => {
  // While the packages are private, a same-named public package must never be installed instead.
  const cli: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const publish = object(cli, "CLI manifest")["publishConfig"];
  await scratch(async root => {
    const app = join(root, "app");
    await initializeApplication(app, "userspace", true, new AbortController().signal, await imageInputs(root));
    if (publish === undefined || object(publish, "publish configuration")["registry"] === "https://registry.npmjs.org/") await expect(readFile(join(app, ".npmrc"))).rejects.toMatchObject({ code: "ENOENT" });
    else expect(settings(await readFile(join(app, ".npmrc"), "utf8"))).toEqual([`@oxidevm:registry=${text(object(publish, "publish configuration")["registry"])}`]);
    const manifest: unknown = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
    // The scope covers the app's two exact @oxidevm dependencies.
    const version = getSDKRelease().sdkVersion;
    expect(manifest).toMatchObject({ dependencies: { "@oxidevm/sdk": version }, devDependencies: { "@oxidevm/cli": version } });
    expect(await readFile(join(app, ".gitignore"), "utf8")).not.toContain(".npmrc");
  });
});

it("never overwrites an existing .npmrc: init scaffolds only a new directory", async () => {
  await scratch(async root => {
    const app = join(root, "app");
    await mkdir(app);
    const own = "registry=https://registry.example/\n";
    await writeFile(join(app, ".npmrc"), own);
    await expect(initializeApplication(app, "userspace", true, new AbortController().signal, await imageInputs(root))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await readFile(join(app, ".npmrc"), "utf8")).toBe(own);
  });
});

it("scaffolds an explicitly trusted image and rejects a mode mismatch before creating the app", async () => {
  await scratch(async root => {
    await mkdir(join(root, "rootfs"));
    await writeFile(join(root, "rootfs/input"), "fixture");
    const key = await generateImageKey(join(root, "author.pem"));
    const built = await buildImage({ mode: "userspace", id: "minimal", version: "1", source: { kind: "directory", path: "rootfs" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 } }, { recipeDir: root, signingKeyFile: key.privateKeyPath });
    const app = join(root, "app");
    const options = { image: { bundle: built.bundleDir, trust: key.trust } };
    await initializeApplication(app, "userspace", true, new AbortController().signal, options);
    expect(await readFile(join(app, "oxidevm.config.ts"), "utf8")).toContain(built.image.manifestSHA256);
    expect(await readFile(join(app, "src/image.ts"), "utf8")).toContain("defineImage");
    const lock: unknown = JSON.parse(await readFile(join(app, "oxidevm.lock.json"), "utf8"));
    expect(lock).toMatchObject({ image: { manifestSHA256: built.image.manifestSHA256 } });
    await expect(initializeApplication(join(root, "wrong"), "system", true, new AbortController().signal, options)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(readFile(join(root, "wrong/package.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("creates the canonical nginx starter and preserves its private archive override", async () => {
  await scratch(async root => {
    const sdk = join(root, "sdk.tgz"), cli = join(root, "cli.tgz");
    await writeFile(sdk, "fixture"); await writeFile(cli, "fixture");
    const app = join(root, "starter");
    await initializeApplication(app, "userspace", true, new AbortController().signal, { ...await imageInputs(root), archives: { sdk, cli } });
    const manifest: unknown = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
    expect(manifest).toMatchObject({ private: true, dependencies: { "@oxidevm/sdk": `file:${sdk}`, "@xterm/xterm": "6.0.0" }, overrides: { "@oxidevm/sdk": `file:${sdk}` } });
    expect(await readFile(join(app, "index.html"), "utf8")).toContain("Your starter app.");
    expect(await readFile(join(app, "src/server.ts"), "utf8")).toContain("/usr/sbin/nginx");
    expect(await readFile(join(app, "tsconfig.json"), "utf8")).not.toContain("../../");
    expect(await readFile(join(app, "tsconfig.node.json"), "utf8")).not.toContain("../../");
  });
});

it("stages an explicit local image without downloading an engine when hosting stays framed", async () => {
  await scratch(async root => {
    const input = await imageInputs(root), fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No engine download"));
    try {
      const app = join(root, "hosted-custom");
      await initializeApplication(app, "userspace", false, new AbortController().signal, input);
      expect(fetch).not.toHaveBeenCalled();
      expect(await readFile(join(app, "src/runtime.ts"), "utf8")).toContain('hosting: "frame"');
      await expect(readFile(join(app, ".oxidevm/assets/oxidevm/runtime/oxidevm_userspace.wasm"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(app, "src/image.ts"), "utf8")).toContain("/oxidevm/images/");
    } finally { fetch.mockRestore(); }
  });
});

it("keeps local development hosting explicit and production hosting framed", async () => {
  await scratch(async root => {
    const app = join(root, "self-hosted");
    await initializeApplication(app, "userspace", true, new AbortController().signal, { ...await imageInputs(root), engineDir: join(root, "engine") });
    const runtime = await readFile(join(app, "src/runtime.ts"), "utf8");
    expect(runtime).toContain('import.meta.env.DEV ? { hosting: "self-hosted", baseUrl: "/oxidevm/runtime/" } : { hosting: "frame" }');
    expect(await readFile(join(app, "src/main.ts"), "utf8")).toContain("runtime,");
  });
});
