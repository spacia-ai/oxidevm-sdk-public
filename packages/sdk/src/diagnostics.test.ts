import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import * as diagnostics from "./diagnostics.js";
import { integer, record } from "./runtime/decode.js";

it("exports the relay protocol version its relay specification declares, and no other relay constant", async () => {
  // The engine's compatibility check compares this with the engine's own relay specification.
  const spec: unknown = JSON.parse(await readFile(new URL("../../../spec/relay/v2.json", import.meta.url), "utf8"));
  const version = integer(record(record(spec, "relay specification")["constants"], "relay constants")["VERSION"], "relay VERSION", 1, 0xffff);
  expect(diagnostics.RELAY_VERSION).toBe(version);
  expect(Object.keys(diagnostics).filter(name => /^relay/iu.test(name))).toEqual(["RELAY_VERSION"]);
});

it("exposes exactly the advanced values the barrel names, so a new runtime export needs an explicit decision", () => {
  const expected = [
    "MINIMUM_BROWSERS", "RELAY_VERSION", "VMError", "acquireLocalDataLease", "backupFileName", "configureJSProcessTrace",
    "createRuntimeVM", "decodeSystemTraceSnapshot", "describeSnapshotError", "detectBrowserSupport", "engineRelease",
    "engineReleaseId", "eraseLocalData", "getDiagnostics", "instructionIdentities", "isPreviewSessionOrigin",
    "readJSProcessTrace", "requestWorkspaceHandoff", "validateRuntimeVMOptions", "watchAccelerationNotices",
  ];
  expect(Object.keys(diagnostics).sort()).toEqual([...expected].sort());
});
