/// <reference lib="webworker" />

// The runtime frame's offline shell (ADR 0021). Registered with the frame's versioned path as its
// scope, it precaches every file of this build (listed in shell-manifest.json) and serves them
// cache-first: the path names the SDK version, so a cached file never goes stale. Engine releases
// and images live outside the scope and keep the SDK's content-addressed caches. The page is
// network-first so a redeployed shell takes effect; offline it comes from the cache.

const worker: unknown = globalThis;
if (!(worker instanceof ServiceWorkerGlobalScope)) throw new TypeError("the runtime frame's shell must run as a Service Worker");
const sw = worker;

const PREFIX = "oxidevm-runtime-host-";
/** Older frame versions kept for pages that still pin them. */
const KEEP = 3;
const scope = new URL(sw.registration.scope);
const cacheName = `${PREFIX}${scope.pathname}`;

async function install(): Promise<void> {
  const response = await fetch(new URL("shell-manifest.json", scope), { cache: "no-store" });
  const manifest: unknown = await response.json();
  if (!Array.isArray(manifest)) throw new Error("the runtime frame's shell manifest is invalid");
  const entries: readonly unknown[] = manifest;
  const files = entries.map(entry => {
    if (typeof entry !== "string" || !/^[A-Za-z0-9._/-]+$/u.test(entry) || entry.includes("..")) throw new Error("the runtime frame's shell manifest is invalid");
    return entry;
  });
  const cache = await caches.open(cacheName);
  await cache.addAll(["./", ...files].map(entry => new URL(entry, scope).href));
}

async function prune(): Promise<void> {
  const shells = (await caches.keys()).filter(name => name.startsWith(PREFIX) && name !== cacheName);
  await Promise.all(shells.slice(0, Math.max(0, shells.length - (KEEP - 1))).map(name => caches.delete(name)));
}

sw.addEventListener("install", event => { event.waitUntil(install().then(() => sw.skipWaiting())); });
sw.addEventListener("activate", event => { event.waitUntil(prune().then(() => sw.clients.claim())); });
sw.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    // The page itself is fetched first so a redeployed shell takes effect; its hashed scripts
    // never change and come from the cache first.
    if (event.request.mode === "navigate") {
      try {
        const fresh = await fetch(event.request);
        if (fresh.ok) await cache.put(new URL("./", scope).href, fresh.clone());
        return fresh;
      } catch {
        return await cache.match(new URL("./", scope).href) ?? Response.error();
      }
    }
    return await cache.match(event.request, { ignoreSearch: true }) ?? fetch(event.request);
  })());
});
