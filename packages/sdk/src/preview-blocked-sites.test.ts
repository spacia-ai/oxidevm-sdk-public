import { afterEach, expect, it, vi } from "vitest";
import type { BlockedPreviewSite } from "./contracts.js";
import { MAX_BLOCKED_SITES_PER_WATCH, watchBlockedPreviewSites, watchHandleBlockedSites } from "./preview-blocked-sites.js";
import { blockedSiteReport as report, fakeWindow, stubPageWindow, type FakeWindow } from "./preview-blocked-sites.test-support.js";

const PREVIEW = "https://0123456789abcdef0123456789abcdef.preview.test";

afterEach(() => { vi.unstubAllGlobals(); });

function watch(page: FakeWindow, listener: (blocked: BlockedPreviewSite) => void = () => {}) {
  const controller = new AbortController();
  return { controller, done: watchBlockedPreviewSites(page.target, PREVIEW, listener, controller.signal) };
}

it("delivers a valid report from the preview origin once", async () => {
  const page = fakeWindow(), seen: BlockedPreviewSite[] = [];
  const { controller, done } = watch(page, blocked => { seen.push(blocked); });
  page.post(PREVIEW, report("api.open-meteo.com"));
  page.post(PREVIEW, report("api.open-meteo.com"));
  // A site is one site, whichever directive the page reports it under next.
  page.post(PREVIEW, report("api.open-meteo.com", "script"));
  page.post(PREVIEW, report("cdn.example.com:8443", "font"));
  expect(seen).toEqual([{ site: "api.open-meteo.com", directive: "connect" }, { site: "cdn.example.com:8443", directive: "font" }]);
  controller.abort();
  await expect(done).resolves.toBeUndefined();
});

it("ignores other origins, malformed messages and extra keys", async () => {
  const page = fakeWindow(), seen: BlockedPreviewSite[] = [];
  const { controller, done } = watch(page, blocked => { seen.push(blocked); });
  const valid = report("api.example.com");
  page.post("https://fedcba9876543210fedcba9876543210.preview.test", valid);
  page.post(`${PREVIEW}:8443`, valid);
  page.post("null", valid);
  const { directive: _directive, ...noDirective } = valid; void _directive;
  for (const data of [
    "oxidevm-preview-blocked-site", null, 7, [valid], { ...valid, extra: true }, noDirective,
    { ...valid, type: "oxidevm-preview-location" }, { ...valid, version: 2 }, { ...valid, version: "1" },
    { ...valid, site: 1 }, { ...valid, directive: "worker" }, { ...valid, directive: "connect-src" }, { ...valid, directive: null },
    // A site arrives in its canonical form or not at all.
    ...["API.example.com", "https://api.example.com", "api.example.com:443", "api.example.com.", "localhost", "127.0.0.1", "intranet", `${"a".repeat(300)}.example`]
      .map(site => report(site)),
  ]) page.post(PREVIEW, data);
  expect(seen).toEqual([]);
  page.post(PREVIEW, valid);
  expect(seen).toEqual([{ site: "api.example.com", directive: "connect" }]);
  for (const directive of ["script", "style", "image", "font", "media", "frame"]) page.post(PREVIEW, report(`${directive}.example.com`, directive));
  expect(seen.map(blocked => blocked.directive)).toEqual(["connect", "script", "style", "image", "font", "media", "frame"]);
  controller.abort();
  await done;
});

it("stops after 64 distinct sites", async () => {
  const page = fakeWindow(), seen: string[] = [];
  const { controller, done } = watch(page, blocked => { seen.push(blocked.site); });
  for (let index = 0; index < 1_000; index++) page.post(PREVIEW, report(`site-${String(index % 500)}.example.com`));
  expect(MAX_BLOCKED_SITES_PER_WATCH).toBe(64);
  expect(seen).toEqual(Array.from({ length: 64 }, (_, index) => `site-${String(index)}.example.com`));
  // The watch no longer listens, but it ends only when its signal aborts.
  expect(page.listeners.size).toBe(0);
  let settled = false;
  void done.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  controller.abort();
  await expect(done).resolves.toBeUndefined();
});

