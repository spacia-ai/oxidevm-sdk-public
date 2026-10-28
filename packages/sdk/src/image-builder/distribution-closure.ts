import type { ReadImageBundle } from "./bundle.js";
import { artifactRelativePath, decodeBundleJSON, readBundleFile, verifyBundleArtifact } from "./bundle-files.js";
import { exactKeys, integer, record, string } from "../runtime/decode.js";
import { decodeSHA256 } from "../values.js";
import { VMError } from "../runtime/errors.js";
import type { InventoryFile } from "./evidence.js";
import { hash } from "./files.js";
import { payloadIdentity } from "./inventory.js";

export interface DistributionArtifact { readonly url: URL; readonly bytes: number; readonly sha256: string }
export interface DistributionClosure {
  readonly artifacts: readonly DistributionArtifact[];
  readonly inventory: readonly InventoryFile[];
  readonly sourceDocument: Uint8Array<ArrayBuffer>;
  readonly policy: DistributionArtifact;
}
function array(value: unknown, label: string, limit: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new VMError("PROTOCOL_ERROR", `invalid ${label}`);
  return Array.from<unknown>(value);
}

/** Only signed references may expand the closure. Author input paths never survive. */
export async function readDistributionClosure(read: ReadImageBundle, signal?: AbortSignal): Promise<DistributionClosure | undefined> {
  const provenance = read.manifest.provenance;
  if (provenance === undefined) throw new VMError("PROTOCOL_ERROR", "distribution provenance is absent");
  await verifyBundleArtifact(read.bundle, read.base, provenance.reproducibility, signal);
  const proof = record(decodeBundleJSON(await readBundleFile(read.bundle, artifactRelativePath(read.base, provenance.reproducibility.url), Math.min(provenance.reproducibility.bytes, 16 * 1024 ** 2), signal)), "reproduction proof");
  if (proof["status"] !== "verified") return undefined;
  exactKeys(proof, ["schemaVersion", "role", "status", "smokeTest", "distribution", "inventory", "inventorySHA256", "sourceIdentity", "sourceDateEpoch", "payloadSHA256", "runs"], ["buildInputs"]);
  if (proof["schemaVersion"] !== 1 || proof["role"] !== "reproducibility") throw new VMError("PROTOCOL_ERROR", "invalid reproduction proof version");
  const payload = decodeSHA256(proof["payloadSHA256"], "reproduced payload");
  const identity = string(proof["sourceIdentity"], "reproduced source identity");
  integer(proof["sourceDateEpoch"], "build epoch", 0, 0xffff_ffff);
  if (payload !== payloadIdentity(record(read.manifestValue, "manifest payload"))) throw new VMError("PROTOCOL_ERROR", "reproduction proof differs from the signed payload");
  const runs = array(proof["runs"], "independent builds", 2);
  if (runs.length !== 2) throw new VMError("PROTOCOL_ERROR", "two independent build receipts are required");
  for (const value of runs) { const run = record(value, "build receipt"); exactKeys(run, ["payloadSHA256", "sourceIdentity"]); if (run["payloadSHA256"] !== payload || run["sourceIdentity"] !== identity) throw new VMError("PROTOCOL_ERROR", "independent build receipt differs"); }
  function artifact(value: unknown): DistributionArtifact {
    const source = record(value, "distribution artifact"); exactKeys(source, ["url", "bytes", "sha256"]);
    const result = { url: new URL(string(source["url"], "artifact URL"), read.base), bytes: integer(source["bytes"], "artifact bytes", 1, 2 * 1024 ** 3), sha256: decodeSHA256(source["sha256"], "artifact digest") };
    artifactRelativePath(read.base, result.url); return result;
  }
  const inventoryArtifact = artifact(proof["inventory"]);
  await verifyBundleArtifact(read.bundle, read.base, inventoryArtifact, signal);
  const inventoryDocument = record(decodeBundleJSON(await readBundleFile(read.bundle, artifactRelativePath(read.base, inventoryArtifact.url), 16 * 1024 ** 2, signal)), "final inventory");
  exactKeys(inventoryDocument, ["schemaVersion", "files"]);
  if (inventoryDocument["schemaVersion"] !== 1) throw new VMError("PROTOCOL_ERROR", "invalid final inventory version");
  const paths = new Set<string>();
  const inventory = array(inventoryDocument["files"], "inventory files", 131072).map(value => {
    const file = record(value, "inventory file"); exactKeys(file, ["path", "bytes", "sha256"]);
    const path = string(file["path"], "inventory path");
    if (path.length === 0 || path.length > 4096 || path.includes("\0") || path.startsWith("/") || path.split("/").includes("..") || paths.has(path)) throw new VMError("PROTOCOL_ERROR", "invalid inventory path");
    paths.add(path);
    return { path, bytes: integer(file["bytes"], "inventory size", 0, 64 * 1024 ** 3), sha256: decodeSHA256(file["sha256"], "inventory digest") };
  });
  const sorted = [...inventory].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (hash(JSON.stringify(sorted)) !== decodeSHA256(proof["inventorySHA256"], "reviewed inventory digest")) throw new VMError("PROTOCOL_ERROR", "reviewed inventory differs from reproduction");
  const sources = record(decodeBundleJSON(await readBundleFile(read.bundle, artifactRelativePath(read.base, provenance.correspondingSources.url), Math.min(provenance.correspondingSources.bytes, 16 * 1024 ** 2), signal)), "corresponding sources");
  exactKeys(sources, ["schemaVersion", "licensePolicy", "packages"]);
  if (sources["schemaVersion"] !== 1) throw new VMError("PROTOCOL_ERROR", "invalid corresponding sources version");
  const policy = artifact(sources["licensePolicy"]); const artifacts = [inventoryArtifact, policy]; const packages = [];
  for (const value of array(sources["packages"], "source packages", 65536)) {
    const source = record(value, "source package"); const packageId = string(source["packageId"], "package ID");
    if (source["kind"] === "source") {
      exactKeys(source, ["packageId", "kind", "archive", "buildInstructions"], ["relinkMaterials"]);
      const archive = artifact(source["archive"]); const instructions = artifact(source["buildInstructions"]);
      const relink = source["relinkMaterials"] === undefined ? undefined : artifact(source["relinkMaterials"]);
      artifacts.push(archive, instructions, ...(relink === undefined ? [] : [relink]));
      const input = (item: DistributionArtifact) => ({ path: artifactRelativePath(read.base, item.url), sha256: item.sha256 });
      packages.push({ packageId, kind: "source", archive: input(archive), buildInstructionsFile: artifactRelativePath(read.base, instructions.url), ...(relink === undefined ? {} : { relinkMaterials: input(relink) }) });
    } else {
      exactKeys(source, ["packageId", "kind"]);
      if (source["kind"] !== "notice-only" && source["kind"] !== "explicit-grant") throw new VMError("PROTOCOL_ERROR", "invalid corresponding source obligations");
      packages.push({ packageId, kind: source["kind"] });
    }
  }
  return { artifacts, inventory, policy, sourceDocument: new Uint8Array(Buffer.from(JSON.stringify({ schemaVersion: 1, packages }))) };
}
