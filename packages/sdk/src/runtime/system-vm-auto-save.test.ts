import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VMError } from "./errors.js";
import { PROTOCOL_VERSION, type SnapshotInfo } from "./protocol.js";
import type { SnapshotEvent, StartProgress } from "./snapshot-types.js";
import { createSystemRuntimeVM } from "./system-vm.js";
import { bootedManagedVm, ScriptedWorker } from "./system-vm.test-support.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));

const SNAPSHOT = { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-02T10:00:00.000Z" };
const LATEST: SnapshotInfo = {
  mode: "system",
  ref: SNAPSHOT,
  kind: "automatic",
  capturedAtUnixMs: 1_790_000_000_000,
  profile: { id: "alpine", version: "2026.10.02" },
  bytes: { ram: 0, disk: 0, unique: 0 },
  resumable: true,
};
const RESTORED = { newerFilesDropped: false, appData: null, consoleTail: new Uint8Array(), processes: [] };

/** Remembers the event ports the control worker was given, to send events through them. */
function eventPorts(): MessagePort[] {
  const ports: MessagePort[] = [];
  ScriptedWorker.answers.set("snapshot-events", (input) => {
    const port = input["port"];
    if (!(port instanceof MessagePort)) throw new Error("no event port");
    ports.push(port);
    return undefined;
  });
  return ports;
}

function send(ports: readonly MessagePort[], event: Record<string, unknown>): void {
  for (const port of ports) port.postMessage({ version: PROTOCOL_VERSION, event });
}

function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("system VM automatic saves and restore point events", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://ide.example.test/"));
  });

  afterEach(() => {
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("follows restore point events through one port until the page stops listening", async () => {
    const ports = eventPorts();
    const vm = await bootedManagedVm();
    const received: SnapshotEvent[] = [];
    const listening = new AbortController();

    vm.snapshots.observe((event) => received.push(event), { signal: listening.signal });
    vm.snapshots.observe(() => undefined, { signal: new AbortController().signal });
    await settle();
    send(ports, { type: "save-started", kind: "automatic" });
    send(ports, { type: "save-failed", kind: "automatic", error: { code: "QUOTA_EXCEEDED", message: "the browser has no room" } });
    await settle();
    listening.abort();
    send(ports, { type: "save-started", kind: "named" });
    await settle();

    expect(ports).toHaveLength(1);
    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ type: "save-started", kind: "automatic" });
    expect(received[1]).toMatchObject({ type: "save-failed", kind: "automatic" });
    const failed = received[1];
    expect(failed?.type === "save-failed" ? failed.error : undefined).toBeInstanceOf(VMError);
    await vm.dispose();
  });

  it("turns automatic saves on and passes what the page sees", async () => {
    ScriptedWorker.answers.set("auto-save-configure", () => undefined);
    ScriptedWorker.answers.set("auto-save-hint", () => undefined);
    const vm = await bootedManagedVm();
    const control = ScriptedWorker.named("oxidevm-control");

    await vm.snapshots.autoSave.configure({ enabled: true });
    vm.snapshots.autoSave.hint("hidden");
    vm.snapshots.autoSave.hint("activity");
    await settle();

    expect(control.inputs.filter((input) => input["type"] === "auto-save-configure")).toMatchObject([{ enabled: true }]);
    expect(control.inputs.filter((input) => input["type"] === "auto-save-hint").map((input) => input["hint"])).toEqual(["hidden", "activity"]);
    await vm.dispose();
  });

  it("reports one boot step when Linux boots cold", async () => {
    eventPorts();
    ScriptedWorker.answers.set("snapshot-resume-candidates", () => []);
    ScriptedWorker.answers.set("snapshot-list", () => []);
    const vm = await createSystemRuntimeVM({ mode: "system", workspaceId: "resume", memoryMiB: 256, vcpus: 1, network: "local" });
    const steps: StartProgress[] = [];

    const image = await vm.bootManagedImage("https://images.example.test/alpine/manifest.json", {
      resume: "latest",
      onProgress: (progress) => steps.push(progress),
    });

    expect(image.start).toMatchObject({ kind: "booted", reason: "first-start" });
    expect(steps).toEqual([{ step: "boot" }]);
    await vm.dispose();
  });

  it("reports a resume's steps: reading its restore point in bytes, waking Linux, reconnecting", async () => {
    const ports = eventPorts();
    ScriptedWorker.answers.set("snapshot-resume-candidates", () => [LATEST]);
    ScriptedWorker.answers.set("snapshot-list", () => [LATEST]);
    ScriptedWorker.answers.set("agent-reconcile-workspace", () => ({ workspace: "in-sync", unresolved: [] }));
    ScriptedWorker.answers.set("restore", async () => {
      send(ports, { type: "restore-progress", completedBytes: 64, totalBytes: 128 });
      send(ports, { type: "restore-progress", completedBytes: 128, totalBytes: 128 });
      await settle();
      return RESTORED;
    });
    const vm = await createSystemRuntimeVM({ mode: "system", workspaceId: "resume", memoryMiB: 256, vcpus: 1, network: "local" });
    const steps: StartProgress[] = [];

    await vm.bootManagedImage("https://images.example.test/alpine/manifest.json", {
      resume: "latest",
      onProgress: (progress) => steps.push(progress),
    });

    expect(steps).toEqual([
      { step: "open", completedBytes: 0, totalBytes: 0 },
      { step: "open", completedBytes: 64, totalBytes: 128 },
      { step: "open", completedBytes: 128, totalBytes: 128 },
      { step: "wake" },
      { step: "reconnect" },
    ]);
    await vm.dispose();
  });

  it("reports a restore's steps, and none of a later restore's bytes", async () => {
    const ports = eventPorts();
    ScriptedWorker.answers.set("snapshot-list", () => [LATEST]);
    ScriptedWorker.answers.set("restore", async () => {
      send(ports, { type: "restore-progress", completedBytes: 128, totalBytes: 128 });
      await settle();
      return RESTORED;
    });
    const vm = await bootedManagedVm();
    const steps: StartProgress[] = [];

    await vm.snapshots.restore(SNAPSHOT, { saveCurrentFirst: false, onProgress: (progress) => steps.push(progress) });
    send(ports, { type: "restore-progress", completedBytes: 1, totalBytes: 2 });
    await settle();

    expect(steps).toEqual([
      { step: "open", completedBytes: 0, totalBytes: 0 },
      { step: "open", completedBytes: 128, totalBytes: 128 },
      { step: "wake" },
      { step: "reconnect" },
    ]);
    await vm.dispose();
  });

  it("reports no waking or reconnecting for a restore that was refused", async () => {
    eventPorts();
    ScriptedWorker.restore = "refused";
    ScriptedWorker.answers.set("snapshot-list",()=>[LATEST]);
    const vm = await bootedManagedVm();
    const steps: StartProgress[] = [];

    await expect(vm.snapshots.restore(SNAPSHOT, { saveCurrentFirst: false, onProgress: (progress) => steps.push(progress) }))
      .rejects.toMatchObject({ code: "SNAPSHOT_VERSION" });
    await settle();

    expect(steps).toEqual([{ step: "open", completedBytes: 0, totalBytes: 0 }]);
    await vm.dispose();
  });

  it("refuses an automatic save hint or policy it does not know", async () => {
    const vm = await bootedManagedVm();

    // Untyped callers may pass anything.
    const untyped: { hint(hint: unknown): void; configure(policy: unknown): Promise<void> } = vm.snapshots.autoSave;

    expect(thrownBy(() => { untyped.hint("scrolled"); })).toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(untyped.configure({ enabled: "yes" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(untyped.configure(null)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(ScriptedWorker.named("oxidevm-control").operations).toEqual([]);
    await vm.dispose();
  });

  it("stops the VM when the control worker sends a malformed restore point event", async () => {
    const ports = eventPorts();
    ScriptedWorker.answers.set("auto-save-configure", () => undefined);
    const vm = await bootedManagedVm();

    vm.snapshots.observe(() => undefined, { signal: new AbortController().signal });
    await settle();
    send(ports, { type: "save-started", kind: "favourite" });
    await settle();

    await expect(vm.snapshots.autoSave.configure({ enabled: true })).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });
});
