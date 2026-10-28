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
