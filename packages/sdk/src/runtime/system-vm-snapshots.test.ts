import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SnapshotInfo } from "./protocol.js";
import { bootedManagedVm, ScriptedWorker } from "./system-vm.test-support.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));

function info(sequence: number, kind: SnapshotInfo["kind"], label: string): SnapshotInfo {
  return {
    mode: "system",
    ref: { id: `123e4567-e89b-42d3-a456-42661417400${String(sequence)}`, createdAt: "2026-10-02T10:00:00.000Z" },
    kind,
    label,
    capturedAtUnixMs: 1_790_000_000_000 + sequence,
    profile: { id: "alpine", version: "2026.10.02" },
    bytes: { ram: 0, disk: 0, unique: 0 },
    resumable: true,
  };
}

const NAMED = info(1, "named", "Before upgrading Next");
const SAFETY = info(2, "safety", "Before restore");
const RESTORED = { newerFilesDropped: true, appData: null, consoleTail: new Uint8Array(), processes: [] };

function control() {
  return ScriptedWorker.named("oxidevm-control");
}

function storage() {
  return ScriptedWorker.named("oxidevm-storage");
}

describe("system VM restore points", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://ide.example.test/"));
    ScriptedWorker.answers.set("snapshot-list", () => [SAFETY, NAMED]);
    ScriptedWorker.answers.set("restore", () => RESTORED);
  });

  afterEach(() => {
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("saves a named restore point and returns it as the catalogue lists it", async () => {
    ScriptedWorker.answers.set("snapshot", () => NAMED.ref);
    const vm = await bootedManagedVm();

    await expect(vm.snapshots.capture({ label: "Before upgrading Next" })).resolves.toEqual(NAMED);

    expect(control().inputs.filter((input) => input["type"] === "snapshot")).toMatchObject([
      { label: "Before upgrading Next", kind: "named" },
    ]);
    await expect(vm.snapshots.capture({ label: "   " })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await vm.dispose();
  });

  it("saves an automatic restore point when asked, which retention thins with the others", async () => {
    ScriptedWorker.answers.set("snapshot", () => NAMED.ref);
    const vm = await bootedManagedVm();

    await vm.snapshots.capture({ label: "Backup", kind: "automatic" });

    const saves = control().inputs.filter((input) => input["type"] === "snapshot");
    expect(saves).toMatchObject([{ label: "Backup" }]);
    expect(saves[0]).not.toHaveProperty("kind");
    await vm.dispose();
  });

  it("reports the saved point when cancellation arrives after its commit", async () => {
    const vm = await bootedManagedVm(), abort = new AbortController();
    const entered = Promise.withResolvers<undefined>(), finish = Promise.withResolvers<typeof NAMED.ref>();
    ScriptedWorker.answers.set("snapshot", () => { entered.resolve(undefined); return finish.promise; });
    const saving = vm.snapshots.capture({ label: "Before upgrading Next", signal: abort.signal });
    await entered.promise; abort.abort(); finish.resolve(NAMED.ref);
    await expect(saving).resolves.toEqual(NAMED);
    await vm.dispose();
  });

  it("saves the current state first, so a restore can be undone", async () => {
    ScriptedWorker.answers.set("snapshot", () => SAFETY.ref);
    const vm = await bootedManagedVm();

    const result = await vm.snapshots.restore(NAMED.ref);

    expect(result).toMatchObject({ start: { kind: "resumed", snapshot: NAMED, newerFilesDropped: true, workspace: "in-sync" }, undo: SAFETY });
    expect(control().inputs.filter((input) => input["type"] === "snapshot")).toMatchObject([{ label: "Before restore", kind: "safety" }]);
    const order = control().operations;
    expect(order.indexOf("snapshot")).toBeLessThan(order.indexOf("restore"));
    // A chosen restore point brings its own files back: nothing is reconciled.
    expect(order).not.toContain("agent-reconcile-workspace");
    await vm.dispose();
  });

  it("restores without saving first when asked", async () => {
    const vm = await bootedManagedVm();

    const result = await vm.snapshots.restore(NAMED.ref, { saveCurrentFirst: false });

    expect(result).not.toHaveProperty("undo");
    expect(control().operations).not.toContain("snapshot");
    await vm.dispose();
  });

  it("rejects an already cancelled restore before stopping or replacing the session", async () => {
    const vm = await bootedManagedVm();
    const before = control().operations.length;
    await expect(vm.snapshots.restore(NAMED.ref, { saveCurrentFirst: false, signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ code: "ABORTED" });
    expect(control().operations.slice(before)).not.toContain("restore");
    expect(control().operations.slice(before)).not.toContain("stop-system");
    await vm.dispose();
  });

  it("forwards cancellation to the restore owner and retains its committed outcome", async () => {
    const vm = await bootedManagedVm();
    const entered = Promise.withResolvers<undefined>();
    const finish = Promise.withResolvers<typeof RESTORED>();
    ScriptedWorker.answers.set("restore", () => { entered.resolve(undefined); return finish.promise; });
    const controller = new AbortController();
    let settled = false;
    const restoring = vm.snapshots.restore(NAMED.ref, { saveCurrentFirst: false, signal: controller.signal });
    void restoring.then(() => { settled = true; }, () => { settled = true; });
    await entered.promise;
    controller.abort();
    await Promise.resolve();
    expect(control().operations).toContain("cancel");
    expect(settled).toBe(false);
    finish.resolve(RESTORED);
    await expect(restoring).resolves.toMatchObject({ start: { kind: "resumed", snapshot: NAMED } });
    await vm.dispose();
  });

  it("renames, deletes and measures restore points through the storage catalogue", async () => {
    const usage = { referencedBytes: 10, reclaimableBytes: 0, estimate: null, persisted: null };
    ScriptedWorker.answers.set("snapshot-rename", () => ({ ...NAMED, label: "Working build" }));
    ScriptedWorker.answers.set("snapshot-delete", () => undefined);
    ScriptedWorker.answers.set("snapshot-usage", () => usage);
    const vm = await bootedManagedVm();

    await expect(vm.snapshots.rename(NAMED.ref, "Working build")).resolves.toMatchObject({ label: "Working build" });
    await vm.snapshots.delete(SAFETY.ref);
    await expect(vm.snapshots.usage()).resolves.toEqual(usage);
    await expect(vm.snapshots.list()).resolves.toEqual([SAFETY, NAMED]);

    expect(storage().inputs.filter((input) => input["type"] === "snapshot-rename")).toMatchObject([
      { snapshot: NAMED.ref, label: "Working build" },
    ]);
    expect(storage().inputs.filter((input) => input["type"] === "snapshot-delete")).toMatchObject([{ snapshot: SAFETY.ref }]);
    await vm.dispose();
  });

  it("hands the page's data to the control worker for later restore points", async () => {
    ScriptedWorker.answers.set("snapshot-app-data", () => undefined);
    const vm = await bootedManagedVm();

    await vm.snapshots.setAppData(new TextEncoder().encode("tabs"));
    await vm.snapshots.setAppData(null);

    expect(control().inputs.filter((input) => input["type"] === "snapshot-app-data")).toEqual([
      expect.objectContaining({ data: new TextEncoder().encode("tabs") }),
      expect.objectContaining({ data: null }),
    ]);
    await expect(vm.snapshots.setAppData(new Uint8Array(1024 * 1024 + 1))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await vm.dispose();
  });
});

