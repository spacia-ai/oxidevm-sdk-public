import { afterEach, describe, expect, it, vi } from "vitest";
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