it("resolves when the signal aborts", async () => {
  const page = fakeWindow(), seen: BlockedPreviewSite[] = [];
  const { controller, done } = watch(page, blocked => { seen.push(blocked); });
  expect(page.listeners.size).toBe(1);
  controller.abort();
  await expect(done).resolves.toBeUndefined();
  expect(page.listeners.size).toBe(0);
  page.post(PREVIEW, report("api.example.com"));
  expect(seen).toEqual([]);
  // An already aborted signal ends the watch before it listens.
  await expect(watchBlockedPreviewSites(page.target, PREVIEW, () => {}, AbortSignal.abort())).resolves.toBeUndefined();
  expect(page.listeners.size).toBe(0);
});

it("rejects when the listener throws", async () => {
  const page = fakeWindow();
  let calls = 0;
  const failure = new Error("listener failed");
  const { done } = watch(page, () => { calls++; throw failure; });
  page.post(PREVIEW, report("api.example.com"));
  await expect(done).rejects.toBe(failure);
  expect(page.listeners.size).toBe(0);
  page.post(PREVIEW, report("other.example.com"));
  expect(calls).toBe(1);
  // A thrown value that is not an Error becomes the cause of the rejection.
  const thrown: unknown = "text";
  const second = watch(page, () => { throw thrown; });
  page.post(PREVIEW, report("api.example.com"));
  await expect(second.done).rejects.toMatchObject({ cause: "text" });
  expect(page.listeners.size).toBe(0);
});

it("a handle's watch checks its arguments first, then refuses a closed handle and a disposed VM", async () => {
  const signal = new AbortController().signal, closed = new AbortController(), lifetime = new AbortController();
  const ends = { closed: closed.signal, lifetime: lifetime.signal };
  // @ts-expect-error the listener must be a function
  await expect(watchHandleBlockedSites(PREVIEW, ends, "listener", { signal })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  for (const options of [undefined, null, {}, { signal: "no" }, { signal, extra: true }]) {
    // @ts-expect-error a watch needs options with exactly an AbortSignal
    await expect(watchHandleBlockedSites(PREVIEW, ends, () => {}, options), JSON.stringify(options)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  }
  lifetime.abort();
  await expect(watchHandleBlockedSites(PREVIEW, ends, () => {}, { signal })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  // A closed handle answers ABORTED even once its VM is disposed; invalid arguments still answer INVALID_ARGUMENT.
  closed.abort();
  await expect(watchHandleBlockedSites(PREVIEW, ends, () => {}, { signal })).rejects.toMatchObject({ code: "ABORTED" });
  // @ts-expect-error a watch needs options with exactly an AbortSignal
  await expect(watchHandleBlockedSites(PREVIEW, ends, () => {}, {})).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});

it("a handle's watch hears its session origin in this document until its signal aborts, its handle closes or its VM is disposed", async () => {
  const page = stubPageWindow();
  for (const end of ["signal", "closed", "lifetime"] as const) {
    const controllers = { signal: new AbortController(), closed: new AbortController(), lifetime: new AbortController() }, seen: BlockedPreviewSite[] = [];
    const watching = watchHandleBlockedSites(PREVIEW, { closed: controllers.closed.signal, lifetime: controllers.lifetime.signal },
      blocked => { seen.push(blocked); }, { signal: controllers.signal.signal });
    page.post("https://fedcba9876543210fedcba9876543210.preview.test", report("other.example.com"));
    page.post(PREVIEW, report("api.example.com"));
    expect(seen, end).toEqual([{ site: "api.example.com", directive: "connect" }]);
    controllers[end].abort();
    expect(page.listeners.size, end).toBe(0);
    await expect(watching, end).resolves.toBeUndefined();
  }
});
