import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { PreviewSiteAccess } from "./contracts.js";
import { VMError } from "./runtime/errors.js";
import { decodePreviewSiteAccess, MAX_PREVIEW_SITES, previewSite, sameSiteAccess } from "./preview-site-access.js";

const cases = readCases();

function readCases(): readonly (readonly [string, string | null])[] {
  const parsed: unknown = JSON.parse(readFileSync(new URL("../asset-source/preview/site-cases.json", import.meta.url), "utf8"));
  if (!Array.isArray(parsed)) throw new Error("site-cases.json must be an array");
  const rows: readonly unknown[] = parsed;
  return rows.map((row): readonly [string, string | null] => {
    const input: unknown = Array.isArray(row) ? row[0] : undefined;
    const expected: unknown = Array.isArray(row) ? row[1] : undefined;
    if (typeof input !== "string" || (typeof expected !== "string" && expected !== null)) throw new Error("bad site case");
    return [input, expected];
  });
}

function codeOf(run: () => unknown): string | null {
  try { run(); } catch (error) { return error instanceof VMError ? error.code : "other"; }
  return null;
}

describe("previewSite", () => {
  it("has the whole shared case table", () => {
    expect(cases.length).toBeGreaterThanOrEqual(24);
  });

  it.each(cases)("maps %j to %j", (input, expected) => {
    expect(previewSite(input)).toBe(expected);
  });
});

describe("decodePreviewSiteAccess", () => {
  it("returns the canonical form: normalized, unique, ascending", () => {
    expect(decodePreviewSiteAccess({ kind: "sites", sites: ["b.example", "A.example", "b.example"] }, "INVALID_ARGUMENT"))
      .toEqual({ kind: "sites", sites: ["a.example", "b.example"] });
  });

  it("turns an empty list into none and accepts none and any", () => {
    expect(decodePreviewSiteAccess({ kind: "sites", sites: [] }, "INVALID_ARGUMENT")).toEqual({ kind: "none" });
    expect(decodePreviewSiteAccess({ kind: "none" }, "INVALID_ARGUMENT")).toEqual({ kind: "none" });
    expect(decodePreviewSiteAccess({ kind: "any" }, "INVALID_ARGUMENT")).toEqual({ kind: "any" });
  });

  it("accepts 64 sites and refuses 65", () => {
    const sites = (count: number) => Array.from({ length: count }, (_, index) => `s${index}.example`);
    expect(decodePreviewSiteAccess({ kind: "sites", sites: sites(MAX_PREVIEW_SITES) }, "INVALID_ARGUMENT"))
      .toMatchObject({ kind: "sites" });
    expect(codeOf(() => decodePreviewSiteAccess({ kind: "sites", sites: sites(MAX_PREVIEW_SITES + 1) }, "INVALID_ARGUMENT")))
      .toBe("INVALID_ARGUMENT");
  });

  it.each([
    [{ kind: "none", extra: 1 }], [{ kind: "sites" }], [{ kind: "sites", sites: ["localhost"] }], [{ kind: "sites", sites: [1] }],
    [{ kind: "sites", sites: "a.example" }], [{ kind: "some" }], ["any"], [null], [[]],
  ])("rejects %j", (value) => {
    expect(codeOf(() => decodePreviewSiteAccess(value, "INVALID_ARGUMENT"))).toBe("INVALID_ARGUMENT");
  });

  it("reports the requested error code", () => {
    expect(codeOf(() => decodePreviewSiteAccess({ kind: "none", extra: 1 }, "PROTOCOL_ERROR"))).toBe("PROTOCOL_ERROR");
  });
});

describe("sameSiteAccess", () => {
  const sites: PreviewSiteAccess = { kind: "sites", sites: ["a.example", "b.example"] };
  it("compares kind and sites", () => {
    expect(sameSiteAccess(sites, { kind: "sites", sites: ["a.example", "b.example"] })).toBe(true);
    expect(sameSiteAccess(sites, { kind: "sites", sites: ["a.example"] })).toBe(false);
    expect(sameSiteAccess({ kind: "none" }, { kind: "none" })).toBe(true);
    expect(sameSiteAccess({ kind: "any" }, { kind: "none" })).toBe(false);
    expect(sameSiteAccess(sites, { kind: "any" })).toBe(false);
  });
});
