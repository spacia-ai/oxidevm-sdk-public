import { exactKeys, record, string } from "../runtime/decode.js";

export function releaseDigest(value: unknown, length = 64): string {
  const text = string(value, "release digest");
  if (!new RegExp(`^[a-f0-9]{${String(length)}}$`, "u").test(text)) throw new Error("Invalid release digest");
  return text;
}
export function releasePath(value: unknown): string {
  const text = string(value, "release path");
  if (text.length > 4096 || !/^[A-Za-z0-9_./@+-]+$/u.test(text) || text.startsWith("/") || text.split("/").some(part => ["", ".", "..", ".git", "node_modules"].includes(part))) throw new Error("Invalid or escaping release path");
  return text;
}

/** Shared artifact-bound review boundary for SDK releases, images, and sites. */
export function decodeDistributionAuthorization(value: unknown, expected: { readonly candidateSHA256: string; readonly legalScopeSHA256: string }) {
  const input = record(value, "release authorization"); exactKeys(input, ["schemaVersion", "candidateSHA256", "legalScopeSHA256", "legalReview", "ownerApproval"]);
  if (input["schemaVersion"] !== 1 || input["candidateSHA256"] !== expected.candidateSHA256) throw new Error("Owner approval belongs to another release candidate");
  if (input["legalScopeSHA256"] !== expected.legalScopeSHA256) throw new Error("Legal review belongs to another legal scope");
  function review(name: "legalReview" | "ownerApproval") {
    const item = record(input[name], name); exactKeys(item, ["status", "reviewer", "reviewedAt", "evidence", "sha256"]);
    if (item["status"] !== "approved") throw new Error(`${name} is pending; no external publication is authorized`);
    const reviewer = string(item["reviewer"], "human reviewer"), reviewedAt = string(item["reviewedAt"], "review date");
    if (reviewer.trim().length < 2 || reviewer.length > 256 || /\b(?:codex|claude|gpt|llm|automation|agent|ai)\b/iu.test(reviewer)) throw new Error(`${name} requires a named human reviewer`);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(reviewedAt) || !Number.isFinite(Date.parse(reviewedAt))) throw new Error("Invalid human review date");
    return { reviewer, reviewedAt, evidence: releasePath(item["evidence"]), sha256: releaseDigest(item["sha256"]) };
  }
  return { legalReview: review("legalReview"), ownerApproval: review("ownerApproval") };
}
