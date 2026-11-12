import { afterEach, expect, it, vi } from "vitest";
import type { PreviewSiteAccess } from "../contracts.js";
import { isPreviewSessionOrigin, openPreviewSession, sessionOrigin, sharedSessionOrigin, SITES_REPLY_MS } from "./preview-session.js";
import type { KeeperMessage, KeeperSource, PreviewKeeperHost } from "./preview-keeper.js";
import { PROTOCOL_VERSION } from "./protocol.js";

const ports: MessagePort[] = [];
afterEach(() => { for (const port of ports.splice(0)) port.close(); vi.useRealTimers(); });

function keepPorts(transfer: readonly Transferable[] | undefined): void {
  for (const item of transfer ?? []) if (item instanceof MessagePort) ports.push(item);
}

/** A fake embedding document: records keeper frames and delivers messages to the session's listener. */
function keeperHost(source?: KeeperSource) {
  const opened: URL[] = [];
  const retired: string[] = [];
  const listeners = new Set<(message: KeeperMessage) => void>();
  let closed = 0;
  const host: PreviewKeeperHost = {
    origin: "https://ide.test",
    open: url => { opened.push(url); return { source: source?.identity ?? {}, retire: session => { retired.push(session); }, close: () => { closed += 1; } }; },
    listen: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const deliver = (message: KeeperMessage): void => { for (const listener of listeners) listener(message); };
  return { host, opened, retired, deliver, closed: () => closed, listening: () => listeners.size };
}

function keeperSource() {
  const replies: { message: unknown; targetOrigin: string; transfer: Transferable[] }[] = [];
  return { replies, source: { identity: {}, postMessage: (message: unknown, options: { readonly targetOrigin: string; readonly transfer: Transferable[] }) => {
    replies.push({ message, targetOrigin: options.targetOrigin, transfer: options.transfer });
    keepPorts(options.transfer);
  } } };
}

function fakeNetwork() {
  const posted: { message: unknown; transfer: Transferable[] | undefined }[] = [];
  return { posted, network: { postMessage: (message: unknown, transfer?: Transferable[]) => { posted.push({ message, transfer }); keepPorts(transfer); } } };
}

it("derives one session origin per session below the preview host and rejects unusable origins", () => {
  expect(sessionOrigin(new URL("https://oxidevm-preview.test:4573"), "a".repeat(32)).href).toBe(`https://${"a".repeat(32)}.oxidevm-preview.test:4573/`);
  expect(sessionOrigin(new URL("http://localhost:4273"), "0".repeat(32)).href).toBe(`http://${"0".repeat(32)}.localhost:4273/`);
  expect(() => sessionOrigin(new URL("http://127.0.0.1:4273"), "0".repeat(32))).toThrow(/DNS host/u);
  expect(() => sessionOrigin(new URL("https://oxidevm-preview.test:4573/path"), "0".repeat(32))).toThrow(/bare origin/u);
  expect(() => sessionOrigin(new URL("https://oxidevm-preview.test:4573"), "not-a-session")).toThrow(/session identity/u);
});

it("hands the keeper a network transport, resolves on ready, and retires the session on close", async () => {
  const { replies, source } = keeperSource();
  const { host, opened, retired, deliver, closed, listening } = keeperHost(source);
  const { posted, network } = fakeNetwork();
  const opening = openPreviewSession({ isolation: "per-session", previewOrigin: new URL("https://oxidevm-preview.test:4573"), runtime: "system", port: 3000, network, host, bootstrapTimeoutMs: 5_000 });
  expect(opened).toHaveLength(1);
  const bootstrap = opened[0];
  if (bootstrap === undefined) throw new Error("keeper not opened");
  const session = bootstrap.searchParams.get("session");
  if (session === null) throw new Error("missing session");
  expect(bootstrap.pathname).toBe("/__oxidevm/");
  expect(bootstrap.hostname).toBe(`${session}.oxidevm-preview.test`);
  expect(bootstrap.searchParams.get("parentOrigin")).toBe("https://ide.test");
  // Messages from other origins, other sessions, or without a sender never reach the network.
  deliver({ origin: "https://evil.test", data: { kind: "oxidevm-preview-connect", session }, source });
  deliver({ origin: bootstrap.origin, data: { kind: "oxidevm-preview-connect", session: "0".repeat(32) }, source });
  deliver({ origin: bootstrap.origin, data: { kind: "oxidevm-preview-connect", session }, source: null });
  // A guest frame knows its own session hostname, but it cannot acquire the keeper's transport.
  const forged = keeperSource();
  deliver({ origin: bootstrap.origin, data: { kind: "oxidevm-preview-connect", session }, source: forged.source });
  expect(posted.length).toBe(0);
  deliver({ origin: bootstrap.origin, data: { kind: "oxidevm-preview-connect", session }, source });
  expect(posted).toHaveLength(1);
  expect(posted[0]?.message).toMatchObject({ type: "expose-preview-port", runtime: "system", session, port: 3000, sessionOrigin: `https://${session}.oxidevm-preview.test:4573` });
  expect(posted[0]?.transfer?.[0]).toBeInstanceOf(MessagePort);
  expect(replies).toHaveLength(1);
  expect(replies[0]?.message).toMatchObject({ kind: "oxidevm-preview-port", session });
  expect(replies[0]?.targetOrigin).toBe(bootstrap.origin);
  expect(replies[0]?.transfer[0]).toBeInstanceOf(MessagePort);
  deliver({ origin: bootstrap.origin, data: { kind: "oxidevm-preview-ready", session }, source });
  const handle = await opening;
  expect(handle.url.href).toBe(`https://${session}.oxidevm-preview.test:4573/`);
  // A restarted worker asks again and receives another transport in the same session.
  deliver({ origin: bootstrap.origin, data: { kind: "oxidevm-preview-connect", session }, source });
  expect(posted).toHaveLength(2);
  await handle.close();
  await handle.close();
  expect(retired).toEqual([session]);
  expect(closed()).toBe(1);
  expect(listening()).toBe(0);
  expect(posted.at(-1)?.message).toMatchObject({ type: "close-preview-session", session });
  expect(posted).toHaveLength(3);
});

it("fails closed when the keeper never reports ready or the caller aborts", async () => {
  const { host } = keeperHost();
  const network = { postMessage: vi.fn() };
  await expect(openPreviewSession({ isolation: "per-session", previewOrigin: new URL("https://oxidevm-preview.test:4573"), runtime: "userspace", port: 3000, network, host, bootstrapTimeoutMs: 20 }))
    .rejects.toMatchObject({ code: "RELAY_ERROR" });
  const controller = new AbortController();
  const opening = openPreviewSession({ isolation: "per-session", previewOrigin: new URL("https://oxidevm-preview.test:4573"), runtime: "system", port: 3000, network, host, signal: controller.signal, bootstrapTimeoutMs: 5_000 });
  controller.abort();
  await expect(opening).rejects.toMatchObject({ code: "ABORTED" });
  expect(network.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "close-preview-session" }));
});

