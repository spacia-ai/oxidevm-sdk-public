import { expect, it } from "vitest";
import { decodeCliReport } from "./report.js";
it("decodes correlated commands, bounded results and exact error envelopes", () => {
  const value = { schemaVersion: 3, kind: "result", command: "init", result: { directory: "/tmp/example", mode: "userspace", assets: "skipped" } };
  expect(decodeCliReport(value)).toEqual(value);
  expect(() => decodeCliReport({ ...value, command: "image init" })).toThrow();
  expect(() => decodeCliReport({ ...value, schemaVersion: 1 })).toThrow();
  expect(() => decodeCliReport({ ...value, result: { ...value.result, extra: true } })).toThrow();
  const error = { schemaVersion: 3, kind: "error", command: null, error: { code: "INVALID_ARGUMENT", message: "missing --mode" } };
  expect(decodeCliReport(error)).toEqual(error);
  expect(() => decodeCliReport({ ...error, error: { code: "PRIVATE_KEY", message: "bad" } })).toThrow();
});

const SHA = "c".repeat(64);
const BUILT = { result: "built", id: "tool", version: "1.0.0", release: SHA, directory: "dist", files: [{ name: "module.json", sha256: SHA, bytes: 5 }], bundled: [], findings: [] };
const FAILED = { result: "failed", id: null, version: null, release: null, directory: null, files: [], bundled: [], findings: [{ severity: "error", code: "module-source", message: "x" }] };
const envelope = (command: string, result: unknown): unknown => ({ schemaVersion: 3, kind: "result", command, result });

it("decodes the module authoring reports and rejects every inconsistent shape", () => {
  expect(decodeCliReport(envelope("wasm build", BUILT))).toEqual(envelope("wasm build", BUILT));
  expect(decodeCliReport(envelope("wasm build", FAILED))).toEqual(envelope("wasm build", FAILED));
  expect(() => decodeCliReport(envelope("wasm build", { ...BUILT, release: null }))).toThrow();

  const plan = { build: BUILT, tag: "v1.0.0", steps: ["1. tag it"] };
  expect(decodeCliReport(envelope("wasm release", plan))).toEqual(envelope("wasm release", plan));
  expect(decodeCliReport(envelope("wasm release", { build: FAILED, tag: null, steps: [] }))).toMatchObject({ command: "wasm release" });
  for (const bad of [
    { ...plan, extra: true }, { ...plan, tag: null }, { ...plan, steps: [] }, { build: FAILED, tag: "v1.0.0", steps: ["x"] }, { build: FAILED, tag: null, steps: ["x"] },
    { build: BUILT, tag: "v1.0.0", steps: Array.from({ length: 33 }, () => "x") }, { ...plan, steps: "none" }, { ...plan, build: { ...BUILT, extra: 1 } },
  ]) expect(() => decodeCliReport(envelope("wasm release", bad))).toThrow();

  const init = { directory: "/tmp/tool", id: "tool", kind: "service", abi: "raw", network: "vm", files: ["module.ts", "package.json"] };
  expect(decodeCliReport(envelope("wasm init", init))).toEqual(envelope("wasm init", init));
  for (const bad of [{ ...init, extra: 1 }, { ...init, kind: "daemon" }, { ...init, files: [] }, { ...init, files: Array.from({ length: 65 }, (_, index) => `f${String(index)}`) }, { ...init, files: "module.ts" }, { ...init, id: "" }]) {
    expect(() => decodeCliReport(envelope("wasm init", bad))).toThrow();
  }
});

it("decodes the commands a scaffolded command module declares, none included, and refuses them for a service or out of bounds", () => {
  const scaffold = { directory: "/tmp/tool", id: "tool", kind: "command", abi: "raw", network: "none", files: ["module.ts", "src/command.ts"], commands: ["tool"] };
  expect(decodeCliReport(envelope("wasm init", scaffold))).toEqual(envelope("wasm init", scaffold));
  // An id that starts with the reserved prefix declares no command.
  const reserved = { ...scaffold, id: "oxidevm-tools", commands: [] };
  expect(decodeCliReport(envelope("wasm init", reserved))).toEqual(envelope("wasm init", reserved));
  for (const bad of [
    { ...scaffold, kind: "service" }, { ...scaffold, commands: "tool" }, { ...scaffold, commands: [""] }, { ...scaffold, commands: [7] }, { ...scaffold, commands: null },
    { ...scaffold, commands: Array.from({ length: 17 }, (_, index) => `tool-${String(index)}`) },
  ]) expect(() => decodeCliReport(envelope("wasm init", bad))).toThrow();
});

