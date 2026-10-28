import { describe, expect, it } from "vitest";

import { VMError } from "../errors.js";
import { decodePreparedSystemAot } from "./storage.js";
import { decodeSystemAotStatus } from "./system-aot.js";

const OFFLINE_STATUS = {
  kind: "disabled",
  reason: "offline",
  catalogSha256: null,
  indexSha256: null,
  keyId: null,
  signatureVerified: false,
  encounters: 0,
  instantiateMilliseconds: 0,
  packs: [],
};

describe("system AOT status", () => {
  it("says an image prepared offline ran without AOT code, from trace schema 42", () => {
    expect(decodeSystemAotStatus(OFFLINE_STATUS, 42)).toMatchObject({ kind: "disabled", reason: "offline" });
    expect(() => decodeSystemAotStatus(OFFLINE_STATUS, 41)).toThrow(VMError);
    expect(() => decodeSystemAotStatus({ ...OFFLINE_STATUS, reason: "unreachable" }, 42)).toThrow(VMError);
  });

  it("reads an image prepared offline as AOT skipped for that reason", () => {
    expect(decodePreparedSystemAot({ kind: "skipped", reason: "offline" })).toEqual({ kind: "skipped", reason: "offline" });
  });
});
