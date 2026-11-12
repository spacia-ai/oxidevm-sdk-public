import { afterEach, expect, it, vi } from "vitest";
import type { BlockedPreviewSite, PreviewSiteAccess } from "./contracts.js";
import type { RuntimeVM, PreviewHandle as RuntimePreviewHandle } from "./runtime/vm-types.js";
import { VMError } from "./runtime/errors.js";
import { decodeExposeOptions, PreviewRoutes } from "./preview-routes.js";
import { blockedSiteReport, stubPageWindow } from "./preview-blocked-sites.test-support.js";

afterEach(() => { vi.unstubAllGlobals(); });

function fixture() {
  let ports: Awaited<ReturnType<RuntimeVM["listeningPorts"]>> = [];
  const close = vi.fn(() => Promise.resolve());
  // The session a route opens keeps the access of its last change, as the session's Service Worker does.
  const session: { access: PreviewSiteAccess } = { access: { kind: "none" } };
  const setSiteAccess = vi.fn<RuntimePreviewHandle["setSiteAccess"]>(access => { session.access = access; return Promise.resolve(); });
  // A public handle watches the page that frames its preview itself, as a hosted frame's handle must, so it never asks the runtime's.
  const watchBlockedSites = () => Promise.reject(new VMError("PROTOCOL_ERROR", "a public handle watches its page itself"));
  const opened = vi.fn<RuntimeVM["exposePort"]>(port => Promise.resolve({ url: new URL(`https://session.preview.test/${port}`), setSiteAccess, watchBlockedSites, close }));
  const readers = new Set<(value: typeof ports) => void>();
  const runtime: Pick<RuntimeVM, "listeningPorts" | "watchListeningPorts" | "exposePort"> = {
    listeningPorts: () => Promise.resolve(ports), exposePort: opened,
    watchListeningPorts: (listener, options) => new Promise<void>((resolve, reject) => {
      const notify = (value: typeof ports) => { try { listener(value); } catch (error) { readers.delete(notify); reject(error instanceof Error ? error : new Error("listener failed")); } };
      readers.add(notify); notify(ports);
      const stop = () => { readers.delete(notify); resolve(); };
      if (options.signal.aborted) stop(); else options.signal.addEventListener("abort", stop, { once: true });
    }),
  };
  return { routes: new PreviewRoutes(runtime, "per-session"), opened, close, session, setSiteAccess, listen: (port: number) => {
    ports = [...ports, { port, address: "127.0.0.1", program: "guest-server", previewable: true }];
    for (const notify of readers) notify(ports);
  } };
}

function code(run: () => unknown): string | undefined {
  try { run(); } catch (error) { return error instanceof VMError ? error.code : undefined; }
  return undefined;
}

it("waits for the real listener and shares one route until the final exposure closes", async () => {
  const f = fixture(); const first = f.routes.expose(3000); const second = f.routes.expose(3000);
  await vi.waitFor(() => expect(f.opened).not.toHaveBeenCalled());
  f.listen(3000); const [a, b] = await Promise.all([first, second]);
  expect(f.opened).toHaveBeenCalledTimes(1); expect(a.url.href).toBe(b.url.href);
  await a.close(); await a.close(); expect(f.close).not.toHaveBeenCalled();
  await b.close(); expect(f.close).toHaveBeenCalledTimes(1); await f.routes.dispose();
});
it("cancels one waiting caller without withdrawing the other caller's route", async () => {
  const f = fixture(); const controller = new AbortController();
  const first = f.routes.expose(3000, { signal: controller.signal }); const second = f.routes.expose(3000);
  const rejected = expect(first).rejects.toMatchObject({ code: "ABORTED" }); controller.abort(); await rejected;
  f.listen(3000); const survivor = await second;
  expect(f.opened).toHaveBeenCalledTimes(1); await survivor.close(); expect(f.close).toHaveBeenCalledTimes(1);
});
it("owns distinct ports and cancels pending admission on VM disposal", async () => {
  const f = fixture(); f.listen(3000); f.listen(4000);
  await Promise.all([f.routes.expose(3000), f.routes.expose(4000)]);
  const pending = f.routes.expose(5000); const rejection = expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await f.routes.dispose(); await rejection; expect(f.close).toHaveBeenCalledTimes(2);
});

it("repeated exposures share one session's site access; the last setSiteAccess wins", async () => {
  const f = fixture(); f.listen(3000);
  const first = await f.routes.expose(3000, { siteAccess: { kind: "sites", sites: ["a.example.com"] } });
  const second = await f.routes.expose(3000, { siteAccess: { kind: "any" } });
  const third = await f.routes.expose(3000);
  // One session opened, with no access of its own; each exposure that named an access applied it to that session.
  expect(f.opened).toHaveBeenCalledTimes(1);
  expect(f.opened.mock.calls[0]?.[1]).toEqual({ signal: expect.any(AbortSignal) as unknown });
  expect(new Set([first.url.href, second.url.href, third.url.href]).size).toBe(1);
  expect(f.session.access).toEqual({ kind: "any" });
  await first.setSiteAccess({ kind: "sites", sites: ["c.example.com", "B.example.com"] });
  expect(f.session.access).toEqual({ kind: "sites", sites: ["b.example.com", "c.example.com"] });
  await third.setSiteAccess({ kind: "none" });
  expect(f.setSiteAccess.mock.calls.map(([access]) => access)).toEqual([
    { kind: "sites", sites: ["a.example.com"] }, { kind: "any" }, { kind: "sites", sites: ["b.example.com", "c.example.com"] }, { kind: "none" },
  ]);
  expect(f.session.access).toEqual({ kind: "none" });
  // A closed handle changes nothing; the session's other exposures still do.
  await first.close();
  await expect(first.setSiteAccess({ kind: "any" })).rejects.toMatchObject({ code: "ABORTED" });
  expect(f.setSiteAccess).toHaveBeenCalledTimes(4);
  await second.setSiteAccess({ kind: "any" }, { signal: new AbortController().signal });
  expect(f.session.access).toEqual({ kind: "any" });
  await second.close(); await third.close();
  expect(f.close).toHaveBeenCalledTimes(1);
  await f.routes.dispose();
});

