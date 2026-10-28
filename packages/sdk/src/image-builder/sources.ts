import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { c } from "tar";
import { VMError } from "../runtime/errors.js";
import type { BuildImageOptions, RootfsSource } from "./contracts.js";
import { stageFileArtifact } from "./files.js";
import type { SourceFileMetadata } from "./files.js";
import { runTool } from "./tools.js";
import { unpackSourceArchive } from "./archive.js";
import { restoreImageEntries, savedImageEntries } from "./docker-init-layer.js";
import { buildDockerfile } from "./buildkit.js";
import type { SourceBuildState } from "./buildkit.js";
import type { BuildkitInputFacts } from "./buildkit-inputs.js";
import type { OCIImageEvidence } from "./oci-attestations.js";
import { loadBuildSecrets } from "./build-secrets.js";


export async function materializeSource(source: RootfsSource, staging: string, options: BuildImageOptions, state?: SourceBuildState): Promise<{ readonly root: string; readonly identity: string; readonly metadata: ReadonlyMap<string, SourceFileMetadata>; readonly buildkit?: { readonly inputs: BuildkitInputFacts; readonly evidence: OCIImageEvidence } }> {
  const root = join(staging, "rootfs"); await mkdir(root);
  if (source.kind === "directory") {
    const archive = join(staging, "directory.tar");
    await c({ cwd: resolve(options.recipeDir, source.path), file: archive, noMtime: true, jobs: 1 }, ["."]);
    const metadata = await unpackSourceArchive(archive, root, options.signal);
    await rm(archive);
    return { root, identity: "directory-content", metadata };
  }
  if (source.kind === "archive") {
    const input = resolve(options.recipeDir, source.artifact.path);
    const staged = await stageFileArtifact(staging, "verified-inputs", input, { bytes: (await lstat(input)).size, sha256: source.artifact.sha256 }, options.signal);
    const metadata = await unpackSourceArchive(join(staging, staged.url.slice(2)), root, options.signal);
    return { root, identity: source.artifact.sha256, metadata };
  }
  const tag = `oxidevm-build-${randomUUID()}`; const container = `oxidevm-export-${randomUUID()}`;
  const archive = join(staging, "rootfs.tar"); const saved = join(staging, "saved-image.tar");
  try {
    let reference: string;
    let buildkit: Awaited<ReturnType<typeof buildDockerfile>> | undefined;
    if (source.kind === "oci") {
      if (options.purpose === "distribution" && !/@sha256:[0-9a-f]{64}$/u.test(source.reference)) throw new VMError("INVALID_ARGUMENT", "distribution OCI sources require a digest");
      await runTool("docker", ["pull", "--platform", "linux/amd64", source.reference], options);
      reference = source.reference;
    } else {
      buildkit = await buildDockerfile(source, staging, tag, options, state ?? { epoch: 0, secrets: await loadBuildSecrets(options), onResolved: async () => {} });
      reference = tag;
    }
    const identity = await runTool("docker", ["image", "inspect", "--format", "{{.Id}}", reference], options);
    if (!/^sha256:[0-9a-f]{64}$/u.test(identity)) throw new VMError("PROTOCOL_ERROR", "builder returned invalid image identity");
    if (await runTool("docker", ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", reference], options) !== "linux/amd64") throw new VMError("PROTOCOL_ERROR", "source image does not match the required linux/amd64 platform");
    const identifier = await runTool("docker", ["create", "--name", container, "--platform", "linux/amd64", reference, "/bin/true"], options);
    if (!/^[0-9a-f]{64}$/u.test(identifier)) throw new VMError("PROTOCOL_ERROR", "builder returned invalid container identity");
    await runTool("docker", ["export", "--output", archive, container], options);
    const exported = await unpackSourceArchive(archive, root, options.signal);
    await rm(archive, { force: true });
    // The export is a container's: the verified image's own layers say what Docker's init layer covered.
    await runTool("docker", ["image", "save", "--output", saved, identity], options);
    const metadata = await restoreImageEntries(root, exported, await savedImageEntries(saved, options.signal), options.signal);
    // Attestation indexes contain per-run provenance. The verified image config owns source identity.
    return { root, identity: buildkit === undefined ? identity : `sha256:${buildkit.evidence.configSHA256}`, metadata, ...(buildkit === undefined ? {} : { buildkit }) };
  } finally {
    await runTool("docker", ["rm", "--force", container], { timeoutMs: 30_000 }).catch(() => undefined);
    if (source.kind === "dockerfile") await runTool("docker", ["image", "rm", tag], { timeoutMs: 30_000 }).catch(() => undefined);
    await rm(archive, { force: true }); await rm(saved, { force: true });
  }
}
