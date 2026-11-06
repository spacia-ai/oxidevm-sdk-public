import { afterEach, describe, expect, it, vi } from "vitest";
import { record } from "../decode.js";
import type { NetworkState } from "../network-types.js";
import type { RelayScope } from "../protocol/network.js";
import { RelayConnectionOwner } from "./network-connection.js";

const adapter = { setRelay: vi.fn(() => Promise.resolve()) };
const scope = { workspaceId: "workspace", origin: "https://app.example", workspaceName: "My project" };
describe("relay lifecycle owner", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
  it("starts off, discovers only on connect, and reports generic fetch failures without inventing a permission denial", async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", fetch);
    const owner = new RelayConnectionOwner(scope, adapter);
    expect(owner.state).toEqual({ kind: "off" }); expect(fetch).not.toHaveBeenCalled();
    await expect(owner.connect({ kind: "personal" }, new AbortController().signal)).rejects.toMatchObject({ detail: { reason: "discovery-failed" } });
    expect(owner.state).toEqual({ kind: "failed", reason: "discovery-failed" });
    await owner.disconnect(); await owner.disconnect(); expect(owner.state).toEqual({ kind: "off" });
  });
  it("clears failed attempts so a second explicit attempt reaches discovery again", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({version:1,kind:"personal",capabilities:[]}), {status:200})));
    vi.stubGlobal("fetch", fetch); const owner = new RelayConnectionOwner(scope, adapter);
    await expect(owner.connect({ kind: "personal" }, new AbortController().signal)).rejects.toMatchObject({ detail: { reason: "version-mismatch" } });
    await expect(owner.connect({ kind: "personal" }, new AbortController().signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("cancels pending discovery and completes cleanup before disconnect resolves", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {once:true});
    })));
    const owner = new RelayConnectionOwner(scope, adapter);
    const pending = owner.connect({kind:"personal"}, new AbortController().signal);
    const failure = expect(pending).rejects.toMatchObject({code:"ABORTED"});
    await owner.disconnect(); await failure;
    expect(owner.state).toEqual({kind:"off"}); expect(adapter.setRelay).toHaveBeenCalledWith(undefined, expect.any(Number));
  });
  it("decodes malformed JSON as a protocol failure and browser timeouts as timeouts", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{not JSON", {status:200}));
    vi.stubGlobal("fetch", fetch);
    const owner = new RelayConnectionOwner(scope, adapter);
    await expect(owner.connect({kind:"personal"}, new AbortController().signal)).rejects.toMatchObject({detail:{reason:"protocol-error"}});
    fetch.mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    await expect(owner.connect({kind:"server",url:"https://relay.example/",sessionUrl:"https://app.example/api/session"}, new AbortController().signal)).rejects.toMatchObject({detail:{reason:"timed-out"}});
  });
  it("accepts ordinary application authorization denials without requiring a relay error body", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, {status:403}))));
    const owner = new RelayConnectionOwner(scope, adapter);
    await expect(owner.connect({kind:"server",url:"https://relay.example/",sessionUrl:"https://app.example/api/session"}, new AbortController().signal)).rejects.toMatchObject({detail:{reason:"authentication-failed"}});
    expect(owner.state).toEqual({kind:"failed",reason:"authentication-failed"});
  });
});

