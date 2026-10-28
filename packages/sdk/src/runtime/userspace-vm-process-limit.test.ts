import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as EngineAssets from "../engine-assets.js";
import type { LoadedEngineAssets } from "../engine-assets.js";
import { createVM, defineImage } from "../index.js";
import { legacyImageLocations } from "../default-images.test-support.js";
import { record } from "./decode.js";
import { createRuntimeVM } from "./index.js";
import { decodeUserspaceRequest } from "./userspace-protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { ScriptedWorker } from "./system-vm.test-support.js";
import { configureMountedRuntime, mountSettings } from "./workers/userspace-settings.js";

/** Every initialize request a VM sent to its Userspace worker; creation stops right after it. */
const sent = vi.hoisted(() => ({ requests: new Array<unknown>(), stop: new Error("stopped after the Userspace initialize request") }));

vi.mock("./userspace-process.js", () => ({
  UserspaceProcessBackend: {
    create: (options: unknown) => { sent.requests.push(options); return Promise.reject(sent.stop); },
  },
}));
vi.mock("../verified-image.js", async () => {
  const { decodeSHA256 } = await import("../values.js");
  return {
    verifyImage: () => Promise.resolve({
      info: { id: "limits", version: "1", mode: "userspace", manifestSHA256: decodeSHA256("a".repeat(64), "test manifest"), cpuProfile: "x86-64-v3", signatureVerified: true, keyId: "test" },
      memoryMiB: 256,
    }),
  };
});
vi.mock("../license-admission.js", () => ({ admitLicense: () => Promise.resolve({ tier: "development" }) }));
vi.mock("../engine-assets.js", async importOriginal => ({
  ...await importOriginal<typeof EngineAssets>(),
  loadEngineAssets: (): Promise<LoadedEngineAssets> => Promise.resolve({ urls: new Map([["oxidevm_userspace.wasm", "blob:oxidevm_userspace.wasm"]]), compile: () => Promise.resolve(new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))), dispose: () => undefined }),
}));

/** The engine exports the Userspace worker calls to configure a runtime it mounts for `request`. */
function mountCalls(request: unknown): (string | number)[][] {
  const decoded = decodeUserspaceRequest({ ...record(request, "initialize request"), id: 1, version: PROTOCOL_VERSION, type: "initialize" });
  if (decoded.type !== "initialize") throw new Error("expected an initialize request");
  const calls: (string | number)[][] = [];
  const exports = Object.fromEntries(["oxidevm_userspace_process_limit", "oxidevm_userspace_configure_initial_user", "oxidevm_userspace_syscall_trace_configure", "oxidevm_userspace_network_enable"]
    .map(name => [name, (...args: number[]) => { calls.push([name, ...args]); return 0; }]));
  configureMountedRuntime({ exports: { ...exports,
    oxidevm_userspace_jit_configure: () => 0,
    oxidevm_userspace_jit_tier: () => 1,
  } }, mountSettings(decoded), false);
  return calls;
}
function closePorts(request: unknown): void {
  for (const value of Object.values(record(request, "initialize request"))) if (value instanceof MessagePort) value.close();
}

describe("the Userspace live-process limit", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://app.example.test/"));
    vi.stubGlobal("crossOriginIsolated", false);
  });
  afterEach(() => {
    for (const request of sent.requests.splice(0)) closePorts(request);
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("is left to the engine's own cap when diagnostics createRuntimeVM sets none", async () => {
    await expect(createRuntimeVM({ mode: "userspace", workspaceId: "limits", memoryMiB: 256, network: "local" })).rejects.toBe(sent.stop);
    expect(sent.requests).toHaveLength(1);
    expect(sent.requests[0]).not.toHaveProperty("maxProcesses");
    expect(mountCalls(sent.requests[0])).toEqual([["oxidevm_userspace_configure_initial_user", 0]]);
  });

  it("is the diagnostics caller's explicit limit when it sets one", async () => {
    await expect(createRuntimeVM({ mode: "userspace", workspaceId: "limits", memoryMiB: 256, network: "local", limits: { maxProcesses: 8 } })).rejects.toBe(sent.stop);
    expect(mountCalls(sent.requests[0])).toEqual([["oxidevm_userspace_process_limit", 8], ["oxidevm_userspace_configure_initial_user", 0]]);
  });

  it("keeps the public createVM default of 32", async () => {
    await expect(createVM({ mode: "userspace", image: defineImage(legacyImageLocations.userspace), commandInterceptors: "off" })).rejects.toBe(sent.stop);
    expect(mountCalls(sent.requests[0])).toEqual([["oxidevm_userspace_process_limit", 32], ["oxidevm_userspace_configure_initial_user", 0]]);
  });
});