it("rejects an IP-literal preview host instead of throwing", async () => {
  const { host } = keeperHost();
  const { network } = fakeNetwork();
  let opening: Promise<unknown> | undefined;
  expect(() => { opening = openPreviewSession({ isolation: "per-session", previewOrigin: new URL("http://127.0.0.1:4273"), runtime: "userspace", port: 3000, network, host }); }).not.toThrow();
  await expect(opening).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});

it("rejects when the keeper document cannot open, and ends the session", async () => {
  const { host } = keeperHost();
  const { posted, network } = fakeNetwork();
  const failing: PreviewKeeperHost = { ...host, open: () => { throw new TypeError("no document"); } };
  let opening: Promise<unknown> | undefined;
  expect(() => { opening = openPreviewSession({ isolation: "per-session", previewOrigin: new URL("https://oxidevm-preview.test:4573"), runtime: "userspace", port: 3000, network, host: failing }); }).not.toThrow();
  await expect(opening).rejects.toThrow("no document");
  expect(posted.at(-1)?.message).toMatchObject({ type: "close-preview-session" });
});

it.each([
  ["service-worker-blocked", "PERMISSION_DENIED"],
  ["service-worker-failed", "RELAY_ERROR"],
])("fails at once when the keeper reports %s", async (reason, code) => {
  const { source } = keeperSource();
  const { host, opened, deliver, closed } = keeperHost(source);
  const { posted, network } = fakeNetwork();
  const opening = openPreviewSession({ isolation: "per-session", previewOrigin: new URL("https://oxidevm-preview.test:4573"), runtime: "userspace", port: 3000, network, host, bootstrapTimeoutMs: 60_000 });
  const bootstrap = opened[0];
  const session = bootstrap?.searchParams.get("session");
  if (bootstrap === undefined || session === null || session === undefined) throw new Error("keeper not opened");
  deliver({ origin: bootstrap.origin, data: { kind: "oxidevm-preview-failed", session, reason }, source });
  await expect(opening).rejects.toMatchObject({ code, detail: { reason, origin: bootstrap.origin } });
  expect(closed()).toBe(1);
  expect(posted.at(-1)?.message).toMatchObject({ type: "close-preview-session", session });
});

