import { describe, expect, it } from "vitest";
import { decodeWasmPropertyResult, decodeWasmTestReport, MAX_MESSAGE_LENGTH, WASM_TEST_PROPERTIES } from "./report.js";

const passedAll = WASM_TEST_PROPERTIES.map(property => ({ property, status: "passed", elapsedMs: 1 }));
const report = (overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  schemaVersion: 1, result: "passed", module: { id: "kv", version: "1.0.0", kind: "service", release: "abc" }, sdkVersion: "0.0.8", engineRelease: "sha256:e",
  browser: { name: "chromium", version: "140" }, image: { manifestSHA256: "d" }, properties: passedAll, ...overrides,
});

describe("wasm test reports", () => {
  it("decodes a complete report", () => {
    expect(decodeWasmTestReport(report()).properties).toHaveLength(WASM_TEST_PROPERTIES.length);
  });

  it("rejects unknown keys, unknown properties, missing or reordered properties and an inconsistent result", () => {
    expect(() => decodeWasmTestReport(report({ extra: 1 }))).toThrow("unexpected protocol field extra");
    expect(() => decodeWasmTestReport(report({ properties: [...passedAll.slice(0, -1), { property: "telemetry", status: "passed", elapsedMs: 1 }] }))).toThrow("property must be one of");
    expect(() => decodeWasmTestReport(report({ properties: passedAll.slice(1) }))).toThrow("must list all");
    expect(() => decodeWasmTestReport(report({ properties: [...passedAll].reverse() }))).toThrow("out of order");
    expect(() => decodeWasmTestReport(report({ result: "failed" }))).toThrow("disagrees");
  });

  it("requires a message for anything but a pass and bounds its length", () => {
    expect(() => decodeWasmPropertyResult({ property: "ready", status: "failed", elapsedMs: 1 })).toThrow("needs a message");
    expect(() => decodeWasmPropertyResult({ property: "ready", status: "failed", message: "x".repeat(MAX_MESSAGE_LENGTH + 1), elapsedMs: 1 })).toThrow("longer than");
    expect(decodeWasmPropertyResult({ property: "ready", status: "not-applicable", message: "a command", elapsedMs: 0 })).toEqual({ property: "ready", status: "not-applicable", message: "a command", elapsedMs: 0 });
  });
});
