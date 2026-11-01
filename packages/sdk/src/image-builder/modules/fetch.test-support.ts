import type { Fetch, RedirectPolicy } from "./fetch.js";

export interface Route {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | ReadableStream<Uint8Array> | string;
}
export interface Call {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A fake network: each URL answers from a table (or a function of the request), and every request is recorded. */
export function fakeNetwork(routes: Readonly<Record<string, Route | ((call: Call) => Route)>>): { readonly fetchImpl: Fetch; readonly calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: Fetch = (url, init) => {
    const headers: Record<string, string> = {};
    if (init.headers !== undefined) for (const [name, value] of Object.entries(init.headers)) headers[name.toLowerCase()] = String(value);
    const call: Call = { url: url.href, headers };
    calls.push(call);
    const found = routes[url.href];
    const route = typeof found === "function" ? found(call) : found;
    if (route === undefined) return Promise.resolve(new Response(null, { status: 404 }));
    const body = typeof route.body === "string" ? new TextEncoder().encode(route.body) : route.body;
    return Promise.resolve(new Response(body === undefined ? null : body instanceof Uint8Array ? body.slice() : body, { status: route.status ?? 200, headers: route.headers ?? {} }));
  };
  return { fetchImpl, calls };
}

/** HTTPS to hosts ending in `.test`, at most three hops. */
export const testPolicy: RedirectPolicy = { maxHops: 3, allows: url => url.protocol === "https:" && url.hostname.endsWith(".test") };