it("ignores failure reports it cannot trust", async () => {
  const { source } = keeperSource();
  const { host, opened, deliver } = keeperHost(source);
  const { network } = fakeNetwork();
  const opening = openPreviewSession({ isolation: "per-session", previewOrigin: new URL("https://oxidevm-preview.test:4573"), runtime: "userspace", port: 3000, network, host, bootstrapTimeoutMs: 60_000 });
  const bootstrap = opened[0];
  const session = bootstrap?.searchParams.get("session");
  if (bootstrap === undefined || session === null || session === undefined) throw new Error("keeper not opened");
  deliver({ origin: "https://evil.test", data: { kind: "oxidevm-preview-failed", session, reason: "service-worker-blocked" }, source });
  deliver({ origin: bootstrap.origin, data: { kind: "oxidevm-preview-failed", session: "0".repeat(32), reason: "service-worker-blocked" }, source });
  deliver({ origin: bootstrap.origin, data: { kind: "oxidevm-preview-failed", session, reason: "denied" }, source });
  deliver({ origin: bootstrap.origin, data: { kind: "oxidevm-preview-failed", session, reason: "service-worker-blocked", detail: 1 }, source });
  deliver({ origin: bootstrap.origin, data: { kind: "oxidevm-preview-ready", session }, source });
  await expect(opening).resolves.toMatchObject({ url: new URL(`https://${session}.oxidevm-preview.test:4573/`) });
});

it("uses the preview origin itself as the shared address", () => {
  expect(sharedSessionOrigin(new URL("https://fedora.tail133191.ts.net:8443")).href).toBe("https://fedora.tail133191.ts.net:8443/");
  expect(sharedSessionOrigin(new URL("http://127.0.0.1:4273")).href).toBe("http://127.0.0.1:4273/");
  expect(() => sharedSessionOrigin(new URL("https://fedora.tail133191.ts.net:8443/x"))).toThrow(/bare origin/u);
});

it("recognises the origins a preview origin hands to sessions, and nothing else", () => {
  const session = "0a".repeat(16);
  expect(isPreviewSessionOrigin(new URL(`http://${session}.localhost:5174/dashboard?x#y`), "http://localhost:5174", "per-session")).toBe(true);
  for (const url of [`http://evil.localhost:5174/`, `http://${session}.localhost:5175/`, `https://${session}.localhost:5174/`,
    `http://${session}.${session}.localhost:5174/`, "http://localhost:5174/"]) {
    expect(isPreviewSessionOrigin(new URL(url), "http://localhost:5174", "per-session")).toBe(false);
  }
  expect(isPreviewSessionOrigin(new URL("http://127.0.0.1:4273/"), "http://127.0.0.1:4273", "per-session")).toBe(false);
  expect(isPreviewSessionOrigin(new URL(`http://${session}.localhost:5174/`), "http://localhost:5174/x", "per-session")).toBe(false);
  expect(isPreviewSessionOrigin(new URL(`http://${session}.localhost:5174/`), "not a URL", "per-session")).toBe(false);
  expect(isPreviewSessionOrigin(new URL("https://fedora.tail133191.ts.net:8443/x"), "https://fedora.tail133191.ts.net:8443", "shared")).toBe(true);
  expect(isPreviewSessionOrigin(new URL(`https://${session}.fedora.tail133191.ts.net:8443/`), "https://fedora.tail133191.ts.net:8443", "shared")).toBe(false);
  expect(isPreviewSessionOrigin(new URL("https://fedora.tail133191.ts.net/"), "https://fedora.tail133191.ts.net:8443", "shared")).toBe(false);
});

