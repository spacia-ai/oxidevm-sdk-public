import { describe, expect, it } from "vitest";
import { VMError } from "../../runtime/errors.js";
import { decodeWasmAddResult, decodeWasmDoctorReport, decodeWasmInspectResult, decodeWasmStageResult } from "./reports.js";

const sha = "a".repeat(64);
const add = { id: "tool", version: "1.0.0", source: "github:acme/tool@v1", release: sha, status: "added", consent: "approved", license: { spdx: "MIT", copyleft: false }, capabilities: ["files.sync"], added: ["host:files.sync"], removed: [], generatedFile: "src/oxidevm.modules.generated.ts" };
const stage = { modules: [{ id: "tool", release: sha, rebuilt: true }], vendored: ["tool"], removed: [], generatedFile: "src/oxidevm.modules.generated.ts" };
const checks = ["declaration", "lock", "vendored", "staged", "generated", "engine-api", "license", "commands", "hosting"];
const doctor = { result: "passed", modules: ["tool"], checks: checks.map(check => ({ check, status: "passed" })) };
const inspect = { file: "a.wasm", kind: "module", bytes: 8, imports: [{ module: "env", names: 2 }], exports: ["run"], customSections: [], memories: [{ minPages: 1, maxPages: null, shared: false, memory64: false }], abi: "raw", evidence: ["x"], targetFeatures: false };

function rejects(decode: (value: unknown) => unknown, valid: object, mutations: readonly (readonly [string, Record<string, unknown>])[]): void {
  expect(() => decode(valid)).not.toThrow();
  for (const [label, change] of mutations) expect(() => decode({ ...valid, ...change }), label).toThrow(VMError);
  expect(() => decode({ ...valid, extra: 1 }), "extra key").toThrow(VMError);
  expect(() => decode(null), "null").toThrow(VMError);
}

describe("wasm command results", () => {
  it("decode only exact add results", () => {
    rejects(decodeWasmAddResult, add, [["status", { status: "gone" }], ["consent", { consent: "yes" }], ["release digest", { release: "abc" }], ["license shape", { license: { spdx: "MIT" } }], ["capabilities", { capabilities: "files.sync" }]]);
  });
  it("decode the commands a module declares in an add result, and keep the shape of a module without commands", () => {
    const decoded = decodeWasmAddResult({ ...add, commands: ["python", "python3"] });
    expect(decoded.commands).toEqual(["python", "python3"]);
    expect(Object.keys(decoded)).toEqual(["id", "version", "source", "release", "status", "consent", "license", "capabilities", "commands", "added", "removed", "generatedFile"]);
    expect(Object.keys(decodeWasmAddResult(add))).toEqual(["id", "version", "source", "release", "status", "consent", "license", "capabilities", "added", "removed", "generatedFile"]);
    for (const commands of [[], ["Python"], ["oxidevm-x"], "python", [1], ["a", "a"], Array.from({ length: 17 }, (_, index) => `c${String(index)}`)]) {
      expect(() => decodeWasmAddResult({ ...add, commands }), JSON.stringify(commands)).toThrow(VMError);
    }
  });
  it("decode only exact stage results", () => {
    rejects(decodeWasmStageResult, stage, [["module shape", { modules: [{ id: "tool" }] }], ["rebuilt", { modules: [{ id: "tool", release: sha, rebuilt: "yes" }] }], ["vendored", { vendored: [1] }]]);
  });
  it("decode only complete, consistent doctor reports", () => {
    rejects(decodeWasmDoctorReport, doctor, [["missing check", { checks: doctor.checks.slice(1) }], ["repeated check", { checks: [...doctor.checks.slice(1), doctor.checks[1]] }], ["contradiction", { result: "failed" }], ["bad status", { checks: doctor.checks.map(entry => ({ ...entry, status: "maybe" })) }]]);
    const failing = { result: "failed", modules: [], checks: checks.map(check => check === "lock" ? { check, status: "failed", message: "bad" } : { check, status: "passed" }) };
    expect(decodeWasmDoctorReport(failing).result).toBe("failed");
    expect(() => decodeWasmDoctorReport({ ...failing, checks: failing.checks.map(entry => entry.check === "lock" ? { check: "lock", status: "failed" } : entry) })).toThrow(VMError);
  });
  it("decode only exact inspect results", () => {
    rejects(decodeWasmInspectResult, inspect, [["abi", { abi: "java" }], ["kind", { kind: "other" }], ["memory", { memories: [{ minPages: 1 }] }], ["negative size", { bytes: -1 }]]);
  });
});
