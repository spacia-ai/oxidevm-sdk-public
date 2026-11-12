import { describe, expect, it } from "vitest";

import type { SiteAccess } from "../site-access";
import { cookieRefusalHeader, disconnectedPage, frameAncestors, movedPage, isParentOrigin, pageContentSecurityPolicy, startingPage, unavailableResponse, upstreamFailedResponse, upstreamFailure, upstreamLateResponse, unsupportedRequestBodyResponse } from "./policy";

const NONE: SiteAccess = { kind: "none" };

function directives(policy: string): Map<string, string> {
  return new Map(policy.split(";").map((part) => part.trim()).map((part) => [part.split(" ")[0] ?? "", part]));
}

const SITE_DIRECTIVES = ["default-src", "script-src", "style-src", "img-src", "font-src", "connect-src"];

describe("preview page content security policy", () => {
  it("allows only the same origin to connect when no site is granted", () => {
    const policy = pageContentSecurityPolicy(null, NONE);
    expect(directives(policy).get("connect-src")).toBe("connect-src 'self'");
    expect(policy).not.toMatch(/\bwss?:/);
  });
  it("appends granted sites to the six fetch directives only", () => {
    const parsed = directives(pageContentSecurityPolicy("https://p.example", { kind: "sites", sites: ["api.open-meteo.com"] }));
    for (const name of SITE_DIRECTIVES) expect(parsed.get(name)).toMatch(/ https:\/\/api\.open-meteo\.com wss:\/\/api\.open-meteo\.com$/);
    expect(parsed.get("worker-src")).toBe("worker-src 'self' blob:");
    expect(parsed.get("frame-ancestors")).toBe("frame-ancestors 'self' https://p.example");
  });
  it("allows any https and wss site, never http or ws", () => {
    const parsed = directives(pageContentSecurityPolicy(null, { kind: "any" }));
    for (const name of SITE_DIRECTIVES) {
      expect(parsed.get(name)).toMatch(/ https: wss:$/);
      expect(parsed.get(name)).not.toMatch(/ (http|ws):/);
    }
    expect(parsed.get("frame-ancestors")).toBe("frame-ancestors 'none'");
  });
});

describe("preview worker policy", () => {
  it("explicitly refuses unsupported uploads while retaining preview isolation", () => {
    const response = unsupportedRequestBodyResponse("https://p.example");
    expect(response.status).toBe(501);
    expect(response.headers.get("x-oxidevm-preview-error")).toBe("request-body-unsupported");
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self' https://p.example");
  });
  it("lets only the session's parent frame proxied pages", () => {
    expect(pageContentSecurityPolicy("http://127.0.0.1:4173", NONE)).toContain("frame-ancestors 'self' http://127.0.0.1:4173;");
    expect(pageContentSecurityPolicy("https://playground.example", NONE)).not.toContain("oxidevm-ide.test");
    expect(pageContentSecurityPolicy(null, NONE)).toContain("frame-ancestors 'none'");
    expect(frameAncestors(null)).toBe("'none'");
  });

  it("gives the worker's own 502 and 503 answers the parent's frame-ancestors", () => {
    const unavailable = unavailableResponse("session", "https://p.example");
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'self' https://p.example");
    expect(unavailable.headers.get("x-oxidevm-preview-error")).toBe("session");
    const failed = upstreamFailedResponse("open:listener", "https://p.example");
    expect(failed.status).toBe(502);
    expect(failed.headers.get("content-security-policy")).toContain("frame-ancestors 'self' https://p.example");
    expect(failed.headers.get("x-oxidevm-preview-error")).toBe("open:listener");
    expect(failed.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(upstreamFailedResponse(undefined, null).headers.get("x-oxidevm-preview-error")).toBeNull();
  });

  it("counts cookies the browser refused in a response header, and only when there are some", () => {
    expect(cookieRefusalHeader(0)).toEqual({});
    expect(cookieRefusalHeader(2)).toEqual({ "X-OxideVM-Preview-Cookies-Refused": "2" });
  });

  it("tells a page of a replaced shared session where it went", async () => {
    const page = movedPage("https://fedora.tail133191.ts.net");
    expect(page.status).toBe(503);
    expect(page.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self' https://fedora.tail133191.ts.net");
    expect(page.headers.get("x-oxidevm-preview-error")).toBe("moved");
    expect(await page.text()).toContain("This preview moved to a newer session.");
    const moved = unavailableResponse("moved", null);
    expect(moved.status).toBe(503);
    expect(moved.headers.get("x-oxidevm-preview-error")).toBe("moved");
  });

  it("tells a page whose app has not answered yet that it tries again, without script", async () => {
    const page = startingPage("https://p.example");
    expect(page.status).toBe(503);
    expect(page.headers.get("retry-after")).toBe("2");
    expect(page.headers.get("x-oxidevm-preview-error")).toBe("starting");
    expect(page.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self' https://p.example");
    const text = await page.text();
    expect(text).toContain('<meta http-equiv="refresh" content="2">');
    expect(text).toContain("The app is still starting.");
    expect(text).toContain("This page tries again in a moment.");
    expect(text).not.toContain("<script");
  });

  it("answers a page that found nothing listening on its port with a page that tries again", async () => {
    // A typed address opens before the server listens (an image without listening-port reports).
    const page = upstreamFailure("open:listener", true, "https://p.example");
    expect(page.status).toBe(503);
    expect(page.headers.get("retry-after")).toBe("2");
    expect(page.headers.get("x-oxidevm-preview-error")).toBe("open:listener");
    expect(page.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self' https://p.example");
    const text = await page.text();
    expect(text).toContain('<meta http-equiv="refresh" content="2">');
    expect(text).toContain("Nothing is running on this port yet.");
    expect(text).toContain("This page tries again in a moment.");
    expect(text).not.toContain("<script");
  });

  it("keeps the 502 for other requests and for other failures", () => {
    for (const [phase, navigate] of [["open:listener", false], ["open:channel", true], ["response-read:read", true], [undefined, true]] as const) {
      const failed = upstreamFailure(phase, navigate, "https://p.example");
      expect(failed.status).toBe(502);
      expect(failed.headers.get("x-oxidevm-preview-error")).toBe(phase ?? null);
    }
  });

  it("answers other requests whose app has not answered yet with 504", () => {
    const late = upstreamLateResponse("https://p.example");
    expect(late.status).toBe(504);
    expect(late.headers.get("x-oxidevm-preview-error")).toBe("late");
    expect(late.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'self' https://p.example");
  });

  it("tells a page whose Playground is gone how to come back", async () => {
    const page = disconnectedPage("https://p.example");
    expect(page.status).toBe(503);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self' https://p.example");
    expect(page.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    const text = await page.text();
    expect(text).toContain("This preview is no longer connected.");
    expect(text).toContain("Open it again from the Playground.");
  });

  it.each([
    ["https://p.example", true],
    ["http://localhost:5173", true],
    ["http://127.0.0.1:4173", true],
    ["http://10.0.0.2:5173", false],
    ["https://p.example/", false],
    ["https://p.example/x", false],
    ["https://user@p.example", false],
    ["not a url", false],
    [42, false],
  ])("isParentOrigin(%s) is %s", (value, expected) => {
    expect(isParentOrigin(value)).toBe(expected);
  });
});
