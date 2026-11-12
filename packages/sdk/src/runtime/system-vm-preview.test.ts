import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BlockedPreviewSite, PreviewSiteAccess } from "../contracts.js";
import { blockedSiteReport, stubPageWindow } from "../preview-blocked-sites.test-support.js";
import type * as PreviewSession from "./preview-session.js";
import type { PreviewSessionHandle, PreviewSessionOptions } from "./preview-session.js";
import { createAdvancedTestVM as createSystemRuntimeVM } from "./system-vm.test-support.js";
import { ScriptedWorker } from "./system-vm.test-support.js";
import type { RuntimeVMOptions } from "./vm-types.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));

/** The sessions the VM asked for, each open at once, and the site access their handles were given. */
const preview = vi.hoisted(() => {
  const state: {
    opened: PreviewSessionOptions[];
    granted: { readonly access: PreviewSiteAccess; readonly signal: AbortSignal | undefined }[];
    close?: () => Promise<void>;
  } = { opened: [], granted: [] };
  return state;
});

vi.mock("./preview-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PreviewSession>();
  return {
    ...actual,
    openPreviewSession: (options: PreviewSessionOptions): Promise<PreviewSessionHandle> => {
      preview.opened.push(options);
      const handle: PreviewSessionHandle = { url: new URL("http://0123456789abcdef0123456789abcdef.localhost:5174/"), close: () => preview.close?.() ?? Promise.resolve(),
        setSiteAccess: (access, request) => { preview.granted.push({ access, signal: request?.signal }); return Promise.resolve(); } };
      return Promise.resolve(handle);
    },
  };
});

const MANIFEST = "https://images.example.test/alpine/manifest.json";
const ASSISTANCE = { executionOrigin: "https://execution.example.test", manifestUrl: "https://execution.example.test/manifest.json" };

function vm(extra: Partial<Extract<RuntimeVMOptions, { mode: "system" }>> = {}) {
  return createSystemRuntimeVM({
    mode: "system", workspaceId: "system-preview", memoryMiB: 256, vcpus: 1, network: "local", previewOrigin: "http://localhost:5174", ...extra,
  });
}

