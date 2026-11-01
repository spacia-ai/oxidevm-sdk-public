import { expect, it } from "vitest";
import { decodeCliReport } from "./report.js";
it("decodes correlated commands, bounded results and exact error envelopes", () => {
  const value = { schemaVersion: 2, kind: "result", command: "init", result: { directory: "/tmp/example", mode: "userspace", assets: "skipped" } };
  expect(decodeCliReport(value)).toEqual(value);
  expect(() => decodeCliReport({ ...value, command: "image init" })).toThrow();
  expect(() => decodeCliReport({ ...value, schemaVersion: 1 })).toThrow();
  expect(() => decodeCliReport({ ...value, result: { ...value.result, extra: true } })).toThrow();
  const error = { schemaVersion: 2, kind: "error", command: null, error: { code: "INVALID_ARGUMENT", message: "missing --mode" } };
  expect(decodeCliReport(error)).toEqual(error);
  expect(() => decodeCliReport({ ...error, error: { code: "PRIVATE_KEY", message: "bad" } })).toThrow();
});

const SHA = "c".repeat(64);
const BUILT = { result: "built", id: "tool", version: "1.0.0", release: SHA, directory: "dist", files: [{ name: "module.json", sha256: SHA, bytes: 5 }], bundled: [], findings: [] };
const FAILED = { result: "failed", id: null, version: null, release: null, directory: null, files: [], bundled: [], findings: [{ severity: "error", code: "module-source", message: "x" }] };
const envelope = (command: string, result: unknown): unknown => ({ schemaVersion: 2, kind: "result", command, result });

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

  const init = { directory: "/tmp/tool", id: "tool", kind: "service", abi: "raw", files: ["module.ts", "package.json"] };
  expect(decodeCliReport(envelope("wasm init", init))).toEqual(envelope("wasm init", init));
  for (const bad of [{ ...init, extra: 1 }, { ...init, kind: "daemon" }, { ...init, files: [] }, { ...init, files: Array.from({ length: 65 }, (_, index) => `f${String(index)}`) }, { ...init, files: "module.ts" }, { ...init, id: "" }]) {
    expect(() => decodeCliReport(envelope("wasm init", bad))).toThrow();
  }
});

it("decodes the commands a scaffolded command module declares, none included, and refuses them for a service or out of bounds", () => {
  const scaffold = { directory: "/tmp/tool", id: "tool", kind: "command", abi: "raw", files: ["module.ts", "src/command.ts"], commands: ["tool"] };
  expect(decodeCliReport(envelope("wasm init", scaffold))).toEqual(envelope("wasm init", scaffold));
  // An id that starts with the reserved prefix declares no command.
  const reserved = { ...scaffold, id: "oxidevm-tools", commands: [] };
  expect(decodeCliReport(envelope("wasm init", reserved))).toEqual(envelope("wasm init", reserved));
  for (const bad of [
    { ...scaffold, kind: "service" }, { ...scaffold, commands: "tool" }, { ...scaffold, commands: [""] }, { ...scaffold, commands: [7] }, { ...scaffold, commands: null },
    { ...scaffold, commands: Array.from({ length: 17 }, (_, index) => `tool-${String(index)}`) },
  ]) expect(() => decodeCliReport(envelope("wasm init", bad))).toThrow();
});
