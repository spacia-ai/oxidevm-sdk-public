import { decodeImageSmokeTest } from "../image-smoke.js";
import { integer, record, string } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";
import { artifactRelativePath, decodeBundleJSON, readBundleFile, verifyBundleArtifact } from "./bundle-files.js";
import type { ReadImageBundle } from "./bundle.js";
import { decodeBuildInputFacts } from "./bundle-inputs.js";
import { decodeImageDistribution } from "./reports.js";

/** A lock locates the signed image; it cannot change the author's smoke command or build claims. */
export async function verifyProvenanceLock(read: ReadImageBundle, lock: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<void> {
  const provenance = read.manifest.provenance;
  if (provenance === undefined) throw new VMError("PROTOCOL_ERROR", "image build provenance is absent");
  await verifyBundleArtifact(read.bundle, read.base, provenance.reproducibility, signal);
  const proof = record(decodeBundleJSON(await readBundleFile(read.bundle, artifactRelativePath(read.base, provenance.reproducibility.url), Math.min(provenance.reproducibility.bytes, 16 * 1024 ** 2), signal)), "signed image build proof");
  if (proof["schemaVersion"] !== 1 || proof["role"] !== "reproducibility" || proof["status"] !== "verified" && proof["status"] !== "missing") throw new VMError("PROTOCOL_ERROR", "invalid signed image build proof");
  const smoke = decodeImageSmokeTest(proof["smokeTest"]);
  const distribution = decodeImageDistribution(proof["distribution"]);
  const identity = string(proof["sourceIdentity"], "signed source identity");
  if (identity.length === 0 || identity.length > 8192 || identity.includes("\0")) throw new VMError("PROTOCOL_ERROR", "invalid signed source identity");
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  if (!equal(smoke, decodeImageSmokeTest(lock["smokeTest"])) || !equal(distribution, decodeImageDistribution(lock["distribution"])) || identity !== lock["sourceIdentity"]
    || (proof["status"] === "verified") !== (distribution.kind === "candidate")) throw new VMError("PROTOCOL_ERROR", "image lock differs from its signed build evidence");
  if (proof["sourceDateEpoch"] !== undefined && (integer(proof["sourceDateEpoch"], "signed build epoch", 0, 0xffff_ffff) !== read.manifest.sourceDateEpoch || proof["sourceDateEpoch"] !== lock["sourceDateEpoch"])) throw new VMError("PROTOCOL_ERROR", "image lock differs from its signed build epoch");
  // Legacy signed bundles omit these facts on both sides. A new lock cannot add or remove them.
  if (proof["buildInputs"] !== undefined || lock["buildInputs"] !== undefined) {
    if (!equal(decodeBuildInputFacts(proof["buildInputs"]), decodeBuildInputFacts(lock["buildInputs"]))) throw new VMError("PROTOCOL_ERROR", "image lock differs from its signed build inputs");
  }
}
