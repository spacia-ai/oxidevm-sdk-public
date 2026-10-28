import { describe, expect, it } from "vitest";
import { createNodeUrl } from "./node-url.js";

/** Real Node 24's output for the module audit's url case (see
 * tests/fixtures/assistance/module-cases.ts). */
const reference: unknown = JSON.parse(`{"parsed":[{"input":"/api/items?x=1&y=2#frag","protocol":null,"slashes":null,"auth":null,"host":null,"port":null,"hostname":null,"hash":"#frag","search":"?x=1&y=2","query":{"x":"1","y":"2"},"pathname":"/api/items","path":"/api/items?x=1&y=2","href":"/api/items?x=1&y=2#frag","format":"/api/items?x=1&y=2#frag"},{"input":"https://user:pw@example.com:8443/p/a?q=1#h","protocol":"https:","slashes":true,"auth":"user:pw","host":"example.com:8443","port":"8443","hostname":"example.com","hash":"#h","search":"?q=1","query":{"q":"1"},"pathname":"/p/a","path":"/p/a?q=1","href":"https://user:pw@example.com:8443/p/a?q=1#h","format":"https://user:pw@example.com:8443/p/a?q=1#h"},{"input":"//cdn.example.com/lib.js","protocol":null,"slashes":null,"auth":null,"host":null,"port":null,"hostname":null,"hash":null,"search":null,"query":{},"pathname":"//cdn.example.com/lib.js","path":"//cdn.example.com/lib.js","href":"//cdn.example.com/lib.js","format":"//cdn.example.com/lib.js"},{"input":"relative/path?k=v","protocol":null,"slashes":null,"auth":null,"host":null,"port":null,"hostname":null,"hash":null,"search":"?k=v","query":{"k":"v"},"pathname":"relative/path","path":"relative/path?k=v","href":"relative/path?k=v","format":"relative/path?k=v"},{"input":"http://localhost:3000","protocol":"http:","slashes":true,"auth":null,"host":"localhost:3000","port":"3000","hostname":"localhost","hash":null,"search":null,"query":{},"pathname":"/","path":"/","href":"http://localhost:3000/","format":"http://localhost:3000/"},{"input":"/?only=query","protocol":null,"slashes":null,"auth":null,"host":null,"port":null,"hostname":null,"hash":null,"search":"?only=query","query":{"only":"query"},"pathname":"/","path":"/?only=query","href":"/?only=query","format":"/?only=query"},{"input":"","protocol":null,"slashes":null,"auth":null,"host":null,"port":null,"hostname":null,"hash":null,"search":null,"query":{},"pathname":null,"path":null,"href":"","format":""},{"input":"?just=query","protocol":null,"slashes":null,"auth":null,"host":null,"port":null,"hostname":null,"hash":null,"search":"?just=query","query":{"just":"query"},"pathname":null,"path":"?just=query","href":"?just=query","format":"?just=query"},{"input":"http://[::1]:8080/v6","protocol":"http:","slashes":true,"auth":null,"host":"[::1]:8080","port":"8080","hostname":"::1","hash":null,"search":null,"query":{},"pathname":"/v6","path":"/v6","href":"http://[::1]:8080/v6","format":"http://[::1]:8080/v6"}],"resolved":["/one/two/four","http://example.com/one","http://example.com/two","http://example.com/c","/a/b?q=1","http://example.com/a?x=1#h"]}`);

describe("legacy url parse, format and resolve", () => {
  it("matches real Node field for field on path, absolute, protocol-relative, relative, empty and IPv6 inputs", () => {
    const url = createNodeUrl(() => "/workspace/app");
    const inputs = ["/api/items?x=1&y=2#frag", "https://user:pw@example.com:8443/p/a?q=1#h", "//cdn.example.com/lib.js", "relative/path?k=v", "http://localhost:3000", "/?only=query", "", "?just=query", "http://[::1]:8080/v6"];
    const parsed = inputs.map(input => { const p = url.parse(input, true); return { input, protocol: p.protocol, slashes: p.slashes, auth: p.auth, host: p.host, port: p.port, hostname: p.hostname, hash: p.hash, search: p.search, query: p.query, pathname: p.pathname, path: p.path, href: p.href, format: url.format(p) }; });
    const resolved = [["/one/two/three", "four"], ["http://example.com/", "/one"], ["http://example.com/one", "/two"], ["http://example.com/a/b", "../c"], ["/a/b", "?q=1"], ["http://example.com/a?x=1", "#h"]].map(([from, to]) => url.resolve(from ?? "", to ?? ""));
    expect(JSON.parse(JSON.stringify({ parsed, resolved }))).toEqual(reference);
  });
  it("keeps Node's quirks: string format re-parses, query strings stay strings without parseQueryString, hosts lower-case, unsafe path characters escape", () => {
    const url = createNodeUrl(() => "/");
    expect(url.parse("HTTP://Example.COM/A?b=c").href).toBe("http://example.com/A?b=c");
    expect(url.parse("http://x/a?b=c").query).toBe("b=c");
    expect(url.parse("/a b<c").pathname).toBe("/a%20b%3Cc");
    expect(url.format("HTTP://Example.COM/x")).toBe("http://example.com/x");
    expect(url.resolve("http://example.com/a/b/", "c/d")).toBe("http://example.com/a/b/c/d");
    expect(url.resolve("http://example.com/a", "//other.org/z")).toBe("http://other.org/z");
    expect(url.resolve("http://example.com/a", "mailto:x@y")).toBe("mailto:x@y");
    expect(url.resolve("/a/b/c", "../../d")).toBe("/d");
    expect(url.resolve("a/b", "../../../c")).toBe("../../c");
    expect(url.parse("http://a@b@c/").auth).toBe("a@b");
    expect(url.parse("http://a@b@c/").host).toBe("c");
    expect(url.parse("http://x:y:80/").href).toBe("http://x:80/:y/");
    expect(() => url.parse(1)).toThrow(/must be of type string/u);
  });
});
