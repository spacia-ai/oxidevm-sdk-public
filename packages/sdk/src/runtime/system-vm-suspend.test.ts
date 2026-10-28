import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VMError } from "./errors.js";
import { createRuntimeVM } from "./index.js";
import type { SnapshotInfo } from "./protocol.js";
import { bootedManagedVm, ScriptedWorker } from "./system-vm.test-support.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));
vi.mock("./userspace-process.js", async () => {
  const { nativeBackend } = await import("./userspace-vm.test-support.js");
  return { UserspaceProcessBackend: { create: () => Promise.resolve(nativeBackend()) } };
});

const SAVED: SnapshotInfo = {
  mode: "system",
  ref: { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-03T10:00:00.000Z" },
  kind: "safety",
  label: "Before Userspace",
  capturedAtUnixMs: 1_790_000_000_000,
  profile: { id: "alpine", version: "2026.10.02" },
  bytes: { ram: 0, disk: 0, unique: 0 },
  resumable: true,
};

describe("suspending a system VM for a mode switch", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://ide.example.test/"));
    ScriptedWorker.answers.set("snapshot", () => SAVED.ref);
    ScriptedWorker.answers.set("snapshot-list", () => [SAVED]);
  });

  afterEach(() => {
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("writes the workspace out before the save, so the save records it, then disposes without writing it again", async () => {
    const vm = await bootedManagedVm();
    const control = ScriptedWorker.named("oxidevm-control");
    // The page shows the console in an execution of its own, and reads it while the VM saves.
    await vm.diagnostics.startSystem();
    control.operations.length = 0;

    const saved = await vm.suspend({ label: "Before Userspace" });
    await vm.dispose();

    expect(saved).toEqual(SAVED);
    // An automatic save, as where the VM left off: it does not push a reset's or a restore's safety point out.
    const saves = control.inputs.filter((input) => input["type"] === "snapshot");
    expect(saves).toMatchObject([{ label: "Before Userspace" }]);
    expect(saves[0]).not.toHaveProperty("kind");
    // The page's execution runs the guest through the flush and the save; disposal then stops it.
    expect(control.operations).toEqual(["assistance-dispose", "agent-sync-workspace", "snapshot", "assistance-dispose", "stop-system", "dispose"]);
    expect(ScriptedWorker.named("oxidevm-storage").operations).toContain("dispose");
  });

  it("leaves the VM running when the save is refused", async () => {
    ScriptedWorker.answers.set("snapshot", () => {
      throw new VMError("QUOTA_EXCEEDED", "the browser has no room");
    });
    const vm = await bootedManagedVm();
    const execution = await vm.diagnostics.startSystem();
    const control = ScriptedWorker.named("oxidevm-control");
    control.operations.length = 0;

    await expect(vm.suspend({ label: "Before Userspace" })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

    // The page's console execution was neither stopped nor replaced, and nothing was disposed.
    expect(control.operations).toEqual(["assistance-dispose", "agent-sync-workspace", "snapshot"]);
    expect(ScriptedWorker.named("oxidevm-storage").operations).not.toContain("dispose");
    await vm.dispose();
    await expect(execution.exit).resolves.toMatchObject({ kind: "halted" });
  });

  it("refuses a name a restore point cannot have before writing anything out", async () => {
    const vm = await bootedManagedVm();
    const control = ScriptedWorker.named("oxidevm-control");

    await expect(vm.suspend({ label: " " })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    expect(control.operations).toEqual([]);
  });

  it("refuses a VM that runs no managed image: there is nothing to resume", async () => {
    const { createSystemRuntimeVM } = await import("./system-vm.js");
    const vm = await createSystemRuntimeVM({ mode: "system", workspaceId: "idle", memoryMiB: 256, vcpus: 1, network: "local" });

    await expect(vm.suspend({ label: "Before Userspace" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    expect(ScriptedWorker.named("oxidevm-control").operations).not.toContain("agent-sync-workspace");
  });

  it("refuses a native VM before it starts a managed session", async () => {
    const vm = await createRuntimeVM({ mode: "userspace", workspaceId: "userspace", memoryMiB: 256, network: "local" });

    await expect(vm.suspend({ label: "Before System" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "not-running" } });
    await vm.dispose();
  });
});

for (const fail of [false, true]) it(`native suspend ${fail ? "retains the running session after failed capture" : "flushes, saves and releases the workspace"}`, async () => {
  vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("location", new URL("https://ide.example.test/"));
  const { bootedNativeVm } = await import("./userspace-vm.test-support.js");
  const vm = await bootedNativeVm();
  const point = { ...SAVED, mode: "userspace" as const };
  ScriptedWorker.answers.set("snapshot", () => { if (fail) throw new VMError("QUOTA_EXCEEDED", "no room"); return point.ref; });
  ScriptedWorker.answers.set("snapshot-list", () => [point]);
  const control = ScriptedWorker.named("oxidevm-control"); control.operations.length = 0;
  try {
    if (fail) {
      await expect(vm.suspend({ label: "Before System" })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
      expect(ScriptedWorker.named("oxidevm-storage").operations).not.toContain("dispose");
    } else await expect(vm.suspend({ label: "Before System" })).resolves.toEqual(point);
    expect(control.operations.slice(0, 2)).toEqual(["flush-userspace", "snapshot"]);
  } finally { await vm.dispose(); ScriptedWorker.reset(); vi.unstubAllGlobals(); }
});
