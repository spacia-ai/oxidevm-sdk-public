import { buildRootfsPacks } from "./rootfs-packs.js";
import { sign } from "node:crypto";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { defineImage } from "../image.js";
import { decodeSHA256 } from "../values.js";
import type { RuntimeMode } from "../values.js";
import { VMError } from "../runtime/errors.js";
import { canonicalUserspaceRootfsBytes, decodeUserspaceRootfsManifest, isUserspaceWorkspacePath, userspaceTreeIdentity } from "../runtime/userspace-rootfs.js";
import type { UserspaceRootfsEntry } from "../runtime/userspace-rootfs.js";
import type { FileOwnership } from "../runtime/workspace-record.js";
import { canonicalManagedImageBytes, decodeManagedImageManifest } from "../runtime/managed-image.js";
import type { BuildImageOptions, SystemImageRecipe, ImageBuildResult, ImageDistribution, ImageRecipe, UserspaceImageRecipe } from "./contracts.js";
import { atomicBundle } from "./atomic.js";
import { assertNoBuildSecrets, checkedArtifact, collectRootfs, hash, hashFile, writeArtifact } from "./files.js";
import { inspectImage } from "./bundle.js";
import { loadSigningKey } from "./keys.js";
import { decodeImageRecipe } from "./recipe.js";
import { materializeSource } from "./sources.js";
import { abortIfRequested } from "./tools.js";
import { createRootfsDisk, workspaceIdentityFromDisk } from "./system-disk.js";
import { loadManagedIntegration } from "./managed-integration.js";
import { stageManagedIntegration } from "./managed-rootfs.js";
import { buildDistribution } from "./distribution.js";
import type { BuildPayloadReceipt } from "./distribution.js";
import { treeInventory, payloadIdentity } from "./inventory.js";
import type { InventoryFile } from "./evidence.js";
import { record } from "../runtime/decode.js";
import { validateOutputPath } from "./output-path.js";
import { decodeBuildImageOptions } from "./build-options.js";
import { imageManifestURL, lockBuildEpoch, previousDockerfileInputs, saveAuthorLock, withAuthorBuild } from "./build-lock.js";
import type { SourceBuildState } from "./buildkit.js";
import { loadBuildSecrets } from "./build-secrets.js";
import { decodeBuildInputFacts } from "./bundle-inputs.js";

/** The Userspace runtime's default credentials; a process runs as root only when its VM asks. */
const DEFAULT_USER: FileOwnership = { uid: 1000, gid: 1000 };

/** Final Userspace inode metadata. As in the builder's ext4 output, every inode carries the
 * authenticated build epoch, so framework caches never see an invented epoch-zero filesystem.
 * `/workspace` and everything below it belong to the workspace owner, so the default user can
 * edit the project; every other entry keeps the owner its source recorded. The runtime mounts
 * `/workspace` separately, so no hardlink may join it to the rest of the rootfs. */
function userspaceEntries(entries: readonly UserspaceRootfsEntry[], sourceDateEpoch: number, workspaceOwner: FileOwnership): UserspaceRootfsEntry[] {
  const epochNs = (BigInt(sourceDateEpoch) * 1_000_000_000n).toString();
  return entries.map(entry => {
    const inWorkspace = isUserspaceWorkspacePath(entry.path);
    if (entry.type === "hardlink" && inWorkspace !== isUserspaceWorkspacePath(entry.target)) {
      throw new VMError("INVALID_ARGUMENT", "a Userspace hardlink cannot cross the separately mounted /workspace", { path: entry.path });
    }
    return { ...entry, ...(inWorkspace ? { ownership: workspaceOwner } : {}), times: { accessNs: epochNs, modificationNs: epochNs } };
  });
}

