import { record, string } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";
import { decodeSHA256 } from "../values.js";
import { decodeBundleJSON } from "./bundle-files.js";
import { hash } from "./files.js";
import type { InventoryFile } from "./evidence.js";

function invalid(message: string): never { throw new VMError("INVALID_ARGUMENT", `BuildKit SBOM: ${message}`); }
function rows(value: unknown, label: string): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.length > 131072) return invalid(`${label} exceeds its list bound`);
  return Array.from<unknown>(value).map(item => record(item, label));
}
function text(value: unknown, label: string): string {
  const result = string(value, label);
  if (result.length < 1 || result.length > 8192 || result.includes("\0")) return invalid(`${label} is invalid`);
  return result;
}

/** Scanner conclusions and additional file ownership come only from the author's approved review. */
export function normalizeBuildkitSBOM(scanBytes: Uint8Array, policyBytes: Uint8Array, inventory: readonly InventoryFile[], epoch: number): Uint8Array<ArrayBuffer> {
  const scan = record(decodeBundleJSON(scanBytes), "BuildKit SPDX");
  const review = record(decodeBundleJSON(policyBytes), "license review");
  if (scan["spdxVersion"] !== "SPDX-2.3" || scan["dataLicense"] !== "CC0-1.0" || scan["SPDXID"] !== "SPDXRef-DOCUMENT") return invalid("scanner did not supply SPDX 2.3");
  if (review["schemaVersion"] !== 1 || review["approved"] !== true) return invalid("an explicitly approved review is required");
  text(review["reviewer"], "reviewer");
  const conclusions = new Map<string, string>();
  for (const item of rows(review["packages"], "review packages")) {
    const id = text(item["packageId"], "review package ID"); const license = text(item["license"], "review license");
    if (conclusions.has(id) || license === "NOASSERTION" || license === "NONE") return invalid("duplicate or unresolved review conclusions");
    conclusions.set(id, license);
  }
  const packages = new Map<string, Readonly<Record<string, unknown>>>();
  const scanned = rows(scan["packages"], "scanner packages");
  const extra = review["additionalPackages"] === undefined ? [] : rows(review["additionalPackages"], "additional authored packages");
  for (const item of [...scanned, ...extra]) {
    const id = text(item["SPDXID"], "package SPDXID");
    // Syft's directory container describes the document, not an installed package.
    if (id.startsWith("SPDXRef-DocumentRoot-") && item["versionInfo"] === undefined) continue;
    const license = conclusions.get(id);
    if (license === undefined || packages.has(id)) return invalid("each installed package requires one explicit review");
    text(item["name"], "package name"); text(item["versionInfo"], "package version");
    packages.set(id, { ...item, licenseConcluded: license });
  }
  const expected = new Map(inventory.map(file => [file.path, file]));
  const ownership = new Map<string, string>(); const explicit = new Map<string, string>();
  for (const item of review["fileOwnership"] === undefined ? [] : rows(review["fileOwnership"], "reviewed file ownership")) {
    const path = text(item["path"], "reviewed file path"); const id = text(item["packageId"], "reviewed owner");
    if (!packages.has(id) || explicit.has(path) || decodeSHA256(item["sha256"], "reviewed file digest") !== expected.get(path)?.sha256) return invalid("reviewed file ownership differs from the exact final bytes");
    explicit.set(path, id);
  }
  const scannedPaths = new Map<string, string>(); const seen = new Set<string>();
  for (const item of rows(scan["files"] === undefined ? [] : scan["files"], "scanner files")) {
    const path = text(item["fileName"], "scanner file path").replace(/^(?:\.\/|\/)/u, "");
    const id = text(item["SPDXID"], "scanner file ID");
    if (seen.has(id)) return invalid("duplicate scanner file ID"); seen.add(id);
    const checksums = rows(item["checksums"], "scanner checksums").filter(item => item["algorithm"] === "SHA256");
    const checksum = checksums[0]; const file = expected.get(path);
    if (file === undefined || checksum === undefined || checksums.length !== 1) return invalid("scanner file coverage differs from the final filesystem");
    if (decodeSHA256(checksum["checksumValue"], "scanner checksum") !== file.sha256 && !explicit.has(path)) return invalid("scanner file bytes changed without explicit final ownership review");
    scannedPaths.set(id, path);
  }
  for (const item of rows(scan["relationships"] === undefined ? [] : scan["relationships"], "scanner relationships")) {
    if (item["relationshipType"] !== "CONTAINS") continue;
    const owner = text(item["spdxElementId"], "scanner owner"); const path = scannedPaths.get(text(item["relatedSpdxElement"], "scanner target"));
    if (path === undefined || !packages.has(owner) || explicit.has(path)) continue;
    const previous = ownership.get(path);
    if (previous !== undefined && previous !== owner) return invalid("ambiguous scanner ownership requires explicit review");
    ownership.set(path, owner);
  }
  for (const [path, owner] of explicit) ownership.set(path, owner);
  const files = [...inventory].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => {
    if (!ownership.has(file.path)) return invalid("final file coverage requires explicit review for scanner omissions and injected boot files");
    return { SPDXID: `SPDXRef-File-${hash(file.path)}`, fileName: file.path, checksums: [{ algorithm: "SHA256", checksumValue: file.sha256 }] };
  });
  const creators = rows(scan["creationInfo"] === undefined ? [] : [scan["creationInfo"]], "scanner creation info")[0]?.["creators"];
  const originalCreators = Array.isArray(creators) ? Array.from<unknown>(creators).map(value => text(value, "scanner creator")) : [];
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > 253402300799) return invalid("source epoch exceeds the SPDX timestamp range");
  return new TextEncoder().encode(JSON.stringify({ spdxVersion: "SPDX-2.3", SPDXID: "SPDXRef-DOCUMENT", dataLicense: "CC0-1.0", name: "oxidevm-final-image",
    documentNamespace: `https://oxidevm.dev/spdx/${hash(JSON.stringify(inventory))}`, creationInfo: { creators: [...originalCreators, "Tool: oxidevm-sdk-0.1.0-alpha.0"], created: new Date(epoch * 1000).toISOString() },
    packages: [...packages.values()], files, relationships: files.map(file => ({ spdxElementId: ownership.get(file.fileName), relationshipType: "CONTAINS", relatedSpdxElement: file.SPDXID })) }));
}
