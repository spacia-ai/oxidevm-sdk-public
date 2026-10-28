import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as PreviewSession from "./preview-session.js";
import type { PreviewSessionOptions } from "./preview-session.js";
import { createAdvancedTestVM as createSystemRuntimeVM } from "./system-vm.test-support.js";
import { ScriptedWorker } from "./system-vm.test-support.js";
import type { RuntimeVMOptions, PreviewHandle } from "./vm-types.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));

/** The sessions the VM asked for; each opens at once. */
const preview = vi.hoisted(() => {
  const state: { opened: PreviewSessionOptions[]; close?: () => Promise<void> } = { opened: [] };
  return state;
});

vi.mock("./preview-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PreviewSession>();
  return {
    ...actual,
    openPreviewSession: (options: PreviewSessionOptions): Promise<PreviewHandle> => {
      preview.opened.push(options);
      return Promise.resolve({ url: new URL("http://0123456789abcdef0123456789abcdef.localhost:5174/"), close: () => preview.close?.() ?? Promise.resolve() });
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