export function buildImage(recipe: SystemImageRecipe, options: BuildImageOptions): Promise<ImageBuildResult<"system">>;
export function buildImage(recipe: UserspaceImageRecipe, options: BuildImageOptions): Promise<ImageBuildResult<"userspace">>;
export function buildImage(recipe: ImageRecipe, options: BuildImageOptions): Promise<ImageBuildResult<RuntimeMode>>;
export async function buildImage(input: ImageRecipe, supplied: BuildImageOptions): Promise<ImageBuildResult<RuntimeMode>> {
  const decoded = decodeImageRecipe(input);
  const options = decodeBuildImageOptions(supplied);
  if ((options.secrets?.length ?? 0) !== 0 && decoded.source.kind !== "dockerfile") throw new VMError("INVALID_ARGUMENT", "secret mounts require a Dockerfile/BuildKit source");
  const checked = { ...options, outDir: await validateOutputPath(decoded, options) };
  return withAuthorBuild(resolve(options.recipeDir), options.signal, async () => {
  const recipe = await lockBuildEpoch(decoded, resolve(options.recipeDir));
  const previous = await previousDockerfileInputs(resolve(options.recipeDir));
  const state: SourceBuildState = { epoch: recipe.sourceDateEpoch, secrets: await loadBuildSecrets(options), ...(previous === undefined ? {} : { lockedDockerfile: previous }),
    onResolved: async buildInputs => { await saveAuthorLock(resolve(options.recipeDir), `${JSON.stringify({ schemaVersion: 2, kind: "build-inputs", mode: recipe.mode, id: recipe.id, version: recipe.version, sourceDateEpoch: recipe.sourceDateEpoch, buildInputs }, null, 2)}\n`); } };
  const once = (input: ImageRecipe, options: BuildImageOptions, receipt?: (value: BuildPayloadReceipt) => void) => buildImageOnce(input, options, receipt, state);
  const result = options.purpose === "distribution" ? await buildDistribution(recipe, checked, once) : await once(recipe, checked);
  await saveAuthorLock(resolve(options.recipeDir), await readFile(result.lockPath, "utf8"));
  return result;
  });
}

