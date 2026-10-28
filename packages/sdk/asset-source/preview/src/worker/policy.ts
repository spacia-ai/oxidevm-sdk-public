// What the preview worker's responses allow: which parent may frame proxied pages
// and the worker's own error pages. The parent is the Playground origin the
// keeper validated and handed over when it attached; with none, nothing may frame.

/** A bare origin a keeper may name as its parent: https, or http on this machine. */
export function isParentOrigin(value: unknown): value is string {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  return (url.protocol === "https:" || localHttp) && url.origin === value;
}

/** The frame-ancestors source list for a parent, or none when no parent is known. */
export function frameAncestors(parent: string | null): string {
  return parent === null ? "'none'" : `'self' ${parent}`;
}

/** Proxied pages: Next's development server needs eval source maps; blob workers
 * and data images belong to the application. Only the parent may frame them. */
export function pageContentSecurityPolicy(parent: string | null): string {
  return "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; "
    + "worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; "
    + `connect-src 'self' ws: wss:; frame-ancestors ${frameAncestors(parent)}; base-uri 'none'`;
}

/** The session cannot serve: retired, replaced on the shared address, or no transport. */
export function unavailableResponse(reason: "retired" | "moved" | "session", parent: string | null): Response {
  const text = reason === "retired" ? "Preview session retired" : reason === "moved" ? "Preview session moved" : "Preview session unavailable";
  return new Response(text, {
    status: 503,
    headers: {
      ...workerPageHeaders(parent),
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": "2",
      "X-OxideVM-Preview-Error": reason,
    },
  });
}

/** The guest's server could not answer; `phase` names where it failed. */
export function upstreamFailedResponse(phase: string | undefined, parent: string | null): Response {
  return new Response("Preview upstream failed", {
    status: 502,
    headers: {
      ...workerPageHeaders(parent),
      "Content-Type": "text/plain; charset=utf-8",
      ...(phase === undefined ? {} : { "X-OxideVM-Preview-Error": phase }),
    },
  });
}

/** How the worker answers a request whose guest connection failed. A page navigation that
 * found nothing listening on the port (a server still starting, with no listening-port list to
 * wait for) gets a page that tries again by itself; anything else gets the 502. */
export function upstreamFailure(phase: string | undefined, navigate: boolean, parent: string | null): Response {
  if (!navigate || phase !== "open:listener") return upstreamFailedResponse(phase, parent);
  return messagePage({ error: phase, title: "Preview waiting", heading: "Nothing is running on this port yet.", detail: "This page tries again in a moment.", refreshSeconds: 2 }, parent);
}

/** The guest's server did not answer a request other than a page navigation in time. */
export function upstreamLateResponse(parent: string | null): Response {
  return new Response("Preview upstream did not answer in time", {
    status: 504,
    headers: {
      ...workerPageHeaders(parent),
      "Content-Type": "text/plain; charset=utf-8",
      "X-OxideVM-Preview-Error": "late",
    },
  });
}

/** Fail before contacting the guest when the browser cannot stream an upload. */
export function unsupportedRequestBodyResponse(parent: string | null): Response {
  return new Response("This browser cannot forward streaming request bodies to a local preview", {
    status: 501,
    headers: {
      ...workerPageHeaders(parent),
      "Content-Type": "text/plain; charset=utf-8",
      "X-OxideVM-Preview-Error": "request-body-unsupported",
    },
  });
}

/** Cookies a response set that the browser's cookie store refused, for diagnostics. */
export function cookieRefusalHeader(refused: number): Record<string, string> {
  return refused > 0 ? { "X-OxideVM-Preview-Cookies-Refused": String(refused) } : {};
}

/** No keeper granted a transport within 10 s: the Playground that opened this preview is gone. */
export function disconnectedPage(parent: string | null): Response {
  return messagePage({ error: "disconnected", title: "Preview disconnected", heading: "This preview is no longer connected.", detail: "Open it again from the Playground." }, parent);
}

/** A page of a session that a newer one replaced on the shared address. */
export function movedPage(parent: string | null): Response {
  return messagePage({ error: "moved", title: "Preview moved", heading: "This preview moved to a newer session.", detail: "Use the preview in the Playground." }, parent);
}

/** A page the guest's server has not answered within HEAD_WAIT_MS (a first compile can take
 * longer): it loads itself again after 2 s, without script, and the guest keeps compiling. */
export function startingPage(parent: string | null): Response {
  return messagePage({ error: "starting", title: "Preview starting", heading: "The app is still starting.", detail: "This page tries again in a moment.", refreshSeconds: 2 }, parent);
}

interface MessagePage {
  readonly error: string;
  readonly title: string;
  readonly heading: string;
  readonly detail: string;
  /** Load the page again after this many seconds (a declarative refresh, so no script). */
  readonly refreshSeconds?: number;
}

/** A 503 page the worker writes itself, with no script, framed only by the parent. */
function messagePage(page: MessagePage, parent: string | null): Response {
  const refresh = page.refreshSeconds === undefined ? "" : `<meta http-equiv="refresh" content="${String(page.refreshSeconds)}">`;
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">${refresh}<title>${page.title}</title>`
    + "<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-content:center;gap:4px;"
    + "font:14px/1.5 system-ui,sans-serif;text-align:center}h1{margin:0;font-size:15px;font-weight:600}p{margin:0;opacity:.7}</style>"
    + `</head><body><h1>${page.heading}</h1><p>${page.detail}</p></body></html>`;
  return new Response(body, {
    status: 503,
    headers: {
      ...workerPageHeaders(parent),
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors ${frameAncestors(parent)}`,
      "Content-Type": "text/html; charset=utf-8",
      ...(page.refreshSeconds === undefined ? {} : { "Retry-After": String(page.refreshSeconds) }),
      "X-OxideVM-Preview-Error": page.error,
    },
  });
}

/** Headers of pages the worker makes itself, so they render in the isolated parent's frame. */
function workerPageHeaders(parent: string | null): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; frame-ancestors ${frameAncestors(parent)}`,
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
}
