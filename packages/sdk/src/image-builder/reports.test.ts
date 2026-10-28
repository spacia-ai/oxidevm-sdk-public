import { expect, it } from "vitest";
import { decodeImageTestReport, decodeImageInspection } from "./reports.js";

const checks = ["asset-integrity", "manifest-signature", "browser-features", "runtime-ready", "workspace-read-write", "smoke-command", "terminal-interrupt", "persistence-reopen", "preview", "license-evidence", "reproducible-build"];
function report(): unknown {
  return { schemaVersion: 1, result: "passed", mode: "userspace", manifestSHA256: "a".repeat(64), engineRelease: "candidate-1", sdkVersion: "0.1.0-alpha.0", browser: { name: "chromium", version: "149" }, checks: checks.map(check => ({ check, status: "passed" })) };
}
it("decodes a complete report and rejects missing, duplicate and falsely passed checks", () => {
  expect(decodeImageTestReport(report()).checks).toHaveLength(11);
  for (const checks of [[], [{ check: "runtime-ready", status: "passed" }], [ ...Array.from({ length: 11 }, () => ({ check: "runtime-ready", status: "passed" })) ]]) {
    expect(() => decodeImageTestReport({ schemaVersion: 1, result: "passed", mode: "system", manifestSHA256: "a".repeat(64), engineRelease: "1", sdkVersion: "1", browser: { name: "chromium", version: "149" }, checks })).toThrow();
  }
  const input = report();
  if (typeof input !== "object" || input === null) throw new Error("fixture");
  expect(() => decodeImageTestReport({ ...input, checks: checks.map(check => ({ check, status: "failed", message: "failure" })) })).toThrow();
  expect(() => decodeImageTestReport({ ...input, secret: "extra" })).toThrow();
});
it("never infers authentication for a read-only inspection", () => {
  const input = { mode: "system", id: "custom", version: "1", manifestSHA256: "0".repeat(64), artifactCount: 1, artifactBytes: 8, authentication: { kind: "unverified", keyId: "author" } };
  expect(decodeImageInspection(input).authentication.kind).toBe("unverified");
  expect(() => decodeImageInspection({ ...input, authentication: { kind: "trusted", keyId: "author" } })).toThrow();
  expect(() => decodeImageInspection({ ...input, artifactBytes: -1 })).toThrow();
});