it("opens a shared session on the preview origin itself and tells the keeper and the network", async () => {
  const { source } = keeperSource();
  const { host, opened, deliver } = keeperHost(source);
  const { posted, network } = fakeNetwork();
  const opening = openPreviewSession({ previewOrigin: new URL("https://fedora.tail133191.ts.net:8443"), isolation: "shared", runtime: "userspace", port: 3000, network, host, bootstrapTimeoutMs: 5_000 });
  const bootstrap = opened[0];
  const session = bootstrap?.searchParams.get("session");
  if (bootstrap === undefined || session === null || session === undefined) throw new Error("keeper not opened");
  expect(bootstrap.origin).toBe("https://fedora.tail133191.ts.net:8443");
  expect(bootstrap.searchParams.get("isolation")).toBe("shared");
  deliver({ origin: bootstrap.origin, data: { kind: "oxidevm-preview-connect", session }, source });
  expect(posted[0]?.message).toMatchObject({ version: PROTOCOL_VERSION, type: "expose-preview-port", isolation: "shared", session, sessionOrigin: "https://fedora.tail133191.ts.net:8443" });
  deliver({ origin: bootstrap.origin, data: { kind: "oxidevm-preview-ready", session }, source });
  await expect(opening).resolves.toMatchObject({ url: new URL("https://fedora.tail133191.ts.net:8443/") });
});

const SITES: PreviewSiteAccess = { kind: "sites", sites: ["B.example", "a.example"] };
const CANONICAL_SITES: PreviewSiteAccess = { kind: "sites", sites: ["a.example", "b.example"] };

function kindOf(value: unknown): unknown {
  return typeof value === "object" && value !== null && "kind" in value ? value.kind : undefined;
}

/** What `promise` has done once the reactions already queued have run. */
async function settlement(promise: Promise<unknown>): Promise<"pending" | "fulfilled" | "rejected"> {
  let state: "pending" | "fulfilled" | "rejected" = "pending";
  void promise.then(() => { state = "fulfilled"; }, () => { state = "rejected"; });
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  return state;
}

/** A session on a fake keeper for the site-access tests: `from` delivers what the keeper document says,
 * `ready` walks it through connect and ready, and `sitesPosts` lists the site-access messages the session
 * posted to the keeper. */
function siteSession(siteAccess?: PreviewSiteAccess, source = keeperSource()) {
  const fake = keeperHost(source.source);
  const { posted, network } = fakeNetwork();
  const opening = openPreviewSession({ isolation: "per-session", previewOrigin: new URL("https://oxidevm-preview.test:4573"), runtime: "userspace", port: 3000, network, host: fake.host,
    bootstrapTimeoutMs: 60_000, ...(siteAccess === undefined ? {} : { siteAccess }) });
  const bootstrap = fake.opened[0];
  const session = bootstrap?.searchParams.get("session");
  if (bootstrap === undefined || session === null || session === undefined) throw new Error("keeper not opened");
  const from = (data: unknown): void => { fake.deliver({ origin: bootstrap.origin, data, source: source.source }); };
  return {
    opening, session, origin: bootstrap.origin, from, deliver: fake.deliver, source: source.source, posted, retired: fake.retired, closed: fake.closed, listening: fake.listening,
    ready: (): void => { from({ kind: "oxidevm-preview-connect", session }); from({ kind: "oxidevm-preview-ready", session }); },
    applied: (revision: number): void => { from({ kind: "oxidevm-preview-sites-applied", session, revision }); },
    refused: (revision: number, reason: string): void => { from({ kind: "oxidevm-preview-sites-refused", session, revision, reason }); },
    sitesPosts: () => source.replies.filter(reply => kindOf(reply.message) === "oxidevm-preview-sites"),
  };
}

