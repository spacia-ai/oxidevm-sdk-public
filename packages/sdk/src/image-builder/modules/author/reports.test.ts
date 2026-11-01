import { describe, expect, it } from "vitest";
import { VMError } from "../../../runtime/errors.js";
import type { BuildResult } from "./build.js";
import { MAX_FINDING_MESSAGE, finding } from "./findings.js";
import { decodeWasmBuildResult } from "./reports.js";

const SHA = "a".repeat(64);
const FILES = [{ name: "SHA256SUMS", sha256: SHA, bytes: 10 }, { name: "adapter.mjs", sha256: SHA, bytes: 20 }, { name: "module.json", sha256: SHA, bytes: 30 }];
const BUILT: BuildResult = { result: "built", id: "demo", version: "1.0.0", release: SHA, directory: "/work/dist", files: FILES, bundled: [{ name: "lib", version: "1.0.0", license: "MIT" }], findings: [finding("warning", "adapter-global", "window does not exist", { file: "src/a.ts", line: 3, column: 9 })] };
const FAILED: BuildResult = { result: "failed", id: null, version: null, release: null, directory: null, files: [], bundled: [], findings: [finding("error", "manifest-literal", "bad")] };
const roundTrip = (value: unknown): BuildResult => decodeWasmBuildResult(JSON.parse(JSON.stringify(value)) as unknown);

describe("decodeWasmBuildResult", () => {
  it("round-trips every outcome through JSON", () => {
    expect(roundTrip(BUILT)).toEqual(BUILT);
    expect(roundTrip({ ...BUILT, result: "checked", directory: null })).toEqual({ ...BUILT, result: "checked", directory: null });
    expect(roundTrip(FAILED)).toEqual(FAILED);
    expect(roundTrip({ ...FAILED, id: "demo", version: "1.0.0", bundled: BUILT.bundled })).toMatchObject({ id: "demo" });
  });

  it("keeps a finding's location optional, exactly", () => {
    const bare = { ...BUILT, findings: [finding("warning", "notices-missing", "x")] };
    expect(roundTrip(bare).findings[0]).toEqual({ severity: "warning", code: "notices-missing", message: "x" });
  });

  it.each([
    ["an unknown top-level key", { ...BUILT, extra: 1 }],
    ["a missing key", Object.fromEntries(Object.entries(BUILT).filter(([key]) => key !== "bundled"))],
    ["an unknown result", { ...BUILT, result: "partial" }],
    ["an unknown finding code", { ...BUILT, findings: [{ severity: "warning", code: "other", message: "x" }] }],
    ["an unknown finding severity", { ...BUILT, findings: [{ severity: "info", code: "adapter-meta", message: "x" }] }],
    ["an extra finding key", { ...BUILT, findings: [{ severity: "warning", code: "adapter-meta", message: "x", extra: 1 }] }],
    ["a zero line", { ...BUILT, findings: [{ severity: "warning", code: "adapter-meta", message: "x", line: 0 }] }],
    ["an over-long message", { ...BUILT, findings: [{ severity: "warning", code: "adapter-meta", message: "x".repeat(MAX_FINDING_MESSAGE + 1) }] }],
    ["a bad release digest", { ...BUILT, release: "xyz" }],
    ["a duplicated file", { ...BUILT, files: [FILES[0], FILES[0]] }],
    ["an extra file key", { ...BUILT, files: [{ ...FILES[0], extra: 1 }] }],
    ["a negative file size", { ...BUILT, files: [{ ...FILES[0], bytes: -1 }] }],
    ["too many findings", { ...BUILT, findings: Array.from({ length: 513 }, () => finding("warning", "adapter-meta", "x")) }],
    ["a bundled package with an extra key", { ...BUILT, bundled: [{ name: "a", version: "1", license: "MIT", extra: 1 }] }],
    ["a non-array findings", { ...BUILT, findings: "none" }],
    ["a failed build that has a release", { ...FAILED, release: SHA }],
    ["a failed build that has files", { ...FAILED, files: FILES }],
    ["a failed build that wrote a directory", { ...FAILED, directory: "/work/dist" }],
    ["a failed build with no error", { ...FAILED, findings: [finding("warning", "adapter-meta", "x")] }],
    ["a built result with an error", { ...BUILT, findings: [finding("error", "adapter-import", "x")] }],
    ["a built result with no release", { ...BUILT, release: null }],
    ["a built result with no files", { ...BUILT, files: [] }],
    ["a built result that names no directory", { ...BUILT, directory: null }],
    ["a checked result that names a directory", { ...BUILT, result: "checked" }],
  ])("rejects %s", (_label, value) => {
    expect(() => roundTrip(value)).toThrow(VMError);
  });

  it("reports a rejection as an invalid manifest-style argument with a stable reason", () => {
    try { roundTrip({ ...BUILT, extra: 1 }); } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-manifest-invalid" } });
      return;
    }
    throw new Error("expected a rejection");
  });
});

describe("finding", () => {
  it("cuts a message that is too long and marks the cut", () => {
    const long = finding("error", "adapter-bundle", "y".repeat(MAX_FINDING_MESSAGE + 500));
    expect(long.message).toHaveLength(MAX_FINDING_MESSAGE);
    expect(long.message.endsWith("...")).toBe(true);
    expect(finding("error", "adapter-bundle", "y".repeat(MAX_FINDING_MESSAGE)).message).toHaveLength(MAX_FINDING_MESSAGE);
  });

  it("carries the location it is given", () => {
    expect(finding("warning", "adapter-meta", "m", { file: "f.ts", line: 2, column: 3 })).toEqual({ severity: "warning", code: "adapter-meta", message: "m", file: "f.ts", line: 2, column: 3 });
  });
});
