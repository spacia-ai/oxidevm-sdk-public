import { lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { exactKeys, record, string } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";
import { decodeSHA256 } from "../values.js";
import type { EvidenceInputs } from "./contracts.js";
import { decodeBundleJSON, localBundlePath, readBundleFile } from "./bundle-files.js";
import { hash, hashFile } from "./files.js";
import { normalizeBuildkitSBOM } from "./buildkit-sbom.js";
import { validateNestedBunComponents } from "./distribution-components.js";

export interface InventoryFile { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface SourceEvidenceArtifact { readonly inputPath: string; readonly bytes: number; readonly sha256: string }
export type ReviewedSource =
  | { readonly packageId: string; readonly kind: "notice-only" | "explicit-grant" }
  | { readonly packageId: string; readonly kind: "source"; readonly archive: SourceEvidenceArtifact; readonly buildInstructions: SourceEvidenceArtifact; readonly relinkMaterials?: SourceEvidenceArtifact };
export interface ValidatedEvidence {
  readonly sbom: Uint8Array<ArrayBuffer>;
  readonly notices: Uint8Array<ArrayBuffer>;
  readonly policy: Uint8Array<ArrayBuffer>;
  readonly sources: readonly ReviewedSource[];
  readonly sourceArchives: readonly SourceEvidenceArtifact[];
  readonly inventorySHA256: string;
}
interface PackageLicense { readonly id: string; readonly license: string }
function invalid(message: string): never { throw new VMError("INVALID_ARGUMENT", `distribution evidence: ${message}`); }
function text(value: unknown, label: string, maximum = 8192): string {
  const result = string(value, label);
  if (result.length === 0 || result.length > maximum || result.includes("\0")) return invalid(`${label} is invalid`);
  return result;
}
function array(value: unknown, label: string, maximum = 65536): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid(`${label} is not a bounded array`);
  return Array.from<unknown>(value);
}
async function inputBytes(directory: string, path: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const file = resolve(directory, path);
  return readBundleFile(dirname(file), basename(file), 16 * 1024 ** 2, signal);
}

/** An SPDX file inventory is useful only when it covers these exact final bytes. */
function validateSPDX(value: unknown, inventory: readonly InventoryFile[]): readonly PackageLicense[] {
  const document = record(value, "SPDX document");
  if (document["spdxVersion"] !== "SPDX-2.3" || document["dataLicense"] !== "CC0-1.0" || document["SPDXID"] !== "SPDXRef-DOCUMENT") return invalid("SBOM requires SPDX 2.3");
  const packages = new Map<string, PackageLicense>(); const ids = new Set<string>(["SPDXRef-DOCUMENT"]);
  const components: { name: string; license: string }[] = [];
  for (const value of array(document["packages"], "SPDX packages")) {
    const item = record(value, "SPDX package"); const id = text(item["SPDXID"], "package SPDXID");
    if (!/^SPDXRef-[A-Za-z0-9.-]+$/u.test(id) || ids.has(id)) return invalid("duplicate or malformed SPDX identifier");
    const name = text(item["name"], "package name"); text(item["versionInfo"], "package version");
    const license = text(item["licenseConcluded"], "concluded license");
    if (license === "NOASSERTION" || license === "NONE") return invalid("every shipped package requires a concluded license");
    ids.add(id); packages.set(id, { id, license });
    components.push({ name, license });
  }
  validateNestedBunComponents(components);
  const expected = new Map(inventory.map(file => [file.path, file])); const paths = new Set<string>(); const files = new Set<string>();
  for (const value of array(document["files"], "SPDX files")) {
    const item = record(value, "SPDX file"); const id = text(item["SPDXID"], "file SPDXID");
    const path = text(item["fileName"], "SPDX file path").replace(/^\.\//u, "");
    if (!/^SPDXRef-[A-Za-z0-9.-]+$/u.test(id) || ids.has(id) || paths.has(path)) return invalid("duplicate SPDX file or path");
    const checksums = array(item["checksums"], "SPDX checksums", 32).map(value => record(value, "SPDX checksum")).filter(item => item["algorithm"] === "SHA256");
    const checksum = checksums[0]; const actual = expected.get(path);
    if (checksums.length !== 1 || checksum === undefined || actual === undefined || decodeSHA256(checksum["checksumValue"], "SPDX checksum") !== actual.sha256) return invalid("SBOM file coverage differs from the final filesystem or boot artifacts");
    ids.add(id); paths.add(path); files.add(id);
  }
  if (paths.size !== expected.size) return invalid("SBOM file coverage omits final filesystem or boot artifacts");
  const covered = new Set<string>(); const owners = new Set<string>();
  for (const value of array(document["relationships"], "SPDX relationships", 131072)) {
    const relationship = record(value, "SPDX relationship");
    if (relationship["relationshipType"] !== "CONTAINS") continue;
    const owner = text(relationship["spdxElementId"], "SPDX relationship owner");
    const target = text(relationship["relatedSpdxElement"], "SPDX relationship target");
    if (packages.has(owner) && files.has(target)) { covered.add(target); owners.add(owner); }
  }
  if (covered.size !== files.size || owners.size !== packages.size) return invalid("SBOM coverage requires package ownership for every shipped file and content for every package");
  return [...packages.values()];
}

async function sourceArtifact(directory: string, input: unknown, signal?: AbortSignal): Promise<SourceEvidenceArtifact> {
  const artifact = record(input, "source archive"); exactKeys(artifact, ["path", "sha256"]);
  const file = resolve(directory, text(artifact["path"], "source path"));
  const path = await localBundlePath(dirname(file), basename(file)); const metadata = await lstat(path);
  const sha256 = decodeSHA256(artifact["sha256"], "source archive pin");
  if (metadata.size < 1 || metadata.size > 2 * 1024 ** 3 || await hashFile(path, signal) !== sha256) return invalid("source archive differs from its pin or size bound");
  return { inputPath: path, bytes: metadata.size, sha256 };
}

export async function validateEvidence(directory: string, inputs: EvidenceInputs, inventory: readonly InventoryFile[], signal?: AbortSignal, buildkitSBOM?: Uint8Array<ArrayBuffer>, epoch = 0): Promise<ValidatedEvidence> {
  if (inputs.sbom.kind === "buildkit" && buildkitSBOM === undefined) return invalid("this source did not produce a final-image BuildKit SBOM attestation");
  const paths = [...(inputs.sbom.kind === "file" ? [inputs.sbom.path] : []), inputs.noticesFile, inputs.correspondingSourcesFile, inputs.licensePolicyFile].map(path => resolve(directory, path));
  if (new Set(paths).size !== paths.length) return invalid("distinct SBOM, notices, sources and review files are required");
  const notices = await inputBytes(directory, inputs.noticesFile, signal);
  const sourceBytes = await inputBytes(directory, inputs.correspondingSourcesFile, signal);
  const policy = await inputBytes(directory, inputs.licensePolicyFile, signal);
  const sbom = inputs.sbom.kind === "file" ? await inputBytes(directory, inputs.sbom.path, signal)
    : buildkitSBOM === undefined ? invalid("BuildKit attestation is absent") : normalizeBuildkitSBOM(buildkitSBOM, policy, inventory, epoch);
  return validateEvidenceDocuments(directory, { sbom, notices, sourceBytes, policy }, inventory, signal);
}

/** Revalidate the same documents from a signed installed bundle without writing input files. */
export async function validateEvidenceDocuments(directory: string, documents: {
  readonly sbom: Uint8Array<ArrayBuffer>; readonly notices: Uint8Array<ArrayBuffer>;
  readonly sourceBytes: Uint8Array<ArrayBuffer>; readonly policy: Uint8Array<ArrayBuffer>;
}, inventory: readonly InventoryFile[], signal?: AbortSignal): Promise<ValidatedEvidence> {
  const { sbom, notices, sourceBytes, policy } = documents;
  if (new Set([sbom, notices, sourceBytes, policy].map(bytes => hash(bytes))).size !== 4) return invalid("a repeated placeholder cannot satisfy multiple evidence roles");
  const packages = validateSPDX(decodeBundleJSON(sbom), inventory);
  const noticeDocument = record(decodeBundleJSON(notices), "notices"); exactKeys(noticeDocument, ["schemaVersion", "notices"]);
  const sourceDocument = record(decodeBundleJSON(sourceBytes), "sources"); exactKeys(sourceDocument, ["schemaVersion", "packages"]);
  const review = record(decodeBundleJSON(policy), "license review");
  if (noticeDocument["schemaVersion"] !== 1 || sourceDocument["schemaVersion"] !== 1) return invalid("unsupported evidence document version");
  if (review["schemaVersion"] === 1) {
    exactKeys(review, ["schemaVersion", "reviewer", "approved", "packages"], ["additionalPackages", "fileOwnership"]);
    if (review["approved"] !== true) return invalid("legacy license review must be explicitly approved");
    text(review["reviewer"], "license reviewer");
  } else {
    exactKeys(review, ["schemaVersion", "purpose", "validator", "policySHA256", "packages"]);
    if (review["schemaVersion"] !== 2 || review["purpose"] !== "technical-inventory") return invalid("schema 2 validates technical inventory only; human release approvals are separate");
    text(review["validator"], "inventory validator");
    decodeSHA256(review["policySHA256"], "canonical license policy digest");
  }
  function indexed(value: unknown, label: string): ReadonlyMap<string, Readonly<Record<string, unknown>>> {
    const values = array(value, label).map(item => record(item, label)); const entries = new Map<string, Readonly<Record<string, unknown>>>();
    for (const item of values) { const id = text(item["packageId"], `${label} package ID`); if (entries.has(id)) return invalid(`duplicate ${label} package`); entries.set(id, item); }
    if (entries.size !== packages.length || [...entries.keys()].some(id => !packages.some(item => item.id === id))) return invalid(`${label} package coverage differs from the SBOM`);
    return entries;
  }
  const noticesById = indexed(noticeDocument["notices"], "notices");
  const sourcesById = indexed(sourceDocument["packages"], "sources");
  const reviewById = indexed(review["packages"], "review");
  const sources: ReviewedSource[] = []; const sourceArchives: SourceEvidenceArtifact[] = [];
  for (const item of packages) {
    const notice = noticesById.get(item.id); const source = sourcesById.get(item.id); const decision = reviewById.get(item.id);
    if (notice === undefined || source === undefined || decision === undefined) return invalid("missing license coverage");
    exactKeys(notice, ["packageId", "license", "text"]);
    exactKeys(decision, ["packageId", "license", "noticeSHA256", "obligations"]);
    if (notice["license"] !== item.license || decision["license"] !== item.license || hash(text(notice["text"], "license notice", 2 * 1024 ** 2)) !== decodeSHA256(decision["noticeSHA256"], "reviewed notice digest")) return invalid("license or reviewed notice differs from distributed content");
    const copyleft = /(?:^|[^A-Za-z])(?:GPL|LGPL|AGPL|MPL|EPL)-/u.test(item.license);
    const obligations = decision["obligations"];
    if (copyleft && obligations !== "source" || obligations !== "source" && obligations !== "notice" && obligations !== "explicit-grant") return invalid("license obligations are missing or incompatible with copyleft terms");
    if (obligations === "source") {
      exactKeys(source, ["packageId", "kind", "archive", "buildInstructionsFile"], ["relinkMaterials"]);
      if (source["kind"] !== "source") return invalid("source obligations require complete corresponding sources and build instructions");
      const archive = await sourceArtifact(directory, source["archive"], signal);
      const instructionsPath = text(source["buildInstructionsFile"], "source build instructions");
      const instructionsBytes = await inputBytes(directory, instructionsPath, signal);
      if (instructionsBytes.length < 16) return invalid("source build instructions are empty");
      const buildInstructions = await sourceArtifact(directory, { path: instructionsPath, sha256: hash(instructionsBytes) }, signal);
      const relinkMaterials = source["relinkMaterials"] === undefined ? undefined : await sourceArtifact(directory, source["relinkMaterials"], signal);
      if (/(?:^|[^A-Za-z])LGPL-/u.test(item.license) && relinkMaterials === undefined) return invalid("LGPL review requires retained relink materials");
      sources.push({ packageId: item.id, kind: "source", archive, buildInstructions, ...(relinkMaterials === undefined ? {} : { relinkMaterials }) });
      sourceArchives.push(archive, buildInstructions, ...(relinkMaterials === undefined ? [] : [relinkMaterials]));
    } else {
      exactKeys(source, ["packageId", "kind"]);
      const kind = obligations === "notice" ? "notice-only" : "explicit-grant";
      if (source["kind"] !== kind) return invalid("source record disagrees with reviewed redistribution obligations");
      sources.push({ packageId: item.id, kind });
    }
  }
  return { sbom, notices, policy, sources, sourceArchives, inventorySHA256: hash(JSON.stringify([...inventory].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) };
}
