import { inspectImageFiles } from "./bundle.js";
import type { ReadImageBundle } from "./bundle.js";
import type { TrustedImageKey } from "../image.js";
import { readDistributionClosure } from "./distribution-closure.js";
import { validateEvidenceDocuments } from "./evidence.js";
import type { ValidatedEvidence } from "./evidence.js";
import { artifactRelativePath, readBundleFile, verifyBundleArtifact } from "./bundle-files.js";
import { VMError } from "../runtime/errors.js";
import { decodeBundleJSON } from "./bundle-files.js";
import { validateDistributionComponents } from "./distribution-components.js";

/** Authenticate a supplied image and validate its complete distribution evidence before staging it. */
export async function validateImageDistribution(bundleDir: string, options: { readonly trust: TrustedImageKey; readonly components?: unknown; readonly signal?: AbortSignal }) {
  const inspected = await inspectImageFiles(bundleDir, options);
  if (inspected.inspection.authentication.kind !== "verified") throw new VMError("INVALID_ARGUMENT", "distribution validation requires independent author trust");
  const evidence = await validateDistributionBundle(inspected.read, options.signal);
  if (options.components !== undefined) validateDistributionComponents(decodeBundleJSON(evidence.sbom), { packages: evidence.sources }, options.components);
  return { inspection: inspected.inspection, files: inspected.files, evidence };
}

/** Inspection and browser qualification use the identical signed evidence closure. */
export async function validateDistributionBundle(read: ReadImageBundle, signal?: AbortSignal): Promise<ValidatedEvidence> {
  const closure = await readDistributionClosure(read, signal);
  const provenance = read.manifest.provenance;
  if (closure === undefined || provenance === undefined) throw new VMError("PROTOCOL_ERROR", "distribution image lacks verified independent reproduction and final inventory");
  for (const artifact of closure.artifacts) await verifyBundleArtifact(read.bundle, read.base, artifact, signal);
  const bytes = async (artifact: { readonly url: URL; readonly bytes: number; readonly sha256: string }) => {
    await verifyBundleArtifact(read.bundle, read.base, artifact, signal);
    return readBundleFile(read.bundle, artifactRelativePath(read.base, artifact.url), Math.min(artifact.bytes, 16 * 1024 ** 2), signal);
  };
  return validateEvidenceDocuments(read.bundle, { sbom: await bytes(provenance.sbom), notices: await bytes(provenance.notices),
    sourceBytes: closure.sourceDocument, policy: await bytes(closure.policy) }, closure.inventory, signal);
}
