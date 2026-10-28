import { fileURLToPath, pathToFileURL } from "node:url";
import { posix } from "node:path";
import { expect, it } from "vitest";
import { createNodeUrl } from "./node-url.js";

it("matches POSIX file URL encoding for separators, controls and trailing slashes", () => {
  const url = createNodeUrl(() => "/workspace/app");
  for (const path of ["", ".", "..", "/", "//host/a", "a/", "a//", "a/../", "a b", "a%20b", "a#b?c", "a\\b", "a:b", "a\n\r\tb", "\0\x01\x1f", "雪/😀", "\ud800",
    ...Array.from({ length: 128 }, (_, index) => String.fromCharCode(index)).flatMap(character => [`a${character}`, `a${character}/x`])]) {
    const resolved = posix.resolve("/workspace/app", path) + (path.endsWith("/") && posix.resolve("/workspace/app", path) !== "/" ? "/" : "");
    expect(url.pathToFileURL(path).href, JSON.stringify(path)).toBe(pathToFileURL(resolved).href);
    expect(url.fileURLToPath(url.pathToFileURL(path))).toBe(fileURLToPath(pathToFileURL(resolved)));
  }
  expect(url.URL).toBe(URL);
  expect(url.URLSearchParams).toBe(URLSearchParams);
});

it("validates POSIX file URLs and preserves the native path decoding errors", () => {
  const url = createNodeUrl(() => "/");
  for (const value of ["file:///a%20b", "file://localhost/a", "file:///a%5Cb", "file:///a?ignored#ignored", "file:///a%2Fb", "file://remote/a", "https://host/a", "invalid", "file:///%xx", "file:///%ff"]) {
    let expected: unknown;
    try { expected = fileURLToPath(value); }
    catch (error) { expected = error; }
    if (expected instanceof Error) {
      let actual: unknown;
      try { url.fileURLToPath(value); }
      catch (error) { actual = error; }
      expect(actual).toBeInstanceOf(expected.constructor);
      if ("code" in expected) expect(actual).toHaveProperty("code", expected.code);
    } else expect(url.fileURLToPath(value)).toBe(expected);
  }
  expect(() => url.pathToFileURL(42)).toThrow(TypeError);
  expect(() => url.fileURLToPath({ href: "file:///a" })).toThrow(TypeError);
  expect(() => url.pathToFileURL("a", { windows: true })).toThrow("Windows");
});

it("url.format renders a WHATWG URL with Node's option toggles and a legacy url object", () => {
  const url = createNodeUrl(() => "/workspace");
  const parsed = new URL("https://user:pw@example.com:8443/p/a?q=1#frag");
  expect(url.format(parsed)).toBe("https://user:pw@example.com:8443/p/a?q=1#frag");
  expect(url.format(parsed, { auth: false, fragment: false, search: false })).toBe("https://example.com:8443/p/a");
  expect(url.format({ protocol: "http:", hostname: "localhost", port: 3000, pathname: "/x", search: "?a=b", hash: "#h" })).toBe("http://localhost:3000/x?a=b#h");
  expect(url.format("http://already/")).toBe("http://already/");
});
