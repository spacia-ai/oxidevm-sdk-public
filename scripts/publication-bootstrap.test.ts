import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { approvedControllerSource } from "./publication-bootstrap.ts";

await test("the protected job binds private code to the approved archive before executing it", () => {
  const source = "a".repeat(40), commit = "b".repeat(40), scope = "c".repeat(64);
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, target: "public", version: "0.0.1", source, exportCommit: commit, legalScopeSHA256: scope }));
  const candidate = createHash("sha256").update(bytes).digest("hex");
  const human = { status: "approved", reviewer: "Human reviewer", reviewedAt: "2026-10-26T00:00:00Z", evidence: "reviews/review.md", sha256: "f".repeat(64) };
  const authorization = { schemaVersion: 1, candidateSHA256: candidate, legalScopeSHA256: scope, ownerApproval: human, legalReview: human };
  const expected = { source, commit, candidate, version: "0.0.1" };
  assert.equal(approvedControllerSource(bytes, authorization, expected), source);
  assert.throws(() => approvedControllerSource(bytes, authorization, { ...expected, source: "d".repeat(40) }), /source/u);
  assert.throws(() => approvedControllerSource(bytes, authorization, { ...expected, commit: "d".repeat(40) }), /source/u);
  assert.throws(() => approvedControllerSource(Buffer.concat([bytes, Buffer.from(" ")]), authorization, expected), /digest/u);
  assert.throws(() => approvedControllerSource(bytes, { ...authorization, candidateSHA256: "d".repeat(64) }, expected), /approval/u);
  assert.throws(() => approvedControllerSource(bytes, { ...authorization, legalReview: { ...human, status: "pending" } }, expected), /pending/u);
  assert.throws(() => approvedControllerSource(bytes, { ...authorization, legalReview: { ...human, reviewer: "Codex" } }, expected), /human/u);
});
