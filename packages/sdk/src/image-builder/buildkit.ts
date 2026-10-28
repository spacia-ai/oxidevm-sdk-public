import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VMError } from "../runtime/errors.js";
import type { BuildImageOptions, RootfsSource } from "./contracts.js";
import { stageDockerContext } from "./docker-context.js";
import { readOCIImageEvidence } from "./oci-attestations.js";
import type { OCIImageEvidence } from "./oci-attestations.js";
import { buildArgumentsIdentity, resolvedBuildkitImages, sourcePolicy, validateDistributionBuildkit } from "./buildkit-inputs.js";
import type { BuildkitInputFacts } from "./buildkit-inputs.js";
import { runTool } from "./tools.js";
import type { LoadedBuildSecrets } from "./build-secrets.js";

export interface SourceBuildState {
  readonly epoch: number;
  readonly secrets: LoadedBuildSecrets;
  lockedDockerfile?: BuildkitInputFacts;
  readonly onResolved: (inputs: BuildkitInputFacts) => Promise<void>;
}
const SCANNER = "docker/buildkit-syft-scanner@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9";

/** BuildKit alone interprets the Dockerfile; the loaded export must be the attested final image. */
export async function buildDockerfile(source: Extract<RootfsSource, { readonly kind: "dockerfile" }>, staging: string, tag: string, options: BuildImageOptions, state: SourceBuildState): Promise<{ readonly inputs: BuildkitInputFacts; readonly evidence: OCIImageEvidence }> {
  const staged = await stageDockerContext(source, staging, options, state.epoch, state.secrets);
  const docker = await runTool("docker", ["version", "--format", "{{.Client.Version}}"], options);
  const buildx = await runTool("docker", ["buildx", "version"], options);
  const inspect = await runTool("docker", ["buildx", "inspect", "--bootstrap"], options);
  const buildkit = [...new Set([...inspect.matchAll(/^BuildKit version:\s+([A-Za-z0-9.+_-]{1,128})\s*$/gmu)].map(match => match[1]).filter((value): value is string => value !== undefined))].sort();
  if (buildkit.length === 0 || docker.length > 256 || buildx.length > 256) throw new VMError("FEATURE_NOT_AVAILABLE", "image authoring requires a running BuildKit builder with OCI and attestation export support");
  if (source.buildArgs?.["BUILDKIT_CACHE_MOUNT_NS"] !== undefined) throw new VMError("INVALID_ARGUMENT", "the builder owns BUILDKIT_CACHE_MOUNT_NS for independent cache-mount isolation");
  const policy = join(staging, "source-policy.json");
  const locked = state.lockedDockerfile;
  const previous = locked?.dockerfileSHA256 === staged.dockerfileSHA256 && locked.buildArgsSHA256 === buildArgumentsIdentity({ ...source.buildArgs, SOURCE_DATE_EPOCH: String(state.epoch) }) ? locked.images : [];
  await writeFile(policy, sourcePolicy(previous), { flag: "wx", mode: 0o600 });
  const env = { ...process.env, SOURCE_DATE_EPOCH: String(state.epoch), EXPERIMENTAL_BUILDKIT_SOURCE_POLICY: policy };
  const args = ["buildx", "build", "--platform", "linux/amd64", "--tag", tag, "--file", staged.dockerfile];
  if (options.purpose === "distribution") args.push("--network=none");
  if (source.target !== undefined) args.push("--target", source.target);
  for (const [key, value] of Object.entries(source.buildArgs ?? {})) args.push("--build-arg", `${key}=${value}`);
  args.push("--build-arg", `SOURCE_DATE_EPOCH=${String(state.epoch)}`, "--build-arg", `BUILDKIT_CACHE_MOUNT_NS=oxidevm-${randomUUID()}`);
  const secrets = join(staging, "private-mounts"); await mkdir(secrets, { mode: 0o700 });
  for (const secret of state.secrets.mounts) {
    const path = join(secrets, secret.id); await writeFile(path, secret.bytes, { mode: 0o600, flag: "wx" });
    args.push("--secret", `id=${secret.id},src=${path}`);
  }
  const archive = join(staging, "attested-image.tar");
  await runTool("docker", [...args, "--no-cache", `--sbom=generator=${SCANNER}`, "--provenance=mode=max,version=v0.2", "--output", `type=oci,dest=${archive},rewrite-timestamp=true`, staged.context], { ...options, env });
  const evidence = await readOCIImageEvidence(archive, options.signal);
  if (options.purpose === "distribution") validateDistributionBuildkit(evidence.provenance);
  const images = resolvedBuildkitImages(evidence.provenance).map(image => {
    const prior = previous.find(pin => pin.pinnedIdentifier === image.identifier || pin.identifier === image.identifier);
    return prior === undefined ? image : { identifier: prior.identifier, pinnedIdentifier: image.pinnedIdentifier };
  });
  const inputs: BuildkitInputFacts = { kind: "dockerfile", platform: "linux/amd64", dockerfileSHA256: staged.dockerfileSHA256, contextSHA256: staged.contextSHA256,
    buildArgsSHA256: buildArgumentsIdentity({ ...source.buildArgs, SOURCE_DATE_EPOCH: String(state.epoch) }), target: source.target ?? null, images, tools: { docker, buildx, buildkit } };
  await state.onResolved(inputs); state.lockedDockerfile = inputs;
  await writeFile(policy, sourcePolicy(images), { mode: 0o600 });
  // Classic storage needs a second export; its loaded identity must match the verified OCI descriptors.
  try {await runTool("docker",["load","--input",archive],options);}
  catch(error){
    if(!(error instanceof VMError)||error.code!=="STORAGE_ERROR")throw error;
    const loadedArchive=join(staging,"loaded-image.tar");
    await runTool("docker", [...args, "--sbom=false", "--provenance=false", "--output", `type=docker,dest=${loadedArchive},rewrite-timestamp=true`, staged.context], { ...options, env });
    await runTool("docker",["load","--input",loadedArchive],options);
  }
  const loaded = await runTool("docker", ["image", "inspect", "--format", "{{.Id}}", tag], options);
  if (loaded !== `sha256:${evidence.configSHA256}`&&loaded!==`sha256:${evidence.manifestSHA256}`&&loaded!==`sha256:${evidence.indexSHA256}`) throw new VMError("PROTOCOL_ERROR", "loaded filesystem export differs from the attested final image identity");
  return { inputs, evidence };
}
