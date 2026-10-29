import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildImage, loadImageRecipe, readImageTrust, validateImageDistribution } from "@oxidevm/sdk/image-builder";
import { fields, run, text } from "./material-inputs.ts";

function decodeBundleJSON(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
const recipe = import.meta.dirname, cache = join(recipe, ".cache");
const required = (name: string) => { const value = process.env[name]; assert(value !== undefined && value !== "", `Set ${name}`); return resolve(value); };
const baseBundle = required("OXIDEVM_PANDAS_BASE_BUNDLE"), trustFile = required("OXIDEVM_PANDAS_BASE_TRUST");
const base = await validateImageDistribution(baseBundle, { trust: await readImageTrust(trustFile) });
const lock: unknown = JSON.parse(await readFile(join(recipe, "python-inputs.lock.json"), "utf8"));
assert(typeof lock === "object" && lock !== null && "base" in lock);
const identity = fields(lock.base, ["id", "version", "manifestSHA256", "filename", "sha256"]);
assert(base.inspection.id === identity["id"] && base.inspection.version === identity["version"] && base.inspection.manifestSHA256 === identity["manifestSHA256"], "Python base differs from its independently trusted pin");
const archive = join(cache, "python-inputs", text(identity["filename"]));
assert(createHash("sha256").update(await readFile(archive)).digest("hex") === identity["sha256"], "Python base archive changed");
await mkdir(cache, { recursive: true });
const container = `oxidevm-pandas-materials-${randomUUID()}`, output = join(cache, "candidate");
await mkdir(output, { recursive: false });
try {
  await run("docker", ["build", "--network=none", "--target", "build", "--tag", container, recipe], { timeout: 900_000, maxBuffer: 16 * 1024 ** 2 });
  await run("docker", ["create", "--name", container, container, "/bin/true"]);
  await run("docker", ["cp", `${container}:/rootfs`, join(output, "rootfs")]);
  const input = { base: { sbom: decodeBundleJSON(base.evidence.sbom), notices: decodeBundleJSON(base.evidence.notices), policy: decodeBundleJSON(base.evidence.policy), sources: base.evidence.sources.map(source => {
    assert(source.kind === "source", "The Python base must retain corresponding sources for every component");
    return { packageId: source.packageId, archive: source.archive.inputPath, sha256: source.archive.sha256, buildInstructions: source.buildInstructions.inputPath };
  }) }, baseArchive: archive, recipe, output };
  const job = join(output, "input.json"); await writeFile(job, JSON.stringify(input), { flag: "wx", mode: 0o600 });
  await run("python3", ["-B", join(recipe, "pandas-materials.py"), job], { timeout: 300_000, maxBuffer: 1024 ** 2 });
} finally {
  await run("docker", ["rm", "--force", container]).catch(() => undefined);
  await run("docker", ["image", "rm", container]).catch(() => undefined);
}
const signingKey = process.env["OXIDEVM_IMAGE_SIGNING_KEY"];
if (signingKey !== undefined) {
  const next = await loadImageRecipe(join(output, "recipe.json"));
  // The builder validates the complete recipe and evidence. Development does not imply release approval.
  const result = await buildImage(next, { recipeDir: output, signingKeyFile: resolve(signingKey), outDir: join(output, "bundle"), purpose: "development" });
  await writeFile(join(output, "RESULT.json"), JSON.stringify(result, null, 2) + "\n");
}
process.stdout.write(`Prepared private image and source materials: ${output}\n`);
