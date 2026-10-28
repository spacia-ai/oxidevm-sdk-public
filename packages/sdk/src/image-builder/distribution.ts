import { sign } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineImage } from "../image.js";
import type { RuntimeMode } from "../values.js";
import { VMError } from "../runtime/errors.js";
import { record } from "../runtime/decode.js";
import { canonicalUserspaceRootfsBytes, decodeUserspaceRootfsManifest } from "../runtime/userspace-rootfs.js";
import { canonicalManagedImageBytes, decodeManagedImageManifest } from "../runtime/managed-image.js";
import type { BuildImageOptions, ImageBuildResult, ImageRecipe } from "./contracts.js";
import { atomicBundle } from "./atomic.js";
import { inspectImage } from "./bundle.js";
import { decodeBundleJSON } from "./bundle-files.js";
import { validateEvidence } from "./evidence.js";
import type { InventoryFile, SourceEvidenceArtifact } from "./evidence.js";
import { hash, stageFileArtifact, writeArtifact } from "./files.js";
import { loadSigningKey } from "./keys.js";
import { imageManifestURL } from "./build-lock.js";
import { buildRootfsPacks } from "./rootfs-packs.js";
import type { BuildkitInputFacts } from "./buildkit-inputs.js";
import type { OCIImageEvidence } from "./oci-attestations.js";
import type { BuildInputFacts } from "./bundle-inputs.js";

export interface BuildPayloadReceipt {
  readonly inventory: readonly InventoryFile[];
  readonly payloadSHA256: string;
  readonly sourceIdentity: string;
  readonly buildInputs: BuildInputFacts;
  readonly buildkit?: { readonly inputs: BuildkitInputFacts; readonly evidence: OCIImageEvidence };
}
export type BuildOnce = (recipe: ImageRecipe, options: BuildImageOptions,
  receipt: (value: BuildPayloadReceipt) => void) => Promise<ImageBuildResult<RuntimeMode>>;

export function assertReproduction(first: BuildPayloadReceipt, second: BuildPayloadReceipt): void {
  if (first.payloadSHA256 !== second.payloadSHA256) throw new VMError("PROTOCOL_ERROR", `independent image payload differs: ${first.payloadSHA256} / ${second.payloadSHA256}`);
  if (first.sourceIdentity !== second.sourceIdentity) throw new VMError("PROTOCOL_ERROR", `independent source identity differs: ${first.sourceIdentity} / ${second.sourceIdentity}`);
  if (hash(JSON.stringify(first.inventory)) !== hash(JSON.stringify(second.inventory))) throw new VMError("PROTOCOL_ERROR", "independent image inventory differs");
  if (hash(JSON.stringify(first.buildInputs)) !== hash(JSON.stringify(second.buildInputs))) throw new VMError("PROTOCOL_ERROR", "independent build input resolutions differ");
}

