import { afterEach, describe, expect, it, vi } from "vitest";

const PARENT = "https://p.example";
const PAGE = "http://0123456789abcdef0123456789abcdef.localhost:5174/";
const NAVIGATE = "oxidevm-preview-navigate";
const DOCUMENT = "a2b5b220-b435-4eb0-89e2-b6b7653d9ff8";
const NAVIGATION = "e9a48190-8104-4b9d-af58-dab4dbf19a16";

interface Posted { readonly message: unknown; readonly origin: string }

/** A page inside the Playground's frame, with the script tag the worker injected. */
async function load(options: { readonly top?: boolean; readonly parentAttribute?: string | null } = {}) {
  const posted: Posted[] = [];
  const calls: string[] = [];
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  let paint = (): void => { throw new Error("Paint observation did not start"); };
  let observed: unknown;
  let disconnected = false;
  class PaintObserver {
    static readonly supportedEntryTypes = ["paint"];
    constructor(callback: (entries: { getEntries(): readonly { name: string }[] }) => void) {
      paint = () => { callback({ getEntries: () => [{ name: "first-contentful-paint" }] }); };
    }
    observe(options: unknown): void { observed = options; }
    disconnect(): void { disconnected = true; }
  }
  const parent = { postMessage: (message: unknown, origin: string) => { posted.push({ message, origin }); } };
  const location = { href: PAGE, reload: () => { calls.push("reload"); } };
  const move = (url: string | URL | null | undefined): void => {
    if (url !== null && url !== undefined) location.href = new URL(url, location.href).href;
  };
  const page: { location: typeof location; history: Record<string, unknown>; parent: unknown; addEventListener: (type: string, listener: (event: unknown) => void) => void } = {
    location,
    history: {
      pushState: (_data: unknown, _unused: string, url?: string | URL | null) => { calls.push("pushState"); move(url); },
      replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => { calls.push("replaceState"); move(url); },
      back: () => { calls.push("back"); },
      forward: () => { calls.push("forward"); },
    },
    parent,
    addEventListener: (type, listener) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
  };
  if (options.top === true) page.parent = page;
  const attribute = options.parentAttribute === undefined ? PARENT : options.parentAttribute;
  vi.stubGlobal("window", page);
  vi.stubGlobal("document", { currentScript: attribute === null ? null : { dataset: { oxidevmParent: attribute } } });
  vi.stubGlobal("crypto", { randomUUID: () => DOCUMENT });
  vi.stubGlobal("PerformanceObserver", PaintObserver);
  vi.resetModules();
  await import("./location");
  const fire = (type: string, event: unknown): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const call = (method: string, url: string): void => {
    const target = page.history[method];
    if (typeof target !== "function") throw new TypeError(`history.${method} is missing`);
    Reflect.apply(target, page.history, [null, "", url]);
  };
  return { page, parent, posted, calls, fire, call, paint: () => { paint(); }, observation: () => ({ observed, disconnected }) };
}

const reported = (href: string): Posted => ({ message: { type: "oxidevm-preview-location", href }, origin: PARENT });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("location.js", () => {
  it("reports the location on load, pushState, replaceState, popstate and hashchange", async () => {
    const { page, posted, fire, call } = await load();
    call("pushState", "/dashboard");
    call("replaceState", "/dashboard?tab=2");
    page.location.href = `${PAGE}back`;
    fire("popstate", {});
    page.location.href = `${PAGE}back#x`;
    fire("hashchange", {});
    expect(posted.filter(item => typeof item.message === "object" && item.message !== null && "type" in item.message && item.message.type === "oxidevm-preview-location"))
      .toEqual([reported(PAGE), reported(`${PAGE}dashboard`), reported(`${PAGE}dashboard?tab=2`), reported(`${PAGE}back`), reported(`${PAGE}back#x`)]);
  });

  it("distinguishes navigation, load and buffered contentful paint for the current document", async () => {
    const page = await load();
    const progress = (stage: string, navigation: string | null) => ({ message: {
      type: "oxidevm-preview-progress", version: 1, document: DOCUMENT, navigation, stage,
    }, origin: PARENT });
    expect(page.posted).toContainEqual(progress("document", null));
    expect(page.observation()).toEqual({ observed: { type: "paint", buffered: true }, disconnected: false });
    page.fire("message", { origin: PARENT, source: page.parent, data: {
      type: "oxidevm-preview-observe", version: 1, document: DOCUMENT, navigation: NAVIGATION,
    } });
    expect(page.posted.at(-1)).toEqual(progress("document", NAVIGATION));
    page.fire("load", {});
    expect(page.posted.at(-1)).toEqual(progress("loaded", NAVIGATION));
    page.paint();
    expect(page.posted.at(-1)).toEqual(progress("painted", NAVIGATION));
    expect(page.observation().disconnected).toBe(true);
    page.fire("load", {});
    expect(page.posted.at(-1)).toEqual(progress("painted", NAVIGATION));
  });

  it("does not disclose progress to another parent, document or malformed observer request", async () => {
    const page = await load();
    const request = { type: "oxidevm-preview-observe", version: 1, document: DOCUMENT, navigation: NAVIGATION };
    const initial = page.posted.length;
    page.fire("message", { origin: "https://evil.example", source: page.parent, data: request });
    page.fire("message", { origin: PARENT, source: {}, data: request });
    for (const data of [{ ...request, version: 2 }, { ...request, document: NAVIGATION }, { ...request, navigation: "bad" }, { ...request, extra: true }]) {
      page.fire("message", { origin: PARENT, source: page.parent, data });
    }
    expect(page.posted).toHaveLength(initial);
    page.paint();
    page.fire("message", { origin: PARENT, source: page.parent, data: { ...request, document: null } });
    expect(page.posted.at(-1)).toMatchObject({ message: { document: DOCUMENT, navigation: NAVIGATION, stage: "painted" } });
  });

  it("obeys back, forward and reload only from the parent's origin and window", async () => {
    const { parent, calls, fire } = await load();
    fire("message", { origin: PARENT, source: parent, data: { type: NAVIGATE, action: "back" } });
    fire("message", { origin: PARENT, source: parent, data: { type: NAVIGATE, action: "forward" } });
    fire("message", { origin: PARENT, source: parent, data: { type: NAVIGATE, action: "reload" } });
    fire("message", { origin: "https://evil.example", source: parent, data: { type: NAVIGATE, action: "back" } });
    fire("message", { origin: PARENT, source: {}, data: { type: NAVIGATE, action: "back" } });
    fire("message", { origin: PARENT, source: parent, data: { type: NAVIGATE, action: "go" } });
    fire("message", { origin: PARENT, source: parent, data: { type: NAVIGATE, action: "back", extra: 1 } });
    fire("message", { origin: PARENT, source: parent, data: "back" });
    expect(calls).toEqual(["back", "forward", "reload"]);
  });

  it.each([
    ["at the top level", { top: true }],
    ["without a parent attribute", { parentAttribute: null }],
    ["with a parent that has a path", { parentAttribute: "https://p.example/x" }],
    ["with a LAN http parent", { parentAttribute: "http://10.0.0.2:5173" }],
  ])("stays silent %s", async (_name, options) => {
    const { posted, fire, call } = await load(options);
    call("pushState", "/dashboard");
    fire("popstate", {});
    expect(posted).toEqual([]);
  });
});
