import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntimeVM } from "./index.js";
import { ScriptedWorker } from "./system-vm.test-support.js";
import type { SnapshotInfo } from "./protocol.js";

vi.mock("./userspace-process.js", async () => {
  const { nativeBackend } = await import("./userspace-vm.test-support.js");
  return { UserspaceProcessBackend: { create: () => Promise.resolve(nativeBackend()) } };
});

const point: SnapshotInfo = { mode: "userspace", ref: { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-13T00:00:00.000Z" },
  kind: "named", label: "Before upgrading Next", capturedAtUnixMs: 1, profile: null, bytes: { ram: 0, disk: 0, unique: 0 }, resumable: true };

describe("Userspace restore points", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://ide.example.test/"));
  });

  afterEach(() => {
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("uses the shared restore-point catalogue and native control capture", async () => {
    ScriptedWorker.answers.set("snapshot-list", () => [point]); ScriptedWorker.answers.set("snapshot", () => point.ref);
    const vm = await createRuntimeVM({ mode: "userspace", workspaceId: "userspace", memoryMiB: 256, network: "local" });
    await expect(vm.snapshots.list()).resolves.toEqual([point]);
    await expect(vm.snapshots.capture({ label: "Before upgrading Next" })).resolves.toEqual(point);
    expect(ScriptedWorker.named("oxidevm-control").inputs).toContainEqual(expect.objectContaining({ type: "snapshot", kind: "named" }));
    await vm.dispose();
  });

  it("uses the shared automatic-save configuration and event subscription", async () => {
    ScriptedWorker.answers.set("auto-save-configure", () => undefined); ScriptedWorker.answers.set("auto-save-hint", () => undefined);
    ScriptedWorker.answers.set("snapshot-events", () => undefined);
    const vm = await createRuntimeVM({ mode: "userspace", workspaceId: "userspace", memoryMiB: 256, network: "local" });
    await vm.snapshots.autoSave.configure({ enabled: true });
    vm.snapshots.autoSave.hint("hidden");
    vm.snapshots.observe(() => undefined, { signal: new AbortController().signal });
    expect(ScriptedWorker.named("oxidevm-control").operations).toEqual(["auto-save-configure", "auto-save-hint", "snapshot-events"]);
    await vm.dispose();
  });
});

it("reports the selected verified image after restoring an earlier native image", async () => {
  vi.stubGlobal("Worker", ScriptedWorker); vi.stubGlobal("location", new URL("https://example.test/"));
  const { nativeStartup, NATIVE_ROOTFS, NATIVE_MANIFEST, NATIVE_TRUST } = await import("./userspace-vm.test-support.js");
  nativeStartup();
  const newer = { id: "alpine", version: "v2", mode: "userspace", cpuProfile: "x86-64-v2", manifestSHA256: "b".repeat(64), keyId: "test", signatureVerified: true };
  const older = { ...newer, version: "v1", manifestSHA256: "a".repeat(64) };
  ScriptedWorker.answers.set("prepare-userspace-rootfs", () => ({ ...NATIVE_ROOTFS, version: "v2", identity: newer }));
  ScriptedWorker.answers.set("current-userspace-image", () => { throw new Error("Storage disappeared after publication"); });
  ScriptedWorker.answers.set("current-userspace-rootfs", () => { throw new Error("Storage disappeared after publication"); });
  ScriptedWorker.answers.set("restore", () => ({ newerFilesDropped: false, appData: null, consoleTail: new Uint8Array(), processes: [], nativeRootfs: { ...NATIVE_ROOTFS, identity: older } }));
  const vm = await createRuntimeVM({ mode: "userspace", workspaceId: "restore-image", memoryMiB: 256, network: "local" });
  try {
    await vm.bootManagedImage(NATIVE_MANIFEST, NATIVE_TRUST);
    expect(vm.imageIdentity).toEqual(newer);
    await vm.restore(point.ref);
    expect(vm.imageIdentity).toEqual(older);
    expect(ScriptedWorker.named("oxidevm-storage").operations).not.toContain("current-userspace-image");
  } finally { await vm.dispose(); ScriptedWorker.reset(); vi.unstubAllGlobals(); }
});