it("an exposure resolves once its site access applied, and a failed one releases only that exposure", async () => {
  const f = fixture(); f.listen(3000);
  const change = Promise.withResolvers<undefined>();
  f.setSiteAccess.mockImplementationOnce(() => change.promise);
  let granted = false;
  const granting = f.routes.expose(3000, { siteAccess: { kind: "any" } }).then(handle => { granted = true; return handle; });
  const plain = await f.routes.expose(3000);
  expect(f.setSiteAccess).toHaveBeenCalledOnce();
  expect(granted).toBe(false);
  change.reject(new VMError("FEATURE_NOT_AVAILABLE", "The preview host did not answer", { reason: "preview-host-outdated" }));
  await expect(granting).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "preview-host-outdated" } });
  // The exposure that asked for nothing keeps the session.
  expect(f.close).not.toHaveBeenCalled();
  await plain.close();
  expect(f.close).toHaveBeenCalledOnce();
  // On its own, a failed exposure closes the session it opened.
  f.setSiteAccess.mockImplementationOnce(() => Promise.reject(new VMError("RELAY_ERROR", "No worker took the site access", { reason: "no-worker" })));
  await expect(f.routes.expose(3000, { siteAccess: { kind: "any" } })).rejects.toMatchObject({ code: "RELAY_ERROR" });
  expect(f.opened).toHaveBeenCalledTimes(2);
  expect(f.close).toHaveBeenCalledTimes(2);
  await f.routes.dispose();
});

it("validates exposure options and site access changes before anything opens or is sent", async () => {
  const signal = new AbortController().signal;
  expect(decodeExposeOptions(undefined)).toEqual({});
  expect(decodeExposeOptions({ signal, siteAccess: { kind: "sites", sites: ["B.example.com", "a.example.com"] } }))
    .toEqual({ signal, siteAccess: { kind: "sites", sites: ["a.example.com", "b.example.com"] } });
  for (const options of [null, "signal", { signal: "no" }, { signal, extra: true }, { siteAccess: { kind: "sites", sites: ["localhost"] } }, { siteAccess: { kind: "all" } }, { siteAccess: null }]) {
    expect(code(() => decodeExposeOptions(options)), JSON.stringify(options)).toBe("INVALID_ARGUMENT");
  }
  const f = fixture(); f.listen(3000);
  const handle = await f.routes.expose(3000);
  await expect(handle.setSiteAccess({ kind: "sites", sites: ["127.0.0.1"] })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(handle.setSiteAccess({ kind: "sites", sites: Array.from({ length: 65 }, (_, index) => `s${String(index)}.example.com`) })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  // @ts-expect-error a change takes only an AbortSignal option
  await expect(handle.setSiteAccess({ kind: "any" }, { signal: "no" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  // @ts-expect-error a watch needs options with exactly an AbortSignal
  await expect(handle.watchBlockedSites(() => {}, {})).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  // @ts-expect-error the listener must be a function
  await expect(handle.watchBlockedSites("listener", { signal })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(f.setSiteAccess).not.toHaveBeenCalled();
  await handle.setSiteAccess({ kind: "any" });
  expect(f.setSiteAccess).toHaveBeenCalledOnce();
  await handle.close(); await f.routes.dispose();
});

it("a handle watches the blocked sites its preview reports to this page until it closes or the VM is disposed", async () => {
  const page = stubPageWindow();
  const f = fixture(); f.listen(3000);
  const handle = await f.routes.expose(3000), seen: BlockedPreviewSite[] = [];
  const watching = handle.watchBlockedSites(blocked => { seen.push(blocked); }, { signal: new AbortController().signal });
  page.post("https://other.preview.test", blockedSiteReport("api.example.com"));
  page.post(handle.url.origin, blockedSiteReport("api.example.com"));
  expect(seen).toEqual([{ site: "api.example.com", directive: "connect" }]);
  await handle.close();
  await expect(watching).resolves.toBeUndefined();
  expect(page.listeners.size).toBe(0);
  await expect(handle.watchBlockedSites(() => {}, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "ABORTED" });
  // Disposal ends a running watch, and the handle then answers like the rest of the disposed VM.
  const other = await f.routes.expose(3000);
  const ending = other.watchBlockedSites(() => {}, { signal: new AbortController().signal });
  await f.routes.dispose();
  await expect(ending).resolves.toBeUndefined();
  expect(page.listeners.size).toBe(0);
  await expect(other.setSiteAccess({ kind: "any" })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  await expect(other.watchBlockedSites(() => {}, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
});