// The runtime frame (ADR 0021) reaches relays with its own origin for every page that embeds it.
const FRAME = "https://run.oxidevm.dev";
interface Sent { readonly url: string; readonly init: RequestInit | undefined }
function href(input: RequestInfo | URL): string { return input instanceof URL ? input.href : typeof input === "string" ? input : input.url; }
function body(sent: Sent | undefined): Readonly<Record<string, unknown>> {
  const text = sent?.init?.body;
  if (typeof text !== "string") throw new Error("expected a JSON request body");
  return record(JSON.parse(text), "request body");
}
/** A personal relay that captures the frame's origin, as browsers send it, and never decides a pairing. */
function personalRelay(origin: string): { readonly sent: Sent[]; readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> } {
  const sent: Sent[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(href(input)); sent.push({url: url.href, init});
    if (url.pathname === "/v2/health") return Promise.resolve(new Response(JSON.stringify({version:2,kind:"personal",capabilities:["tcp","dns","https-get"]})));
    if (url.pathname === "/v2/pairings") {
      const request = body(sent.at(-1));
      return Promise.resolve(new Response(JSON.stringify({version:2,id:"a".repeat(32),poll:"b".repeat(64),code:"123456",origin,workspaceId:request["workspaceId"],workspaceName:request["workspaceName"],expiresAt:Date.now()+60_000})));
    }
    if (url.pathname.endsWith("/claim")) return Promise.resolve(new Response(JSON.stringify({version:2,kind:"pending"}), {status:202}));
    return Promise.resolve(new Response(null, {status:204}));
  };
  return {sent, fetch};
}
async function approvalRequest(owner: RelayConnectionOwner): Promise<Extract<NetworkState, {kind:"awaiting-approval"}>> {
  for (let view = owner.view; ; view = await owner.wait(view.revision, new AbortController().signal)) {
    if (view.state.kind === "awaiting-approval") return view.state;
    if (view.state.kind === "failed") throw new Error(`relay failed: ${view.state.reason}`);
  }
}
/** Starts a personal pairing, returns what the relay was asked and what the page is shown, then withdraws it. */
async function pairing(scope: RelayScope): Promise<{readonly request: Readonly<Record<string, unknown>>; readonly shown: Extract<NetworkState, {kind:"awaiting-approval"}>}> {
  const relay = personalRelay(scope.origin); vi.stubGlobal("fetch", vi.fn(relay.fetch));
  const owner = new RelayConnectionOwner(scope, adapter);
  const withdrawn = expect(owner.connect({kind:"personal"}, new AbortController().signal)).rejects.toMatchObject({code:"ABORTED"});
  const shown = await approvalRequest(owner);
  await owner.disconnect(); await withdrawn;
  return {request: body(relay.sent.find(sent => new URL(sent.url).pathname === "/v2/pairings")), shown};
}
describe("relay identity of a page that embeds the runtime frame", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
  it("names each embedding page in the workspace a personal relay asks the user to approve", async () => {
    const one = await pairing({origin:FRAME,workspaceId:"default",embedderOrigin:"https://one.example"});
    const two = await pairing({origin:FRAME,workspaceId:"default",embedderOrigin:"https://two.example"});
    expect([one.request["workspaceId"], two.request["workspaceId"]]).toEqual(["https://one.example default", "https://two.example default"]);
    expect([one.request["workspaceName"], two.request["workspaceName"]]).toEqual(["default", "default"]);
    expect(one.shown).toMatchObject({origin:FRAME,workspaceId:"https://one.example default",workspaceName:"default"});
    expect(two.shown).toMatchObject({origin:FRAME,workspaceId:"https://two.example default",workspaceName:"default"});
  });
  it("keeps a self-hosted page's own workspace ID", async () => {
    const own = await pairing({origin:"https://app.example",workspaceId:"default"});
    expect(own.request).toMatchObject({workspaceId:"default",workspaceName:"default"});
    expect(own.shown).toMatchObject({origin:"https://app.example",workspaceId:"default"});
  });
  it("sends a server relay's session request and revocation from the frame without cookies", async () => {
    const sent: Sent[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => { sent.push({url: href(input), init}); return Promise.resolve(new Response(null, {status:403})); }));
    const owner = new RelayConnectionOwner({origin:FRAME,workspaceId:"default",embedderOrigin:"https://one.example"}, adapter);
    await expect(owner.connect({kind:"server",url:"https://relay.example/",sessionUrl:"https://one.example/api/relay-session"}, new AbortController().signal)).rejects.toMatchObject({detail:{reason:"authentication-failed"}});
    expect(sent.map(request => [request.url, request.init?.credentials])).toEqual([["https://one.example/api/relay-session", "omit"], ["https://relay.example/v2/revoke", "omit"]]);
    const session = body(sent[0]);
    expect(session).toMatchObject({version:2,origin:FRAME,workspaceId:"https://one.example default"});
    expect(body(sent[1])).toEqual({workspaceId:"https://one.example default",browserSessionId:session["browserSessionId"]});
  });
  it("keeps cookies for a self-hosted page's own session route", async () => {
    const sent: Sent[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => { sent.push({url: href(input), init}); return Promise.resolve(new Response(null, {status:403})); }));
    const owner = new RelayConnectionOwner({origin:"https://app.example",workspaceId:"default"}, adapter);
    await expect(owner.connect({kind:"server",url:"https://relay.example/",sessionUrl:"https://app.example/api/relay-session"}, new AbortController().signal)).rejects.toMatchObject({detail:{reason:"authentication-failed"}});
    expect(sent.map(request => request.init?.credentials)).toEqual(["include", "include"]);
    expect(body(sent[0])).toMatchObject({origin:"https://app.example",workspaceId:"default"});
  });
  it("refuses, before contacting a relay, a page origin and workspace ID longer than a relay workspace identity", async () => {
    // spec/relay/v2.md: a workspace identity is at most 256 characters. "https://" + host + " default" with this host is 257.
    const host = `${["a","b","c"].map(letter => letter.repeat(63)).join(".")}.${"d".repeat(41)}.example`;
    const fetch = vi.fn(() => Promise.reject(new TypeError("must not be contacted"))); vi.stubGlobal("fetch", fetch);
    const owner = new RelayConnectionOwner({origin:FRAME,workspaceId:"default",embedderOrigin:`https://${host}`}, adapter);
    expect(`https://${host} default`).toHaveLength(257);
    await expect(owner.connect({kind:"personal"}, new AbortController().signal)).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
    expect(fetch).not.toHaveBeenCalled(); expect(owner.state).toEqual({kind:"off"});
    const longest = await pairing({origin:FRAME,workspaceId:"defaul",embedderOrigin:`https://${host}`});
    expect(longest.request["workspaceId"]).toHaveLength(256);
  });
});
