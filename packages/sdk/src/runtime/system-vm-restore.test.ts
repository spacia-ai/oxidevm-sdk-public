import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootedManagedVm, ScriptedWorker } from "./system-vm.test-support.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));

const SNAPSHOT = { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-02T10:00:00.000Z" };

describe("system VM in-session restore", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://ide.example.test/"));
  });

  afterEach(() => {
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("keeps a managed VM running and managed after an in-session restore", async () => {
    const vm = await bootedManagedVm();
    const control = ScriptedWorker.named("oxidevm-control");

    await vm.restore(SNAPSHOT);

    // The resumed agent is greeted without waiting for a READY it will not send again, and the
    // guest's paused clock is stepped to the host's and its entropy reseeded. A chosen restore
    // point brings its own files back, so the workspace store's later files are not carried in:
    // only resuming where the user left off reconciles the workspace.
    expect(control.operations).toEqual([
      "stop-system",
      "restore",
      "start-system",
      "wait-agent",
      "agent-refresh-guest",
    ]);
    await expect(vm.spawn({ command: "true" })).resolves.toMatchObject({ pid: 7 });
    await vm.dispose();
    expect(control.operations).toContain("agent-sync-workspace");
  });

  it("keeps the VM running when a restore is refused before it replaces the machine", async () => {
    ScriptedWorker.restore = "refused";
    const vm = await bootedManagedVm();
    const control = ScriptedWorker.named("oxidevm-control");

    await expect(vm.restore(SNAPSHOT)).rejects.toMatchObject({ code: "SNAPSHOT_VERSION" });

    expect(control.operations).toEqual(["stop-system", "restore", "start-system", "wait-agent"]);
    await expect(vm.spawn({ command: "true" })).resolves.toMatchObject({ pid: 7 });
    await vm.dispose();
  });

  it("treats a restored guest whose clock cannot be set like an agent that did not answer", async () => {
    ScriptedWorker.refresh = "fails";
    const vm = await bootedManagedVm();

    await expect(vm.restore(SNAPSHOT)).rejects.toMatchObject({ code: "GUEST_CRASH", detail: { reason: "clock-not-set" } });

    await expect(vm.spawn({ command: "true" })).rejects.toMatchObject({ code: "GUEST_CRASH" });
    await vm.dispose();
  });

  it("reports a restore that lost the machine instead of keeping a dead VM managed", async () => {
    ScriptedWorker.restore = "lost";
    const vm = await bootedManagedVm();
    const control = ScriptedWorker.named("oxidevm-control");

    await expect(vm.restore(SNAPSHOT)).rejects.toMatchObject({ code: "STORAGE_ERROR" });

    await expect(vm.spawn({ command: "true" })).rejects.toMatchObject({
      code: "STORAGE_ERROR",
      message: "restored RAM chunk is invalid",
    });
    await vm.dispose();
    expect(control.operations).not.toContain("agent-sync-workspace");
  });
});

it("updates the active signed image and workspace base after a cross-image restore", async () => {
  vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("location", new URL("https://ide.example.test/"));
  const vm = await bootedManagedVm();
  const identity = { id: "alpine", version: "2026.10.01", mode: "system", cpuProfile: "x86-64-v2", manifestSHA256: "b".repeat(64), keyId: "test", signatureVerified: true };
  ScriptedWorker.answers.set("current-system-image", () => { throw new Error("Storage disappeared after publication"); });
  ScriptedWorker.answers.set("restore", () => ({ newerFilesDropped: false, appData: null, consoleTail: new Uint8Array(), processes: [],
    systemImage: { id: identity.id, version: identity.version, identity, workspaceBaseSha256: "b".repeat(64),
      runtimes: { alpine: "3.24", node: "24.18.1", bun: "1.3.14", next: "16.2.12" } } }));
  try {
    await vm.restore(SNAPSHOT);
    expect(vm.imageIdentity).toEqual(identity);
    expect(ScriptedWorker.named("oxidevm-storage").operations).not.toContain("current-system-image");
    await vm.dispose();
    expect(ScriptedWorker.named("oxidevm-control").inputs).toContainEqual(expect.objectContaining({ type: "agent-sync-workspace", workspaceBaseSha256: "b".repeat(64) }));
  } finally { ScriptedWorker.reset(); vi.unstubAllGlobals(); }
});
