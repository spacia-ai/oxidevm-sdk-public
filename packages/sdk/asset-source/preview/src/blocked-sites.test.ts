import { describe, expect, it } from "vitest";

import { blockedDirective, blockedSiteReporter, MAX_REPORTED_SITES, type BlockedSiteMessage } from "./blocked-sites";

const SELF = "https://0123456789abcdef0123456789abcdef.oxvm.dev";

function reporter(): { readonly report: ReturnType<typeof blockedSiteReporter>; readonly posted: BlockedSiteMessage[] } {
  const posted: BlockedSiteMessage[] = [];
  return { report: blockedSiteReporter(SELF, (message) => { posted.push(message); }), posted };
}

describe("blockedSiteReporter", () => {
  it("reports each blocked site once per document", () => {
    const { report, posted } = reporter();
    report({ blockedURI: "https://api.open-meteo.com/a", effectiveDirective: "connect-src" });
    report({ blockedURI: "https://api.open-meteo.com/b", effectiveDirective: "connect-src" });
    expect(posted).toEqual([{ type: "oxidevm-preview-blocked-site", version: 1, site: "api.open-meteo.com", directive: "connect" }]);
  });

  it("ignores same-origin, inline, eval, data, blob, http and ws violations", () => {
    const { report, posted } = reporter();
    for (const blockedURI of [`${SELF}/x`, "inline", "eval", "data", "blob", "http://x.example.com/a", "ws://x.example.com/a", "data:text/plain,a", "blob:https://x.example.com/id"]) {
      report({ blockedURI, effectiveDirective: "connect-src" });
    }
    expect(posted).toEqual([]);
  });

  it("stops after 32 sites", () => {
    const { report, posted } = reporter();
    for (let index = 0; index < MAX_REPORTED_SITES + 5; index += 1) {
      report({ blockedURI: `https://site${index}.example.com/`, effectiveDirective: "img-src" });
    }
    expect(posted).toHaveLength(MAX_REPORTED_SITES);
  });

  it("ignores directives outside the closed set", () => {
    const { report, posted } = reporter();
    report({ blockedURI: "https://x.example.com/", effectiveDirective: "base-uri" });
    report({ blockedURI: "https://x.example.com/", effectiveDirective: "form-action" });
    expect(posted).toEqual([]);
  });
});

describe("blockedDirective", () => {
  it.each([
    ["connect-src", "connect"], ["script-src", "script"], ["script-src-elem", "script"], ["style-src", "style"],
    ["style-src-elem", "style"], ["img-src", "image"], ["font-src", "font"], ["media-src", "media"],
    ["frame-src", "frame"], ["child-src", "frame"], ["worker-src", null],
  ] as const)("maps %s to %s", (directive, expected) => {
    expect(blockedDirective(directive)).toBe(expected);
  });
});
