import { describe, expect, it } from "vitest";

import { decodeSystemTraceSchemaVersion, SYSTEM_TRACE_SCHEMA_VERSION } from "./system-trace-schema.js";

describe("system trace schema versions", () => {
  it("accepts the advertised current schema and every retained historical version", () => {
    for (let version = 2; version <= SYSTEM_TRACE_SCHEMA_VERSION; version += 1) {
      expect(decodeSystemTraceSchemaVersion(version)).toBe(version);
    }
  });

  it("rejects future, malformed and pre-schema trace identities", () => {
    for (const version of [SYSTEM_TRACE_SCHEMA_VERSION + 1, 1, 47.5, "48", null]) {
      expect(() => decodeSystemTraceSchemaVersion(version)).toThrow();
    }
  });
});