describe("System previews", () => {
  beforeEach(() => {
    preview.opened.length = 0;
    preview.granted.length = 0;
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://ide.example.test/"));
    ScriptedWorker.answers.set("snapshot-resume-candidates", () => []);
    ScriptedWorker.answers.set("snapshot-list", () => []);
  });

  afterEach(() => {
    delete preview.close;
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("opens a preview through the network link of a managed boot, with no assistance", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    const system = await vm();
    await system.bootManagedImage(MANIFEST);
    const handle = await system.exposePort(3000);
    expect(handle.url.hostname).toBe("0123456789abcdef0123456789abcdef.localhost");
    expect(preview.opened).toMatchObject([{ runtime: "system", port: 3000 }]);
  });

  it("opens a preview on the constrained MessagePort link", async () => {
    vi.stubGlobal("crossOriginIsolated", false);
    const system = await vm();
    await system.bootManagedImage(MANIFEST);
    await system.exposePort(3000);
    expect(preview.opened).toMatchObject([{runtime:"system",port:3000}]);
  });

  it("exposePort forwards siteAccess and the handle forwards setSiteAccess", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    const system = await vm();
    await system.bootManagedImage(MANIFEST);
    const siteAccess: PreviewSiteAccess = { kind: "any" };
    const handle = await system.exposePort(3000, { siteAccess });
    await system.exposePort(4000);
    expect(preview.opened[0]?.siteAccess).toBe(siteAccess);
    expect(preview.opened[1]).not.toHaveProperty("siteAccess");
    const controller = new AbortController();
    await handle.setSiteAccess({ kind: "sites", sites: ["api.example.com"] }, { signal: controller.signal });
    expect(preview.granted).toEqual([{ access: { kind: "sites", sites: ["api.example.com"] }, signal: controller.signal }]);
  });

  /** A VM whose managed boot started the network link, and the window that frames its previews. */
  async function linkedVM() {
    vi.stubGlobal("crossOriginIsolated", true);
    const system = await vm();
    await system.bootManagedImage(MANIFEST);
    return { system, page: stubPageWindow() };
  }

  it("a diagnostics preview handle reports blocked sites from its own session origin", async () => {
    const { system, page } = await linkedVM();
    const handle = await system.exposePort(3000), seen: BlockedPreviewSite[] = [], controller = new AbortController();
    const watching = handle.watchBlockedSites(blocked => { seen.push(blocked); }, { signal: controller.signal });
    page.post("http://fedcba9876543210fedcba9876543210.localhost:5174", blockedSiteReport("api.example.com"));
    page.post(handle.url.origin, blockedSiteReport("api.example.com", "font"));
    page.post(handle.url.origin, blockedSiteReport("api.example.com"));
    expect(seen).toEqual([{ site: "api.example.com", directive: "font" }]);
    controller.abort();
    await expect(watching).resolves.toBeUndefined();
  });

  it("a diagnostics preview handle's watch ends on abort, close and dispose", async () => {
    const { system, page } = await linkedVM();
    const handle = await system.exposePort(3000), controller = new AbortController();
    const aborted = handle.watchBlockedSites(() => {}, { signal: controller.signal });
    controller.abort();
    expect(page.listeners.size).toBe(0);
    await expect(aborted).resolves.toBeUndefined();
    const closing = handle.watchBlockedSites(() => {}, { signal: new AbortController().signal });
    await handle.close();
    expect(page.listeners.size).toBe(0);
    await expect(closing).resolves.toBeUndefined();
    const other = await system.exposePort(4000);
    const disposing = other.watchBlockedSites(() => {}, { signal: new AbortController().signal });
    expect(page.listeners.size).toBe(1);
    const disposal = system.dispose();
    // Disposal ends the watch at once, before it closes the VM's previews.
    expect(page.listeners.size).toBe(0);
    // Until it closed them, a new watch is refused as on a disposed VM; afterwards, as on a closed handle.
    const refused = expect(other.watchBlockedSites(() => {}, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await expect(disposing).resolves.toBeUndefined();
    await refused;
    await disposal;
    await expect(other.watchBlockedSites(() => {}, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("a diagnostics preview handle refuses a watch after close and bad arguments", async () => {
    const { system } = await linkedVM();
    const handle = await system.exposePort(3000), signal = new AbortController().signal;
    // @ts-expect-error a watch needs options with exactly an AbortSignal
    await expect(handle.watchBlockedSites(() => {}, {})).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    // @ts-expect-error the listener must be a function
    await expect(handle.watchBlockedSites("listener", { signal })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await handle.close();
    await expect(handle.watchBlockedSites(() => {}, { signal })).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("refuses a preview before a managed boot started the link", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    const system = await vm();
    await expect(system.exposePort(3000)).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "no-network-link" } });
  });

  it("keeps the assisted path when there is no link but assistance is configured", async () => {
    vi.stubGlobal("crossOriginIsolated", false);
    ScriptedWorker.answers.set("assistance-network-attach", () => undefined);
    const system = await vm({ assistance: ASSISTANCE });
    await system.exposePort(3000);
    expect(preview.opened).toMatchObject([{ runtime: "system", port: 3000 }]);
  });

  it("terminates every worker even when preview cleanup fails", async () => {
    ScriptedWorker.answers.set("assistance-network-attach", () => undefined);
    preview.close = () => Promise.reject(new Error("preview close failed"));
    const system = await vm({ assistance: ASSISTANCE });
    await system.exposePort(3000);
    const terminated = ScriptedWorker.instances.map(worker => vi.spyOn(worker, "terminate"));
    await expect(system.dispose()).rejects.toThrow("preview close failed");
    for (const termination of terminated) expect(termination).toHaveBeenCalled();
  });
});
