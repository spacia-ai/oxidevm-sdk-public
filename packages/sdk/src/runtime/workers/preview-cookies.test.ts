import { expect, it } from "vitest";
import { PreviewCookieJar, defaultPath, parseSetCookie, pathMatches, type ClientContext } from "./preview-cookies.js";

const HOST = "0123456789abcdef0123456789abcdef.oxidevm-preview.test";
const TOP: ClientContext = { frame: "top", ancestor: null, navigate: false };
const TOP_NAVIGATION: ClientContext = { frame: "top", ancestor: null, navigate: true };
const EMBEDDED: ClientContext = { frame: "nested", ancestor: "https://oxidevm-ide.test:4473", navigate: false };
const EMBEDDED_NAVIGATION: ClientContext = { frame: "nested", ancestor: "https://oxidevm-ide.test:4473", navigate: true };
const SELF_EMBEDDED: ClientContext = { frame: "nested", ancestor: `https://${HOST}:4573`, navigate: false };
const UNKNOWN_EMBEDDER: ClientContext = { frame: "nested", ancestor: null, navigate: false };

function jar(now = 1_000_000) {
  const clock = { now };
  return { clock, jar: new PreviewCookieJar(HOST, () => clock.now) };
}

it("parses attributes, applies the default path, and rejects foreign domains, insecure None, and broken prefixes", () => {
  const now = 1_000_000;
  expect(parseSetCookie("session=abc; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60", "/api/x", HOST, now))
    .toEqual({ name: "session", value: "abc", path: "/", secure: true, httpOnly: true, sameSite: "strict", expires: now + 60_000 });
  expect(parseSetCookie("a=\"quoted\"", "/api/items/1", HOST, now)).toMatchObject({ value: "quoted", path: "/api/items", sameSite: "lax", secure: false });
  expect(parseSetCookie("a=b; Expires=Wed, 21 Oct 2015 07:28:00 GMT", "/", HOST, now)?.expires).toBe(Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"));
  expect(parseSetCookie("a=b; SameSite=Weird", "/", HOST, now)?.sameSite).toBe("lax");
  expect(parseSetCookie(`a=b; Domain=.${HOST.toUpperCase()}`, "/", HOST, now)).toBeDefined();
  expect(parseSetCookie("escape=bad; Domain=oxidevm-preview.test; Secure; Path=/", "/", HOST, now)).toBeUndefined();
  expect(parseSetCookie("a=b; SameSite=None", "/", HOST, now)).toBeUndefined();
  expect(parseSetCookie("__Secure-a=b", "/", HOST, now)).toBeUndefined();
  expect(parseSetCookie("__Host-a=b; Secure; Path=/api", "/", HOST, now)).toBeUndefined();
  expect(parseSetCookie("__Host-a=b; Secure; Path=/", "/", HOST, now)).toBeDefined();
  expect(parseSetCookie("=b", "/", HOST, now)).toBeUndefined();
  expect(parseSetCookie("bad name=b", "/", HOST, now)).toBeUndefined();
  expect(parseSetCookie(`big=${"x".repeat(4100)}`, "/", HOST, now)).toBeUndefined();
  expect(defaultPath("/")).toBe("/");
  expect(defaultPath("/api")).toBe("/");
  expect(defaultPath("/api/items?x=/y/z")).toBe("/api");
  expect(pathMatches("/api", "/api")).toBe(true);
  expect(pathMatches("/api", "/api/x?y")).toBe(true);
  expect(pathMatches("/api", "/apix")).toBe(false);
  expect(pathMatches("/api/", "/api/x")).toBe(true);
});

it("keeps HttpOnly cookies out of the browser, purges the page's copy, and hands visible cookies over", () => {
  const { jar: cookies } = jar();
  const browser = cookies.receive([
    "secret=server-only; HttpOnly; Secure; SameSite=None; Path=/",
    "visible=server; Secure; SameSite=None; Path=/",
    "scoped=api; Secure; SameSite=None; Path=/api",
    "escape=bad; Domain=oxidevm-preview.test; Secure; Path=/",
  ], "/api/cookies");
  expect(browser).toEqual([
    { name: "secret", value: null, path: "/", sameSite: "none", expires: null },
    { name: "visible", value: "server", path: "/", sameSite: "none", expires: null },
    { name: "scoped", value: "api", path: "/api", sameSite: "none", expires: null },
  ]);
  expect(cookies.size).toBe(1);
  expect(cookies.cookieHeader("/api/cookies", EMBEDDED, "visible=server; secret=forged; scoped=api")).toBe("secret=server-only; visible=server; scoped=api");
  expect(cookies.cookieHeader("/other", TOP, undefined)).toBe("secret=server-only");
});

it("flips custody when a private cookie becomes visible or expires", () => {
  const { clock, jar: cookies } = jar();
  cookies.receive(["token=private; HttpOnly; Secure; Path=/"], "/");
  expect(cookies.receive(["token=public; Secure; Path=/"], "/")).toEqual([{ name: "token", value: "public", path: "/", sameSite: "lax", expires: null }]);
  expect(cookies.size).toBe(0);
  cookies.receive(["token=private; HttpOnly; Secure; Path=/; Max-Age=10"], "/");
  expect(cookies.cookieHeader("/", TOP, undefined)).toBe("token=private");
  clock.now += 10_001;
  expect(cookies.cookieHeader("/", TOP, undefined)).toBeUndefined();
  expect(cookies.size).toBe(0);
  cookies.receive(["token=private; HttpOnly; Secure; Path=/"], "/");
  expect(cookies.receive(["token=; HttpOnly; Max-Age=0; Secure; Path=/"], "/")).toEqual([{ name: "token", value: null, path: "/", sameSite: "lax", expires: null }]);
  expect(cookies.size).toBe(0);
  expect(cookies.receive(["visible=; Max-Age=0; Secure; Path=/"], "/")).toEqual([{ name: "visible", value: null, path: "/", sameSite: "lax", expires: clock.now - 1 }]);
});

it("applies SameSite against the client context and scopes by path", () => {
  const { jar: cookies } = jar();
  cookies.receive([
    "strict=1; HttpOnly; Secure; SameSite=Strict; Path=/",
    "lax=1; HttpOnly; Secure; Path=/",
    "none=1; HttpOnly; Secure; SameSite=None; Path=/",
    "api=1; HttpOnly; Secure; SameSite=None; Path=/api",
  ], "/");
  expect(cookies.cookieHeader("/page", TOP, undefined)).toBe("strict=1; lax=1; none=1");
  expect(cookies.cookieHeader("/page", TOP_NAVIGATION, undefined)).toBe("strict=1; lax=1; none=1");
  expect(cookies.cookieHeader("/page", SELF_EMBEDDED, undefined)).toBe("strict=1; lax=1; none=1");
  expect(cookies.cookieHeader("/page", EMBEDDED, undefined)).toBe("none=1");
  expect(cookies.cookieHeader("/page", EMBEDDED_NAVIGATION, undefined)).toBe("none=1");
  expect(cookies.cookieHeader("/page", UNKNOWN_EMBEDDER, undefined)).toBe("none=1");
  expect(cookies.cookieHeader("/api/items", EMBEDDED, undefined)).toBe("api=1; none=1");
  expect(cookies.cookieHeader("/apix", EMBEDDED, undefined)).toBe("none=1");
});

it("bounds the jar to sixty-four cookies by evicting the oldest", () => {
  const { clock, jar: cookies } = jar();
  for (let index = 0; index < 64; index++) {
    cookies.receive([`c${index}=v; HttpOnly; Secure; Path=/`], "/");
    clock.now += 1;
  }
  expect(cookies.size).toBe(64);
  cookies.receive(["c64=v; HttpOnly; Secure; Path=/"], "/");
  expect(cookies.size).toBe(64);
  expect(cookies.cookieHeader("/", TOP, undefined)?.startsWith("c1=v")).toBe(true);
  expect(cookies.cookieHeader("/", TOP, undefined)?.endsWith("c64=v")).toBe(true);
});

it("accepts the guest's own localhost Domain as host-only and keeps Secure cookies a guest sets over http://localhost", () => {
  // The guest sees Host: localhost:<port> (preview-http-codec), so a Domain it derives from the
  // request names localhost; a browser on localhost stores that cookie and Secure ones too.
  const { jar: cookies } = jar();
  expect(parseSetCookie("a=b; Domain=localhost", "/", HOST, 0)).toMatchObject({ name: "a", value: "b" });
  expect(parseSetCookie("a=b; Domain=.LOCALHOST", "/", HOST, 0)).toBeDefined();
  expect(parseSetCookie("a=b; Domain=127.0.0.1", "/", HOST, 0)).toBeUndefined();
  expect(parseSetCookie("a=b; Domain=example.localhost", "/", HOST, 0)).toBeUndefined();
  expect(cookies.receive(["sid=1; Domain=localhost; Path=/; Secure; HttpOnly; SameSite=None"], "/")).toEqual([{ name: "sid", value: null, path: "/", sameSite: "none", expires: null }]);
  expect(cookies.cookieHeader("/", EMBEDDED, undefined)).toBe("sid=1");
});
