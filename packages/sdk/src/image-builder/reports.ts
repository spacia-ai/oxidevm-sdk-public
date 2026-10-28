import { boolean, exactKeys, integer, record, string } from "../runtime/decode.js";
import { VMError } from "../runtime/errors.js";
import { decodeSHA256 } from "../values.js";
import type { RuntimeMode } from "../values.js";
import type { EvidenceRequirement, ImageDistribution, ImageInspection, ImageCheckResult, ImageTestCheck, ImageTestReport } from "./contracts.js";

export const IMAGE_TEST_CHECKS: readonly ImageTestCheck[] = ["asset-integrity", "manifest-signature", "browser-features", "runtime-ready", "workspace-read-write", "smoke-command", "terminal-interrupt", "persistence-reopen", "preview", "license-evidence", "reproducible-build"];
const evidenceRequirements: readonly EvidenceRequirement[] = ["sbom", "notices", "corresponding-sources", "license-review", "reproducibility", "browser-tests"];
function choice<T extends string>(value: unknown, values: readonly T[], field: string): T {
  for (const option of values) if (value === option) return option;
  throw new VMError("PROTOCOL_ERROR", `invalid ${field}`);
}
function text(value: unknown, field: string): string {
  const result = string(value, field);
  if (result.length === 0 || result.length > 8192 || Array.from(result).some(char => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)))) throw new VMError("PROTOCOL_ERROR", `invalid ${field}`);
  return result;
}
function mode(value: unknown): RuntimeMode { return choice(value, ["system", "userspace"], "runtime mode"); }

export function decodeImageDistribution(value: unknown): ImageDistribution {
  const input = record(value, "distribution");
  if (input["kind"] === "candidate") {
    exactKeys(input, ["kind", "browserTestsRequired"]);
    if (!boolean(input["browserTestsRequired"], "browser qualification required")) throw new VMError("PROTOCOL_ERROR", "candidate requires browser qualification");
    return { kind: "candidate", browserTestsRequired: true };
  }
  exactKeys(input, ["kind", "missing"]);
  if (input["kind"] !== "development" || !Array.isArray(input["missing"])) throw new VMError("PROTOCOL_ERROR", "invalid development evidence");
  const missing = Array.from<unknown>(input["missing"]).map(item => choice(item, evidenceRequirements, "evidence requirement"));
  if (new Set(missing).size !== missing.length) throw new VMError("PROTOCOL_ERROR", "duplicate missing evidence");
  return { kind: "development", missing };
}

export function decodeImageCheckResult(value: unknown): ImageCheckResult {
  const input = record(value, "image test check");
  const check = choice(input["check"], IMAGE_TEST_CHECKS, "image test check");
  if (input["status"] === "passed") { exactKeys(input, ["check", "status"]); return { check, status: "passed" }; }
  if (input["status"] === "failed") { exactKeys(input, ["check", "status", "message"]); return { check, status: "failed", message: text(input["message"], "failure message") }; }
  exactKeys(input, ["check", "status", "reason"]);
  if (input["status"] !== "not-applicable") throw new VMError("PROTOCOL_ERROR", "invalid check outcome");
  if (!["preview", "terminal-interrupt", "license-evidence", "reproducible-build"].includes(check)) throw new VMError("PROTOCOL_ERROR", "mandatory image check cannot be omitted");
  return { check, status: "not-applicable", reason: choice(input["reason"], ["not-declared", "mode-unsupported"], "check exclusion") };
}

export function decodeImageTestReport(value: unknown): ImageTestReport {
  const input = record(value, "image test report");
  exactKeys(input, ["schemaVersion", "result", "mode", "manifestSHA256", "engineRelease", "sdkVersion", "browser", "checks"]);
  if (input["schemaVersion"] !== 1) throw new VMError("PROTOCOL_ERROR", "unsupported image report schema");
  const browser = record(input["browser"], "browser identity"); exactKeys(browser, ["name", "version"]);
  if (!Array.isArray(input["checks"])) throw new VMError("PROTOCOL_ERROR", "image checks must be an array");
  const checks = Array.from<unknown>(input["checks"]).map(decodeImageCheckResult);
  if (checks.length !== IMAGE_TEST_CHECKS.length || new Set(checks.map(item => item.check)).size !== checks.length) throw new VMError("PROTOCOL_ERROR", "report must contain each required check exactly once");
  const result = choice(input["result"], ["passed", "failed"], "report result");
  if ((result === "failed") !== checks.some(item => item.status === "failed")) throw new VMError("PROTOCOL_ERROR", "report result contradicts check outcomes");
  return { schemaVersion: 1, result, mode: mode(input["mode"]), manifestSHA256: decodeSHA256(input["manifestSHA256"], "manifest digest"), engineRelease: text(input["engineRelease"], "engine release"), sdkVersion: text(input["sdkVersion"], "SDK version"), browser: { name: choice(browser["name"], ["chromium", "firefox", "webkit"], "browser name"), version: text(browser["version"], "browser version") }, checks };
}

export function decodeImageInspection(value: unknown): ImageInspection {
  const input = record(value, "image inspection");
  exactKeys(input, ["mode", "id", "version", "manifestSHA256", "artifactCount", "artifactBytes", "authentication"]);
  const authentication = record(input["authentication"], "image authentication"); exactKeys(authentication, ["kind", "keyId"]);
  return { mode: mode(input["mode"]), id: text(input["id"], "image id"), version: text(input["version"], "image version"), manifestSHA256: decodeSHA256(input["manifestSHA256"], "manifest digest"), artifactCount: integer(input["artifactCount"], "artifact count", 1, 1_000_000), artifactBytes: integer(input["artifactBytes"], "artifact bytes", 0), authentication: { kind: choice(authentication["kind"], ["verified", "unverified"], "authentication kind"), keyId: text(authentication["keyId"], "key id") } };
}