/** An open session that granted no sites. */
async function openHandle() {
  const opened = siteSession();
  opened.ready();
  return { ...opened, handle: await opened.opening };
}

it("a site access of none at open posts nothing to the keeper", async () => {
  const accesses: readonly PreviewSiteAccess[] = [{ kind: "none" }, { kind: "sites", sites: [] }];
  for (const siteAccess of accesses) {
    const opened = siteSession(siteAccess);
    opened.ready();
    await expect(opened.opening).resolves.toMatchObject({ url: new URL(`${opened.origin}/`) });
    expect(opened.sitesPosts()).toEqual([]);
  }
});

it("exposePort with sites resolves only after the keeper applied them", async () => {
  const opened = siteSession(SITES);
  opened.from({ kind: "oxidevm-preview-connect", session: opened.session });
  // The keeper answers "no-worker" before its first attach, so nothing is posted before it is ready.
  expect(opened.sitesPosts()).toEqual([]);
  opened.from({ kind: "oxidevm-preview-ready", session: opened.session });
  expect(opened.sitesPosts()).toEqual([{ message: { kind: "oxidevm-preview-sites", session: opened.session, revision: 1, access: CANONICAL_SITES }, targetOrigin: opened.origin, transfer: [] }]);
  expect(await settlement(opened.opening)).toBe("pending");
  // Answers it cannot trust, or for another revision, change nothing.
  opened.deliver({ origin: "https://evil.test", data: { kind: "oxidevm-preview-sites-applied", session: opened.session, revision: 1 }, source: opened.source });
  opened.deliver({ origin: opened.origin, data: { kind: "oxidevm-preview-sites-applied", session: opened.session, revision: 1 }, source: keeperSource().source });
  opened.from({ kind: "oxidevm-preview-sites-applied", session: "0".repeat(32), revision: 1 });
  opened.from({ kind: "oxidevm-preview-sites-applied", session: opened.session, revision: 2 });
  opened.from({ kind: "oxidevm-preview-sites-applied", session: opened.session, revision: "1" });
  opened.from({ kind: "oxidevm-preview-sites-applied", session: opened.session, revision: 1, extra: true });
  opened.from({ kind: "oxidevm-preview-sites-refused", session: opened.session, revision: 1, reason: "denied" });
  opened.from({ kind: "oxidevm-preview-sites-refused", session: opened.session, revision: 1 });
  expect(await settlement(opened.opening)).toBe("pending");
  opened.applied(1);
  await expect(opened.opening).resolves.toMatchObject({ url: new URL(`${opened.origin}/`) });
  expect(opened.closed()).toBe(0);
});

it("setSiteAccess revisions increase", async () => {
  const { handle, session, applied, sitesPosts } = await openHandle();
  const first = handle.setSiteAccess({ kind: "sites", sites: ["a.example"] });
  const second = handle.setSiteAccess({ kind: "any" });
  // Both go out at once; the worker keeps the highest revision, so the last call wins.
  expect(sitesPosts().map(reply => reply.message)).toEqual([
    { kind: "oxidevm-preview-sites", session, revision: 1, access: { kind: "sites", sites: ["a.example"] } },
    { kind: "oxidevm-preview-sites", session, revision: 2, access: { kind: "any" } },
  ]);
  applied(2);
  applied(1);
  await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  // The access in force is not posted again; revoking it to none is.
  await handle.setSiteAccess({ kind: "any" });
  expect(sitesPosts()).toHaveLength(2);
  const revoking = handle.setSiteAccess({ kind: "none" });
  expect(sitesPosts().at(-1)?.message).toEqual({ kind: "oxidevm-preview-sites", session, revision: 3, access: { kind: "none" } });
  applied(3);
  await expect(revoking).resolves.toBeUndefined();
});

