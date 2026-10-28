import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VMError } from "./errors.js";
import { FRAME_BRIDGE_TOTAL_BYTES } from "./frame-bridge.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { createSystemRuntimeVM } from "./system-vm.js";
import { BrowserAssistance } from "./browser-assistance.js";
import { ScriptedWorker } from "./system-vm.test-support.js";
import type { RuntimeVMOptions } from "./vm-types.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));

const MANIFEST = "https://images.example.test/alpine/manifest.json";
const ASSISTANCE = { executionOrigin: "https://execution.example.test", manifestUrl: "https://execution.example.test/manifest.json" };

function control(): ScriptedWorker {
  return ScriptedWorker.named("oxidevm-control");
}

function network(): ScriptedWorker {
  return ScriptedWorker.named("oxidevm-network");
}

function networkWorkers(): number {
  return ScriptedWorker.instances.filter((worker) => worker.options.name === "oxidevm-network").length;
}

function vm(extra: Partial<Extract<RuntimeVMOptions, { mode: "system" }>> = {}) {
  return createSystemRuntimeVM({ mode: "system", workspaceId: "network-link", memoryMiB: 256, vcpus: 1, network: "local", ...extra }, undefined, (control, options) => new BrowserAssistance(control, options));
}

describe("system VM network link", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://ide.example.test/"));
    vi.stubGlobal("crossOriginIsolated", true);
    ScriptedWorker.answers.set("snapshot-resume-candidates", () => []);
    ScriptedWorker.answers.set("snapshot-list", () => []);
    ScriptedWorker.answers.set("agent-reconcile-workspace", () => ({ workspace: "in-sync", unresolved: [] }));
  });

  afterEach(() => {
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("starts the network worker at a managed boot and connects control before boot-system", async () => {
    const system = await vm();
    expect(networkWorkers()).toBe(0);
    await system.bootManagedImage(MANIFEST);
    expect(network().operations).toEqual(["connect-link"]);
    const [connection] = network().messages;
    expect(connection).toMatchObject({
      version: PROTOCOL_VERSION,
      type: "connect-link",
      netstackWasmUrl: "https://ide.example.test/oxidevm_netstack.wasm",
    });
    expect(connection?.["doorbell"]).toBeInstanceOf(MessagePort);
    const bridge = connection?.["bridge"];
    expect(bridge).toBeInstanceOf(SharedArrayBuffer);
    expect(bridge instanceof SharedArrayBuffer ? bridge.byteLength : 0).toBe(FRAME_BRIDGE_TOTAL_BYTES);
    const linked = control().inputs.find((input) => input["type"] === "network-link-connect");
    expect(linked?.["bridge"]).toBe(bridge);
    expect(linked?.["doorbell"]).toBeInstanceOf(MessagePort);
    const operations = control().operations;
    expect(operations.indexOf("network-link-connect")).toBeGreaterThan(-1);
    expect(operations.indexOf("network-link-connect")).toBeLessThan(operations.indexOf("boot-system"));
  });

  it("reuses the link for a second managed boot", async () => {
    // A restart first asks the guest to write its files out; this scripted guest cannot, and the
    // restart goes ahead all the same.
    ScriptedWorker.answers.set("agent-spawn", () => {
      throw new VMError("GUEST_CRASH", "the guest agent is gone");
    });
    const system = await vm();
    await system.bootManagedImage(MANIFEST);
    await system.bootManagedImage(MANIFEST);
    expect(network().operations).toEqual(["connect-link"]);
    expect(control().operations.filter((operation) => operation === "network-link-connect")).toHaveLength(1);
  });

  it("loads the router from netstackWasmUrl when given", async () => {
    const system = await vm({ netstackWasmUrl: "/assets/router.wasm" });
    await system.bootManagedImage(MANIFEST);
    expect(network().messages[0]).toMatchObject({ netstackWasmUrl: "https://ide.example.test/assets/router.wasm" });
  });

  it("never starts the network worker for a raw diagnostics boot", async () => {
    const system = await vm();
    await system.diagnostics.bootSystem({ kernel: Uint8Array.of(1), commandLine: "console=hvc0" });
    expect(networkWorkers()).toBe(0);
    expect(control().operations).not.toContain("network-link-connect");
  });

  it("uses the bounded MessagePort link without cross-origin isolation", async () => {
    vi.stubGlobal("crossOriginIsolated", false);
    const system = await vm();
    await system.bootManagedImage(MANIFEST);
    expect(networkWorkers()).toBe(1);
    expect(network().messages[0]).toMatchObject({bridge:"message"});
    expect(control().operations).toContain("network-link-connect");
    expect(control().operations).toContain("boot-system");
  });

  it("uses one network worker for assistance and the link", async () => {
    ScriptedWorker.answers.set("assistance-network-attach", () => undefined);
    const system = await vm({ assistance: ASSISTANCE });
    expect(network().operations).toEqual(["connect-system"]);
    await system.bootManagedImage(MANIFEST);
    expect(network().operations).toEqual(["connect-system", "connect-link"]);
    expect(networkWorkers()).toBe(1);
  });

  it("rejects a managed boot whose link failed with CORE_LOAD_FAILED, and a later boot tries again", async () => {
    ScriptedWorker.answers.set("network-link-connect", () => {
      throw new VMError("CORE_LOAD_FAILED", "the network router did not start (fetch)", { component: "netstack", reason: "fetch" });
    });
    const system = await vm();
    await expect(system.bootManagedImage(MANIFEST))
      .rejects.toMatchObject({ code: "CORE_LOAD_FAILED", detail: { component: "netstack", reason: "fetch" } });
    expect(control().operations).not.toContain("boot-system");
    ScriptedWorker.answers.delete("network-link-connect");
    await system.bootManagedImage(MANIFEST);
    expect(network().operations).toEqual(["connect-link", "connect-link"]);
    expect(networkWorkers()).toBe(1);
  });

  it("tells control once when the network worker fails", async () => {
    const system = await vm();
    await system.bootManagedImage(MANIFEST);
    network().dispatchEvent(new Event("error"));
    network().dispatchEvent(new Event("messageerror"));
    await vi.waitFor(() => { expect(control().operations).toContain("network-link-failed"); });
    expect(control().operations.filter((operation) => operation === "network-link-failed")).toHaveLength(1);
  });
});