/** Each run has a new source tree and output; nothing is exposed until both agree. */
export async function buildDistribution(recipe: ImageRecipe, options: BuildImageOptions, buildOnce: BuildOnce): Promise<ImageBuildResult<RuntimeMode>> {
  if (recipe.evidence === undefined) throw new VMError("INVALID_ARGUMENT", "distribution evidence is required");
  if (recipe.sourceDateEpoch === undefined) throw new VMError("INVALID_ARGUMENT", "distribution builds require sourceDateEpoch");
  const temporary = await mkdtemp(join(tmpdir(), "oxidevm-independent-builds-"));
  try {
    const receipts: BuildPayloadReceipt[] = []; const outputs: ImageBuildResult<RuntimeMode>[] = [];
    for (const run of [1, 2] as const) {
      options.onProgress?.({ phase: "reproduce", run });
      outputs.push(await buildOnce(recipe, { ...options, outDir: join(temporary, String(run)) }, value => receipts.push(value)));
    }
    const [first, second] = receipts; const output = outputs[0];
    if (first === undefined || second === undefined || output === undefined || receipts.length !== 2) {
      throw new VMError("PROTOCOL_ERROR", "independent image build receipts are missing; candidate output was not published");
    }
    assertReproduction(first, second);
    const reviewed = await validateEvidence(options.recipeDir, recipe.evidence, first.inventory, options.signal, first.buildkit?.evidence.sbom, recipe.sourceDateEpoch);
    const signing = await loadSigningKey(resolve(options.recipeDir, options.signingKeyFile));
    const out = resolve(options.recipeDir, options.outDir ?? "dist");
    return await atomicBundle(out, async bundle => {
      // Rebuild evidence and transport packs so unsigned development inputs never ship.
      for (const name of await readdir(output.bundleDir)) if (name !== "evidence" && name !== "packs") await cp(join(output.bundleDir, name), join(bundle, name), { recursive: true, force: false, errorOnExist: true });
      const stage = (artifact: SourceEvidenceArtifact) => stageFileArtifact(bundle, "sources", artifact.inputPath, artifact, options.signal);
      const packages = [];
      for (const source of reviewed.sources) {
        packages.push(source.kind === "source" ? { packageId: source.packageId, kind: source.kind,
          archive: await stage(source.archive), buildInstructions: await stage(source.buildInstructions),
          ...(source.relinkMaterials === undefined ? {} : { relinkMaterials: await stage(source.relinkMaterials) }) }
          : { packageId: source.packageId, kind: source.kind });
      }
      const licensePolicy = await writeArtifact(bundle, "evidence", reviewed.policy);
      const correspondingSources = await writeArtifact(bundle, "evidence", Buffer.from(JSON.stringify({ schemaVersion: 1, licensePolicy, packages })));
      const inventory = await writeArtifact(bundle, "evidence", Buffer.from(JSON.stringify({ schemaVersion: 1, files: first.inventory })));
      const distribution = { kind: "candidate", browserTestsRequired: true } as const;
      const reproducibility = await writeArtifact(bundle, "evidence", Buffer.from(JSON.stringify({ schemaVersion: 1, role: "reproducibility", status: "verified",
        smokeTest: recipe.smokeTest, distribution, inventory, inventorySHA256: reviewed.inventorySHA256,
        sourceIdentity: first.sourceIdentity, sourceDateEpoch: recipe.sourceDateEpoch, buildInputs: first.buildInputs,
        payloadSHA256: first.payloadSHA256, runs: receipts.map(receipt => ({ payloadSHA256: receipt.payloadSHA256, sourceIdentity: receipt.sourceIdentity })) })));
      const provenance = { keyId: signing.trust.keyId, signature: "A".repeat(86), sbom: await writeArtifact(bundle, "evidence", reviewed.sbom),
        notices: await writeArtifact(bundle, "evidence", reviewed.notices), correspondingSources, reproducibility };
      const previous = Object.fromEntries(Object.entries(record(decodeBundleJSON(new Uint8Array(await readFile(join(bundle, "manifest.json")))), "built manifest")).filter(([key])=>key!=="packs"));
      const source={...previous,provenance,...(recipe.mode==="userspace"?{schemaVersion:6}:{})};
      const base = new URL(output.image.manifestUrl, "https://image.invalid");
      const manifest=recipe.mode==="userspace"?{...source,schemaVersion:8,packs:await buildRootfsPacks(bundle,source,base,options.signal)}:source;
      const canonical = recipe.mode === "userspace" ? canonicalUserspaceRootfsBytes(decodeUserspaceRootfsManifest(manifest, base))
        : canonicalManagedImageBytes(decodeManagedImageManifest(manifest, base));
      const manifestBytes = `${JSON.stringify({ ...manifest, provenance: { ...provenance, signature: sign(null, canonical, signing.key).toString("base64url") } }, null, 2)}\n`;
      const digest = hash(manifestBytes);
      const image = defineImage({ mode: recipe.mode, manifestUrl: imageManifestURL(recipe.id, digest, options.publicBaseUrl), manifestSHA256: digest, trust: signing.trust });
      const lock = record(decodeBundleJSON(new Uint8Array(await readFile(join(bundle, "image.lock.json")))), "image lock");
      await writeFile(join(bundle, "manifest.json"), manifestBytes);
      await writeFile(join(bundle, "image.lock.json"), `${JSON.stringify({ ...lock, manifestUrl: image.manifestUrl, manifestSHA256: image.manifestSHA256, distribution }, null, 2)}\n`);
      const reference = `${recipe.id}.image.ts`;
      await writeFile(join(bundle, reference), `import { defineImage } from "@oxidevm/sdk";\nexport default defineImage(${JSON.stringify({ mode: image.mode, manifestUrl: image.manifestUrl, manifestSHA256: image.manifestSHA256, trust: image.trust }, null, 2)});\n`);
      await inspectImage(bundle, { trust: signing.trust, ...(options.signal === undefined ? {} : { signal: options.signal }) });
      options.onProgress?.({ phase: "done", manifestSHA256: image.manifestSHA256 });
      return { mode: recipe.mode, image, bundleDir: out, manifestPath: join(out, "manifest.json"), referencePath: join(out, reference), lockPath: join(out, "image.lock.json"), distribution };
    }, options.signal);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
