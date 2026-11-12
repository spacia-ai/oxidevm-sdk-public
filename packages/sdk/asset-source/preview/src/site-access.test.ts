import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { canonicalSite, decodeSiteAccess, reportedSite, siteSources } from "./site-access";

const cases = readCases();

function readCases(): readonly (readonly [string, string | null])[] {
  const parsed: unknown = JSON.parse(readFileSync(new URL("../site-cases.json", import.meta.url), "utf8"));
  if (!Array.isArray(parsed)) throw new Error("site-cases.json must be an array");
  const rows: readonly unknown[] = parsed;
  return rows.map((row): readonly [string, string | null] => {
    const input: unknown = Array.isArray(row) ? row[0] : undefined;
    const expected: unknown = Array.isArray(row) ? row[1] : undefined;
    if (typeof input !== "string" || (typeof expected !== "string" && expected !== null)) throw new Error("bad site case");
    return [input, expected];
  });
}

describe("canonicalSite", () => {
  it("has the whole shared case table", () => {
    expect(cases.length).toBeGreaterThanOrEqual(24);
  });

  it.each(cases)("maps %j to %j", (input, expected) => {
    expect(canonicalSite(input)).toBe(expected);
  });
});

describe("decodeSiteAccess", () => {
  it("accepts the three kinds", () => {
    expect(decodeSiteAccess({ kind: "none" })).toEqual({ kind: "none" });
    expect(decodeSiteAccess({ kind: "any" })).toEqual({ kind: "any" });
    expect(decodeSiteAccess({ kind: "sites", sites: ["a.example", "b.example:8443"] }))
      .toEqual({ kind: "sites", sites: ["a.example", "b.example:8443"] });
  });

  it.each([
    [{ kind: "sites", sites: [] }], [{ kind: "sites", sites: ["B.example"] }], [{ kind: "sites", sites: ["b.example", "a.example"] }],
    [{ kind: "sites", sites: ["a.example", "a.example"] }], [{ kind: "sites", sites: ["localhost"] }], [{ kind: "none", x: 1 }],
    [{ kind: "sites", sites: Array.from({ length: 65 }, (_, index) => `s${String(index).padStart(2, "0")}.example`) }],
    [{ kind: "sites" }], [{ kind: "other" }], ["none"], [null], [[]],
  ])("rejects %j", (value) => {
    expect(decodeSiteAccess(value)).toBeNull();
  });
});

describe("siteSources", () => {
  it("lists the CSP sources of an access", () => {
    expect(siteSources({ kind: "none" })).toBe("");
    expect(siteSources({ kind: "sites", sites: ["a.example", "b.example:8443"] }))
      .toBe(" https://a.example wss://a.example https://b.example:8443 wss://b.example:8443");
    expect(siteSources({ kind: "any" })).toBe(" https: wss:");
  });
});

describe("reportedSite", () => {
  it("names the site of a blocked https or wss URL", () => {
    expect(reportedSite("https://api.open-meteo.com/v1?x", "https://s.oxvm.dev")).toBe("api.open-meteo.com");
    expect(reportedSite("wss://rt.example:8443/s", "https://s.oxvm.dev")).toBe("rt.example:8443");
  });

  it.each(["inline", "eval", "data", "blob", "http://x.example", "https://s.oxvm.dev/app.js", "https://localhost/x", "api.example.com"])(
    "ignores %s", (blocked) => {
      expect(reportedSite(blocked, "https://s.oxvm.dev")).toBeNull();
    },
  );
});