it("no reply rejects FEATURE_NOT_AVAILABLE preview-host-outdated after SITES_REPLY_MS", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // A keeper from an older preview host never answers: the opening fails and the session closes.
  const opened = siteSession(SITES);
  opened.ready();
  const failing = expect(opened.opening).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "preview-host-outdated", origin: opened.origin } });
  await vi.advanceTimersByTimeAsync(SITES_REPLY_MS - 1);
  expect(opened.closed()).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  await failing;
  expect(opened.closed()).toBe(1);
  expect(opened.retired).toEqual([opened.session]);
  expect(opened.listening()).toBe(0);
  expect(opened.posted.at(-1)?.message).toMatchObject({ type: "close-preview-session", session: opened.session });
  // On an open session only that request fails; the session stays open.
  const later = await openHandle();
  const granting = later.handle.setSiteAccess({ kind: "any" });
  const refused = expect(granting).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "preview-host-outdated", origin: later.origin } });
  await vi.advanceTimersByTimeAsync(SITES_REPLY_MS);
  await refused;
  later.applied(1);
  expect(later.closed()).toBe(0);
});

it("no reply after the keeper answered a change rejects RELAY_ERROR no-answer: the keeper takes site access", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const silence = (opened: { readonly origin: string }) => ({ code: "RELAY_ERROR", detail: { reason: "no-answer", origin: opened.origin } });
  // After an applied change.
  const applied = await openHandle();
  const first = applied.handle.setSiteAccess({ kind: "any" });
  applied.applied(1);
  await expect(first).resolves.toBeUndefined();
  const unanswered = expect(applied.handle.setSiteAccess({ kind: "none" })).rejects.toMatchObject(silence(applied));
  await vi.advanceTimersByTimeAsync(SITES_REPLY_MS);
  await unanswered;
  // After a refused change.
  const refused = await openHandle();
  const refusing = expect(refused.handle.setSiteAccess({ kind: "any" })).rejects.toMatchObject({ code: "RELAY_ERROR", detail: { reason: "no-worker" } });
  refused.refused(1, "no-worker");
  await refusing;
  const lost = expect(refused.handle.setSiteAccess({ kind: "any" })).rejects.toMatchObject(silence(refused));
  await vi.advanceTimersByTimeAsync(SITES_REPLY_MS);
  await lost;
  // After the sites a session opened with applied.
  const opened = siteSession(SITES);
  opened.ready();
  opened.applied(1);
  const handle = await opened.opening;
  const later = expect(handle.setSiteAccess({ kind: "any" })).rejects.toMatchObject(silence(opened));
  await vi.advanceTimersByTimeAsync(SITES_REPLY_MS);
  await later;
  // A late answer, for a change that already failed as outdated, also shows that the keeper takes site access.
  const late = await openHandle();
  const outdated = expect(late.handle.setSiteAccess({ kind: "any" })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "preview-host-outdated" } });
  await vi.advanceTimersByTimeAsync(SITES_REPLY_MS);
  await outdated;
  late.applied(1);
  const afterLate = expect(late.handle.setSiteAccess({ kind: "none" })).rejects.toMatchObject(silence(late));
  await vi.advanceTimersByTimeAsync(SITES_REPLY_MS);
  await afterLate;
  // Answers that do not come from the session's keeper prove nothing.
  const forged = await openHandle();
  forged.deliver({ origin: forged.origin, data: { kind: "oxidevm-preview-sites-applied", session: forged.session, revision: 1 }, source: keeperSource().source });
  forged.deliver({ origin: "https://evil.test", data: { kind: "oxidevm-preview-sites-applied", session: forged.session, revision: 1 }, source: forged.source });
  const stillOutdated = expect(forged.handle.setSiteAccess({ kind: "any" })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "preview-host-outdated" } });
  await vi.advanceTimersByTimeAsync(SITES_REPLY_MS);
  await stillOutdated;
});

