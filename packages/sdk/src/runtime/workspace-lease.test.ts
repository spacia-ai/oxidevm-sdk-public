import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntimeVM, validateRuntimeVMOptions } from "./index.js";
import { ORIGIN_STORAGE } from "./storage-scope.js";
import { ScriptedWorker } from "./system-vm.test-support.js";
import { isEphemeralWorkspaceId, newEphemeralWorkspaceId, workspaceInUseError, workspaceLockName } from "./workspace-path.js";

vi.mock("./userspace-process.js", async () => {
  const { nativeBackend } = await import("./userspace-vm.test-support.js");
  return { UserspaceProcessBackend: { create: () => Promise.resolve(nativeBackend()) } };
});

let sequence = 0;
/** A workspace no other test uses, so locks never cross tests. */
function workspace(): string {
  sequence += 1;
  return `lease-${String(sequence)}-${Date.now().toString(36)}`;
}

/** Holds the workspace's lock, as another tab's VM does, until the returned release. */
async function hold(workspaceId: string): Promise<() => Promise<void>> {
  const held = Promise.withResolvers<undefined>();
  const granted = Promise.withResolvers<undefined>();
  const lock = navigator.locks.request(workspaceLockName(ORIGIN_STORAGE, workspaceId), async () => { granted.resolve(undefined); await held.promise; });
  await granted.promise;
  return async () => { held.resolve(undefined); await lock; };
}

function storageInitialize(): Record<string, unknown> | undefined {
  const index = ScriptedWorker.named("oxidevm-storage").operations.indexOf("initialize");
  return ScriptedWorker.named("oxidevm-storage").inputs[index];
}

describe("a diagnostics VM whose workspace another tab holds", () => {
  afterEach(() => { ScriptedWorker.reset(); vi.unstubAllGlobals(); });

  it("opens a new temporary workspace when the page asks for one", async () => {
    vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("location", new URL("https://ide.example.test/"));
    const id = workspace();
    const release = await hold(id);
    try {
      const vm = await createRuntimeVM({ mode: "userspace", workspaceId: id, memoryMiB: 256, network: "local", workspaceInUse: "temporary", rootPersistence: "persistent" });
      expect(isEphemeralWorkspaceId(vm.workspace.id)).toBe(true);
      expect(storageInitialize()).toMatchObject({ workspaceId: vm.workspace.id, ephemeral: true });
      await vm.dispose();
    } finally { await release(); }
  });

  it("opens the durable workspace once it is free, and keeps failing without the option", async () => {
    vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("location", new URL("https://ide.example.test/"));
    const id = workspace();
    const vm = await createRuntimeVM({ mode: "system", workspaceId: id, memoryMiB: 256, vcpus: 1, network: "local", workspaceInUse: "temporary" });
    expect(vm.workspace.id).toBe(id);
    await vm.dispose();
    ScriptedWorker.reset();
    vi.stubGlobal("Worker", ScriptedWorker);
    ScriptedWorker.answers.set("initialize", () => { throw workspaceInUseError(id); });
    await expect(createRuntimeVM({ mode: "system", workspaceId: id, memoryMiB: 256, vcpus: 1, network: "local" })).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "workspace-in-use" } });
  });

  it("rejects the option on an ephemeral workspace and any other value", async () => {
    await expect(createRuntimeVM({ mode: "userspace", workspaceId: newEphemeralWorkspaceId(), memoryMiB: 256, network: "local", ephemeral: true, workspaceInUse: "temporary" }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(() => validateRuntimeVMOptions({ mode: "userspace", workspaceId: workspace(), memoryMiB: 256, network: "local", workspaceInUse: "share" }))
      .toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
});