const LOCKED = { sdkVersion: "0.0.8", engineRelease: `sha256:${"e".repeat(64)}`, manifestSHA256: "b".repeat(64) };
const INSTALLED = { sdkVersion: "0.0.9", engineRelease: `sha256:${"f".repeat(64)}`, manifestSHA256: "b".repeat(64) };
const ASSETS = { publicDir: "/tmp/app/public", files: 12, referencePath: null };

it("reads schema 3: assets install reports its lock change, and schema 2 reports are refused", () => {
  for (const lock of [{ updated: true, from: LOCKED, to: INSTALLED }, { updated: true, to: INSTALLED }, { updated: false, to: INSTALLED }]) {
    expect(decodeCliReport(envelope("assets install", { ...ASSETS, lock }))).toEqual(envelope("assets install", { ...ASSETS, lock }));
  }
  for (const lock of [
    undefined, { updated: false, from: LOCKED, to: INSTALLED }, { updated: "yes", to: INSTALLED }, { updated: true }, { updated: true, to: INSTALLED, extra: 1 },
    { updated: true, to: { ...INSTALLED, extra: 1 } }, { updated: true, to: { ...INSTALLED, engineRelease: "f".repeat(64) } }, { updated: true, to: { ...INSTALLED, manifestSHA256: "B".repeat(64) } },
    { updated: true, to: { ...INSTALLED, sdkVersion: "" } }, { updated: true, to: { ...INSTALLED, sdkVersion: "0.0.9\u001b[2J" } },
  ]) expect(() => decodeCliReport(envelope("assets install", lock === undefined ? ASSETS : { ...ASSETS, lock }))).toThrow();
  // Reports from an earlier CLI are a different schema, not a damaged schema 3 report.
  for (const old of [{ schemaVersion: 2, kind: "result", command: "assets install", result: ASSETS }, { schemaVersion: 2, kind: "error", command: null, error: { code: "INVALID_ARGUMENT", message: "x" } }]) {
    expect(() => decodeCliReport(old)).toThrow("unsupported CLI report schema");
  }
});

it("reads the doctor's closed lock check", () => {
  const browser = ["secure-context", "cross-origin-isolation", "wasm-features", "worker-load", "asset-integrity", "wasm-mime", "content-security-policy", "storage"].map(check => ({ check, status: "passed" }));
  const preview = { check: "preview-origin", status: "not-configured" };
  const stale = { check: "lock", status: "failed", message: "project lock oxidevm.lock.json does not match the installed SDK release" };
  const hosting = { kind: "self-hosted", assets: "http://localhost:5173/oxidevm/" };
  for (const lock of [{ check: "lock", status: "passed" }, { check: "lock", status: "not-configured" }]) {
    const report = { result: "passed", url: "http://localhost:5173/", hosting, checks: [...browser, preview, lock] };
    expect(decodeCliReport(envelope("doctor", report))).toEqual(envelope("doctor", report));
  }
  const failed = { result: "failed", url: "http://localhost:5173/", hosting, checks: [...browser, preview, stale] };
  expect(decodeCliReport(envelope("doctor", failed))).toEqual(envelope("doctor", failed));
  for (const checks of [[...browser, preview], [...browser, preview, { check: "lock", status: "skipped" }], [...browser, preview, stale, stale]]) {
    expect(() => decodeCliReport(envelope("doctor", { result: "failed", url: "http://localhost:5173/", hosting, checks }))).toThrow();
  }
});

it("reads a frame-hosted doctor report and refuses one that does not name its runtime", () => {
  const owned = new Set(["worker-load", "storage"]);
  const checks = ["secure-context", "cross-origin-isolation", "wasm-features", "worker-load", "asset-integrity", "wasm-mime", "content-security-policy", "storage"].map(check => owned.has(check) ? { check, status: "not-applicable" } : { check, status: "passed" });
  const report = { result: "passed", url: "https://app.example/", hosting: { kind: "frame", frame: "https://run.oxidevm.dev/v/0.0.15/" }, checks: [...checks, { check: "preview-origin", status: "not-configured" }, { check: "lock", status: "passed" }] };
  expect(decodeCliReport(envelope("doctor", report))).toEqual(envelope("doctor", report));
  expect(() => decodeCliReport(envelope("doctor", { result: report.result, url: report.url, checks: report.checks }))).toThrow();
  expect(() => decodeCliReport(envelope("doctor", { ...report, hosting: { kind: "self-hosted", assets: "https://app.example/oxidevm/" } }))).toThrow();
});
