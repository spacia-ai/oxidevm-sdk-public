import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { runCLI } from "./run.js";
import { decodeCliReport } from "./report.js";
import { buildImage, getSDKRelease, loadImageRecipe } from "@oxidevm/sdk/image-builder";

it("creates real keys and templates, emits one JSON report and preserves existing author files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-cli-"));
  try {
    const execute = async (args: readonly string[]) => {
      const stdout: string[] = []; const stderr: string[] = [];
      const code = await runCLI(args, { directory, environment: {}, signal: new AbortController().signal, stdout: text => { stdout.push(text); }, stderr: text => { stderr.push(text); } });
      expect(stdout).toHaveLength(1);
      return { code, report: decodeCliReport(JSON.parse(stdout[0] ?? "null") as unknown), stderr };
    };
    const generated = await execute(["image", "keygen", "--out", "author.pem", "--json"]);
    expect(generated.code).toBe(0); expect(generated.report).toMatchObject({ kind: "result", command: "image keygen" });
    const key = await readFile(join(directory, "author.pem"));
    const repeated = await execute(["image", "keygen", "--out", "author.pem", "--json"]);
    expect(repeated.code).not.toBe(0); expect(repeated.report.kind).toBe("error"); expect(await readFile(join(directory, "author.pem"))).toEqual(key);
    const image = await execute(["image", "init", "python", "--mode", "userspace", "--json"]);
    expect(image.code).toBe(0); expect(await readFile(join(directory, "python/oxidevm.image.ts"), "utf8")).toContain("userspace");
    await mkdir(join(directory, "rootfs")); await writeFile(join(directory, "rootfs/input"), "fixture");
    const built = await buildImage({ mode: "userspace", id: "cli-fixture", version: "1", source: { kind: "directory", path: "rootfs" }, smokeTest: { command: "/bin/true", expectedExitCode: 0 } }, { recipeDir: directory, signingKeyFile: join(directory, "author.pem") });
    const explicitImage = ["--image", built.bundleDir, "--image-trust", join(directory, "author.public.json")];
    const app = await execute(["init", "app", "--mode", "userspace", ...explicitImage, "--skip-assets", "--json"]);
    expect(app.code).toBe(0); expect(await readFile(join(directory, "app/oxidevm.config.ts"), "utf8")).toContain(built.image.manifestSHA256);
    await mkdir(join(directory, ".oxidevm"));
    await writeFile(join(directory, "sdk.tgz"), "fixture"); await writeFile(join(directory, "cli.tgz"), "fixture");
    await writeFile(join(directory, ".oxidevm/starter.json"), JSON.stringify({ schemaVersion: 1, sdkVersion: getSDKRelease().sdkVersion, image: { bundle: built.bundleDir, trust: join(directory, "author.public.json") }, engineDir: join(directory, "prebuilt-engine"), archives: { sdk: join(directory, "sdk.tgz"), cli: join(directory, "cli.tgz") } }));
    const quick = await execute(["init", "quick", "--skip-assets", "--json"]);
    expect(quick.code).toBe(0);
    expect(await readFile(join(directory, "quick/oxidevm.config.ts"), "utf8")).toContain(built.image.manifestSHA256);
    // The SDK contains no engine: staging assets from a directory that is not the pinned release fails as a core load.
    const engineless = await execute(["init", "engineless", "--mode", "userspace", ...explicitImage, "--engine-dir", "no-engine-here", "--json"]);
    expect(engineless.code).toBe(1);
    expect(engineless.report).toMatchObject({ kind: "error", command: "init", error: { code: "CORE_LOAD_FAILED" } });
    const fullImage = await execute(["image", "init", "full-image", "--mode", "system", "--json"]);
    expect(fullImage.code).toBe(0);
    expect(await loadImageRecipe(join(directory, "full-image/oxidevm.image.ts"))).toMatchObject({ mode: "system", source: { kind: "boot-files" } });
    const inputs: unknown = JSON.parse(await readFile(join(directory, "full-image/image.lock.json"), "utf8")) as unknown;
    expect(inputs).toMatchObject({ kind: "build-inputs", mode: "system", id: "custom-linux", version: "1.0.0", sourceDateEpoch: 0 });
    const invalid = await execute(["init", "invalid", "--mode", "auto", "--json"]);
    expect(invalid.code).toBe(2); expect(invalid.report).toMatchObject({ kind: "error", error: { code: "INVALID_ARGUMENT" } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