async function buildImageOnce(input: ImageRecipe, options: BuildImageOptions, receipt?: (value: BuildPayloadReceipt) => void, state?: SourceBuildState): Promise<ImageBuildResult<RuntimeMode>> {
  const recipe = decodeImageRecipe(input); abortIfRequested(options.signal);
  options.onProgress?.({ phase: "resolve" });
  const signing = await loadSigningKey(resolve(options.recipeDir, options.signingKeyFile));
  const forbidden = state?.secrets.forbidden ?? (await loadBuildSecrets(options)).forbidden;
  const out = resolve(options.recipeDir, options.outDir ?? "dist");
  const base = String(options.publicBaseUrl ?? `/oxidevm/images/${recipe.id}/${recipe.version}/`);
  if (!base.endsWith("/")) throw new VMError("INVALID_ARGUMENT", "publicBaseUrl must end with a slash");
  const manifestUrl = `${base}manifest.json`; const url = new URL(manifestUrl, "https://image.invalid");
  const sourceStaging = await mkdtemp(join(tmpdir(), "oxidevm-image-source-"));
  try {
    return await atomicBundle(out, async bundle => {
      options.onProgress?.({ phase: "build-rootfs" });
      const source = recipe.source.kind === "boot-files" ? undefined : await materializeSource(recipe.source, sourceStaging, options, state);
      options.onProgress?.({ phase: "validate-files" });
      const collected = source === undefined ? undefined : await collectRootfs(source.root, recipe.mode === "userspace" ? bundle : undefined, options.signal, source.metadata, forbidden);
      // The tree and workspace identities below are computed from these final Userspace entries.
      const tree = collected === undefined || recipe.mode !== "userspace" ? collected
        : { ...collected, entries: userspaceEntries(collected.entries, recipe.sourceDateEpoch ?? 0, recipe.workspace?.ownership ?? DEFAULT_USER) };
      if (source?.buildkit !== undefined) { assertNoBuildSecrets(source.buildkit.evidence.sbom, forbidden); assertNoBuildSecrets(Buffer.from(JSON.stringify(source.buildkit.evidence.provenance)), forbidden); }
      const identity = await userspaceTreeIdentity(tree?.entries ?? [], tree?.blobs ?? []);
      const buildInputs = decodeBuildInputFacts(source?.buildkit?.inputs ?? { kind: recipe.source.kind, sourceSHA256: recipe.source.kind === "archive" ? recipe.source.artifact.sha256 : recipe.source.kind === "boot-files" ? recipe.source.disk.sha256 : recipe.source.kind === "oci" ? source?.identity.slice(7) : identity.rootTreeSha256 });
      const missing: readonly ("sbom" | "notices" | "corresponding-sources" | "license-review" | "reproducibility" | "browser-tests")[] = ["sbom", "notices", "corresponding-sources", "license-review", "reproducibility", "browser-tests"];
      const distribution: ImageDistribution = { kind: "development", missing };
      const evidenceArtifact = async (role: string, provided?: string) => writeArtifact(bundle, "evidence", provided === undefined
        ? new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, role, status: "missing", image: { id: recipe.id, version: recipe.version }, smokeTest: recipe.smokeTest, sourceIdentity: source?.identity ?? "boot-files", sourceDateEpoch: recipe.sourceDateEpoch, buildInputs, rootTreeSha256: identity.rootTreeSha256, distribution }))
        : new Uint8Array(await readFile(resolve(options.recipeDir, provided))));
      const sbom = recipe.evidence?.sbom.kind === "buildkit" && source?.buildkit !== undefined ? await writeArtifact(bundle, "evidence", source.buildkit.evidence.sbom)
        : await evidenceArtifact("sbom", recipe.evidence?.sbom.kind === "file" ? recipe.evidence.sbom.path : undefined);
      const notices = await evidenceArtifact("notices", recipe.evidence?.noticesFile);
      const correspondingSources = await evidenceArtifact("corresponding-sources", recipe.evidence?.correspondingSourcesFile);
      const reproducibility = await evidenceArtifact("reproducibility");
      const provenance = { keyId: signing.trust.keyId, signature: "A".repeat(86), sbom, notices, correspondingSources, reproducibility };
      options.onProgress?.({ phase: "package" });
      let manifest: unknown;
      let canonical: Uint8Array<ArrayBuffer>;
      let inventory: readonly InventoryFile[] = tree === undefined ? [] : treeInventory(tree);
      if (recipe.mode === "userspace") {
        if (tree === undefined) throw new VMError("PROTOCOL_ERROR", "Userspace rootfs is absent");
        const regular = new Set(tree.entries.filter(entry => entry.type === "file").map(entry => entry.path));
        const muslLoader = [...regular].find(path => /(^|\/)ld-musl-x86_64\.so\.1$/u.test(path));
        const glibcLoader = [...regular].find(path => /(^|\/)ld-linux-x86-64\.so\.2$/u.test(path));
        manifest = { schemaVersion: 6, kind: "linux-user-rootfs", id: recipe.id, version: recipe.version, architecture: "x86_64", cpuProfile: recipe.cpuProfile ?? "x86-64-v2", sourceDateEpoch: recipe.sourceDateEpoch ?? 0,
          ...identity, resources: { memoryMiB: recipe.resources?.memoryMiB ?? 1024, ...(recipe.resources?.maxProcesses === undefined ? {} : { maxProcesses: recipe.resources.maxProcesses }) }, fileCount: tree.entries.length, totalBytes: tree.blobs.reduce((sum, blob) => sum + blob.bytes, 0),
          blobs: tree.blobs.map(blob => ({ bytes: blob.bytes, sha256: blob.sha256, url: `./blobs/${blob.sha256}` })), entries: tree.entries,
          runtimes: { ...(muslLoader === undefined ? {} : { muslLoader }), ...(glibcLoader === undefined ? {} : { glibcLoader }), supportingFiles: [] }, provenance };
        const packs = await buildRootfsPacks(bundle, manifest, url, options.signal);
        manifest = { ...record(manifest, "rootfs authoring manifest"), schemaVersion: 8, packs };
        canonical = canonicalUserspaceRootfsBytes(decodeUserspaceRootfsManifest(manifest, url));
      } else {
        let kernel: Uint8Array<ArrayBuffer>; let initrd: Uint8Array<ArrayBuffer> | undefined; let diskPath: string; let commandLine: string;
        if (recipe.source.kind === "boot-files") {
          kernel = await checkedArtifact(recipe.source.kernel, options.recipeDir); diskPath = resolve(options.recipeDir, recipe.source.disk.path);
          if (await hashFile(diskPath, options.signal) !== recipe.source.disk.sha256) throw new VMError("PROTOCOL_ERROR", "system disk input differs from its pin");
          initrd = recipe.source.initrd === undefined ? undefined : await checkedArtifact(recipe.source.initrd, options.recipeDir); commandLine = recipe.source.commandLine;
        } else {
          if (recipe.boot === undefined || source === undefined) throw new VMError("INVALID_ARGUMENT", "system recipe requires boot inputs");
          const integration = await loadManagedIntegration(options.signal);
          kernel = recipe.boot.kernel.kind === "file" ? await checkedArtifact(recipe.boot.kernel.artifact, options.recipeDir) : integration.kernel;
          initrd = recipe.boot.initrd === undefined ? undefined : await checkedArtifact(recipe.boot.initrd, options.recipeDir);
          commandLine = recipe.boot.commandLine ?? "root=/dev/vda rw rootwait rootfstype=ext4 console=hvc0 init=/sbin/oxidevm-init net.ifnames=0 loglevel=4 noirqdebug nokaslr norandmaps mitigations=off panic=1 random.trust_bootloader=on tsc=reliable no_timer_check";
          const finalMetadata = await stageManagedIntegration(source.root, integration, recipe.sourceDateEpoch ?? 0, source.metadata, options.signal);
          const finalTree = await collectRootfs(source.root, undefined, options.signal, finalMetadata, forbidden);
          inventory = treeInventory(finalTree);
          const image = join(sourceStaging, "rootfs.ext4");
          await createRootfsDisk({ root: source.root, diskPath: image, entries: finalTree.entries, staging: sourceStaging,
            sizeMiB: recipe.disk?.sizeMiB ?? 1024, sourceDateEpoch: recipe.sourceDateEpoch ?? 0, ...(options.signal === undefined ? {} : { signal: options.signal }) });
          diskPath = image;
        }
        const diskMetadata = await stat(diskPath); const diskBytes = diskMetadata.size;
        if (!diskMetadata.isFile() || diskBytes === 0 || diskBytes % 4096 !== 0 || diskBytes > 64 * 1024 ** 3) throw new VMError("INVALID_ARGUMENT", "system disk must contain complete 4096-byte blocks within the supported bound");
        const chunks = []; const chunkBytes = 4 * 1024 ** 2;
        const encodedChunks = new Map<string, Awaited<ReturnType<typeof writeArtifact>>>(); const file = await open(diskPath, "r");
        try {
          for (let offset = 0; offset < diskBytes; offset += chunkBytes) {
            abortIfRequested(options.signal); const bytes = new Uint8Array(Math.min(chunkBytes, diskBytes - offset)); let filled = 0;
            while (filled < bytes.length) { const read = await file.read(bytes, filled, bytes.length - filled, offset + filled); if (read.bytesRead === 0) throw new VMError("STORAGE_ERROR", "system disk changed during packaging"); filled += read.bytesRead; }
            const sha256 = hash(bytes); let artifact = encodedChunks.get(sha256);
            if (artifact === undefined) { artifact = await writeArtifact(bundle, "chunks", gzipSync(bytes, { level: 9 })); encodedChunks.set(sha256, artifact); }
            chunks.push({ index: offset / chunkBytes, url: artifact.url, bytes: bytes.length, sha256, encoding: "gzip", encodedBytes: artifact.bytes, encodedSha256: artifact.sha256 });
          }
        } finally { await file.close(); }
        manifest = { schemaVersion: 9, id: recipe.id, version: recipe.version, architecture: "x86_64", cpuProfile: recipe.cpuProfile ?? "x86-64-v3", sourceDateEpoch: recipe.sourceDateEpoch ?? 0, memoryMiB: recipe.resources?.memoryMiB ?? 1024,
          vcpus: { minimum: recipe.resources?.vcpus ?? 1, maximum: recipe.resources?.vcpus ?? 1 }, workspaceBaseSha256: await workspaceIdentityFromDisk(diskPath, options.signal),
          commandLine, kernel: await writeArtifact(bundle, "artifacts", kernel), ...(initrd === undefined ? {} : { initrd: await writeArtifact(bundle, "artifacts", initrd) }),
          disk: { bytes: diskBytes, blockBytes: 4096, chunkBytes, chunks }, runtimes: { kind: "custom", versions: {} }, provenance };
        canonical = canonicalManagedImageBytes(decodeManagedImageManifest(manifest, url));
        // Raw boot-file recipes bind their complete disk bytes as a boot artifact;
        // managed rootfs recipes cover the final injected guest files individually.
        inventory = [...inventory, { path: "@boot/kernel", bytes: kernel.length, sha256: hash(kernel) },
          ...(initrd === undefined ? [] : [{ path: "@boot/initrd", bytes: initrd.length, sha256: hash(initrd) }]),
          ...(recipe.source.kind === "boot-files" ? [{ path: "@boot/disk", bytes: diskBytes, sha256: await hashFile(diskPath, options.signal) }] : [])];
      }
      receipt?.({ inventory, payloadSHA256: payloadIdentity(record(manifest, "payload manifest")), sourceIdentity: source?.identity ?? "boot-files", buildInputs, ...(source?.buildkit === undefined ? {} : { buildkit: source.buildkit }) });
      options.onProgress?.({ phase: "sign" });
      const signed = { ...provenance, signature: sign(null, canonical, signing.key).toString("base64url") };
      if (typeof manifest !== "object" || manifest === null) throw new VMError("PROTOCOL_ERROR", "manifest is absent");
      const manifestBytes = `${JSON.stringify({ ...manifest, provenance: signed }, null, 2)}\n`;
      const digest = decodeSHA256(hash(manifestBytes), "built manifest");
      const finalManifestURL = imageManifestURL(recipe.id, digest, options.publicBaseUrl);
      const image = defineImage({ mode: recipe.mode, manifestUrl: finalManifestURL, manifestSHA256: digest, trust: signing.trust });
      await writeFile(join(bundle, "manifest.json"), manifestBytes);
      await writeFile(join(bundle, "image.lock.json"), `${JSON.stringify({ schemaVersion: 2, mode: recipe.mode, id: recipe.id, version: recipe.version, manifestUrl: finalManifestURL, manifestSHA256: digest, trust: signing.trust, distribution, smokeTest: recipe.smokeTest, sourceIdentity: source?.identity ?? "boot-files", sourceDateEpoch: recipe.sourceDateEpoch, buildInputs }, null, 2)}\n`);
      const reference = `${recipe.id}.image.ts`;
      await writeFile(join(bundle, reference), `import { defineImage } from "@oxidevm/sdk";\nexport default defineImage(${JSON.stringify({ mode: image.mode, manifestUrl: image.manifestUrl, manifestSHA256: image.manifestSHA256, trust: image.trust }, null, 2)});\n`);
      await inspectImage(bundle, { trust: signing.trust, ...(options.signal === undefined ? {} : { signal: options.signal }) });
      options.onProgress?.({ phase: "done", manifestSHA256: digest });
      return { mode: recipe.mode, image, bundleDir: out, manifestPath: join(out, "manifest.json"), referencePath: join(out, reference), lockPath: join(out, "image.lock.json"), distribution };
    }, options.signal);
  } finally { await rm(sourceStaging, { recursive: true, force: true }); }
}