it("refusals map to typed errors", async () => {
  const { handle, refused, sitesPosts } = await openHandle();
  const cases = [["stale", "PROTOCOL_ERROR"], ["retired", "ABORTED"], ["no-worker", "RELAY_ERROR"]] as const;
  for (const [index, [reason, code]] of cases.entries()) {
    const granting = handle.setSiteAccess({ kind: "any" });
    refused(index + 1, reason);
    await expect(granting).rejects.toMatchObject({ code, detail: { reason } });
  }
  // A refused access was never applied, so asking for it again posts the next revision.
  expect(sitesPosts().map(reply => reply.message)).toMatchObject([{ revision: 1 }, { revision: 2 }, { revision: 3 }]);
  // At open, a refusal fails the opening and closes the session.
  const opened = siteSession(SITES);
  opened.ready();
  opened.refused(1, "retired");
  await expect(opened.opening).rejects.toMatchObject({ code: "ABORTED", detail: { reason: "retired" } });
  expect(opened.closed()).toBe(1);
});

it("an invalid access rejects INVALID_ARGUMENT before posting", async () => {
  const { host, opened } = keeperHost();
  const { posted, network } = fakeNetwork();
  let opening: Promise<unknown> | undefined;
  expect(() => { opening = openPreviewSession({ isolation: "per-session", previewOrigin: new URL("https://oxidevm-preview.test:4573"), runtime: "userspace", port: 3000, network, host,
    siteAccess: { kind: "sites", sites: ["localhost"] } }); }).not.toThrow();
  await expect(opening).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(opened).toEqual([]);
  expect(posted).toEqual([]);
  const { handle, sitesPosts } = await openHandle();
  const extraKey = { kind: "any" as const, sites: ["a.example"] };
  const invalid: readonly PreviewSiteAccess[] = [{ kind: "sites", sites: ["127.0.0.1"] }, { kind: "sites", sites: Array.from({ length: 65 }, (_, index) => `s${String(index)}.example`) }, extraKey];
  for (const access of invalid) {
    let result: Promise<void> | undefined;
    expect(() => { result = handle.setSiteAccess(access); }).not.toThrow();
    await expect(result).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  }
  expect(sitesPosts()).toEqual([]);
});

it("setSiteAccess after close rejects ABORTED", async () => {
  const { handle, sitesPosts } = await openHandle();
  const pending = handle.setSiteAccess({ kind: "any" });
  await handle.close();
  await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  await expect(handle.setSiteAccess({ kind: "sites", sites: ["a.example"] })).rejects.toMatchObject({ code: "ABORTED" });
  expect(sitesPosts()).toHaveLength(1);
});

it("a cancelled setSiteAccess rejects ABORTED, and its access is posted again", async () => {
  const { handle, applied, sitesPosts } = await openHandle();
  await expect(handle.setSiteAccess({ kind: "any" }, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "ABORTED" });
  expect(sitesPosts()).toEqual([]);
  const controller = new AbortController();
  const granting = handle.setSiteAccess({ kind: "any" }, { signal: controller.signal });
  controller.abort();
  await expect(granting).rejects.toMatchObject({ code: "ABORTED" });
  // The cancelled revision's outcome is unknown, so the same access goes out again.
  applied(1);
  const again = handle.setSiteAccess({ kind: "any" });
  expect(sitesPosts().map(reply => reply.message)).toMatchObject([{ revision: 1 }, { revision: 2 }]);
  applied(2);
  await expect(again).resolves.toBeUndefined();
});

it("setSiteAccess rejects RELAY_ERROR instead of throwing when the keeper cannot be posted to", async () => {
  const keeper = keeperSource();
  const unreachable = { replies: keeper.replies, source: { identity: keeper.source.identity, postMessage: (message: unknown, options: { readonly targetOrigin: string; readonly transfer: Transferable[] }) => {
    if (kindOf(message) === "oxidevm-preview-sites") throw new DOMException("The keeper is gone", "InvalidStateError");
    keeper.source.postMessage(message, options);
  } } };
  const opened = siteSession(undefined, unreachable);
  opened.ready();
  const handle = await opened.opening;
  let result: Promise<void> | undefined;
  expect(() => { result = handle.setSiteAccess({ kind: "any" }); }).not.toThrow();
  await expect(result).rejects.toMatchObject({ code: "RELAY_ERROR", detail: { origin: opened.origin } });
});
