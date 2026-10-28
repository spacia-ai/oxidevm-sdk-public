import { exactKeys, integer, record, string } from "./runtime/decode.js";
import { VMError } from "./runtime/errors.js";
import { decodeSHA256 } from "./values.js";
import { engineCompliance, engineReleaseId } from "./engine.generated.js";

export interface EngineCompliancePin { readonly url: string; readonly bytes: number; readonly sha256: string }
const names = ["RUNTIME-LICENSE.txt", "THIRD_PARTY_NOTICES.txt", "sbom.cdx.json", "license-policy.json"] as const;
export interface ComplianceFile { readonly name: (typeof names)[number]; readonly bytes: number; readonly sha256: string }

export function pinnedEngineCompliance(): EngineCompliancePin | null {
  return engineCompliance === null ? null : decodeEngineCompliancePin(engineCompliance, engineReleaseId);
}

/** A compliance revision is independent of the engine payload and cannot replace its files. */
export function decodeEngineCompliancePin(value: unknown, engineRelease: string): EngineCompliancePin {
  const input = record(value, "engine compliance pin"); exactKeys(input, ["url", "bytes", "sha256"]);
  const sha256 = decodeSHA256(input["sha256"], "engine compliance digest"), url = string(input["url"], "engine compliance URL");
  decodeSHA256(engineRelease, "engine release");
  if (url !== `https://cdn.oxidevm.dev/engine/${engineRelease}/compliance/${sha256}/compliance.json`) throw new VMError("PROTOCOL_ERROR", "engine compliance URL differs from its pinned engine or revision");
  return { url, bytes: integer(input["bytes"], "compliance manifest size", 1, 1024 ** 2), sha256 };
}

export function decodeEngineComplianceManifest(value: unknown, engineRelease: string): { readonly engineRelease: string; readonly files: readonly ComplianceFile[] } {
  const input = record(value, "engine compliance manifest"); exactKeys(input, ["schemaVersion", "engineRelease", "files"]);
  if (input["schemaVersion"] !== 1 || input["engineRelease"] !== engineRelease || !Array.isArray(input["files"]) || input["files"].length !== names.length) throw new VMError("PROTOCOL_ERROR", "compliance manifest differs from the engine or required file set");
  const files = Array.from<unknown>(input["files"]).map(value => {
    const file = record(value, "engine compliance file"); exactKeys(file, ["name", "bytes", "sha256"]);
    const name = names.find(name => name === file["name"]);
    if (name === undefined) throw new VMError("PROTOCOL_ERROR", "unknown or escaping engine compliance filename");
    return { name, bytes: integer(file["bytes"], "compliance file size", 1, 16 * 1024 ** 2), sha256: decodeSHA256(file["sha256"], "compliance file digest") };
  });
  if (new Set(files.map(file => file.name)).size !== names.length) throw new VMError("PROTOCOL_ERROR", "duplicate engine compliance file");
  return { engineRelease, files };
}

export function decodeEngineComplianceBytes(bytes: Uint8Array, engineRelease: string) {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new VMError("PROTOCOL_ERROR", "engine compliance manifest is not valid JSON"); }
  return decodeEngineComplianceManifest(value, engineRelease);
}
