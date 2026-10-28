import { afterEach, expect, it, vi } from "vitest";
import { isPreviewSessionOrigin, openPreviewSession, sessionOrigin, sharedSessionOrigin } from "./preview-session.js";
import type { KeeperMessage, KeeperSource, PreviewKeeperHost } from "./preview-keeper.js";
import { PROTOCOL_VERSION } from "./protocol.js";

const ports: MessagePort[] = [];
afterEach(() => { for (const port of ports.splice(0)) port.close(); });

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
