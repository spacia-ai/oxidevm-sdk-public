// Which requests the runtime frame's offline shell serves (ADR 0021): GETs for its own versioned scope, except the
// module frame directory (ADR 0028), whose responses must keep the server's own headers (sandbox CSP, CORP cross-origin)
// and whose code the runtime frame reads once per VM anyway.
export function handledByShell(url: URL, method: string, scope: URL): boolean {
  return method === "GET" && url.origin === scope.origin && url.pathname.startsWith(scope.pathname)
    && !url.pathname.startsWith(new URL("module-frame/", scope).pathname);
}
