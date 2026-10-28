import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SnapshotInfo, SnapshotResumability } from "./protocol.js";
import { createSystemRuntimeVM } from "./system-vm.js";
import { ScriptedWorker } from "./system-vm.test-support.js";
import type { RuntimeVM } from "./vm-types.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));

const MANIFEST = "https://images.example.test/alpine/manifest.json";

function bytes(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

function info(sequence: number, resumable: SnapshotResumability = true): SnapshotInfo {
  return {
    mode: "system",
    ref: { id: `123e4567-e89b-42d3-a456-42661417400${String(sequence)}`, createdAt: "2026-10-02T10:00:00.000Z" },
    kind: "automatic",
    capturedAtUnixMs: 1_790_000_000_000 + sequence,
    profile: { id: "alpine", version: "2026.10.02" },
    bytes: { ram: 0, disk: 0, unique: 0 },
    resumable,
  };
}

const LATEST = info(2);
const EARLIER = info(1);
const RESTORED = {
  newerFilesDropped: true,
  appData: bytes("tabs"),
  consoleTail: bytes("login: "),
  processes: [{ agentRequestId: 3, command: "bun dev", terminal: true, tail: bytes("Ready") }],
};

async function freshVm(): Promise<RuntimeVM> {
  return createSystemRuntimeVM({ mode: "system", workspaceId: "resume", memoryMiB: 256, vcpus: 1, network: "local" });
}

function operations(name: "oxidevm-control" | "oxidevm-storage"): string[] {
  return ScriptedWorker.named(name).operations;
}

function inputsOf(name: "oxidevm-control" | "oxidevm-storage", type: string): Record<string, unknown>[] {
  return ScriptedWorker.named(name).inputs.filter((input) => input["type"] === type);
}

describe("system VM resume", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://ide.example.test/"));
    ScriptedWorker.answers.set("snapshot-resume-candidates", () => [LATEST, EARLIER]);
    ScriptedWorker.answers.set("snapshot-list", () => [LATEST, EARLIER]);
    ScriptedWorker.answers.set("restore", () => RESTORED);
    ScriptedWorker.answers.set("agent-reconcile-workspace", () => ({ workspace: "reconciled", unresolved: [] }));
    ScriptedWorker.answers.set("agent-attach-process", () => ({ pid: 120, sessionId: 3 }));
  });

  afterEach(() => {
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("resumes where the VM left off when the page reloads", async () => {
    const vm = await freshVm();

    const image = await vm.bootManagedImage(MANIFEST, { resume: "latest" });

    expect(image.start).toMatchObject({
      kind: "resumed",
      snapshot: LATEST,
      appData: bytes("tabs"),
      newerFilesDropped: true,
      workspace: "reconciled",
      terminals: [{ source: "console", key: "console", screenTail: bytes("login: ") }, { source: "process", command: "bun dev" }],
    });
    expect(image.start).not.toHaveProperty("skipped");
    expect(inputsOf("oxidevm-storage", "prepare-managed-image")).toMatchObject([{ boot: "live" }]);
    expect(inputsOf("oxidevm-control", "restore")).toMatchObject([{ snapshot: LATEST.ref }]);
    // No kernel boots: the restored machine runs, greeted, refreshed and reconciled.
    expect(operations("oxidevm-control")).toEqual([
      "initialize",
      "network-link-connect",
      "quiesce-disk",
      "configure-system-aot",
      "restore",
      "start-system",
      "wait-agent",
      "agent-refresh-guest",
      "agent-reconcile-workspace",
    ]);
    await expect(vm.spawn({ command: "true" })).resolves.toMatchObject({ pid: 7 });
    await vm.dispose();
  });

  it("falls back to the earlier save when the latest is damaged, naming the one it skipped", async () => {
    const damaged = info(3, "corrupt");
    ScriptedWorker.answers.set("snapshot-resume-candidates", () => [damaged, EARLIER]);
    const vm = await freshVm();

    const image = await vm.bootManagedImage(MANIFEST, { resume: "latest" });

    expect(image.start).toMatchObject({ kind: "resumed", snapshot: EARLIER, skipped: damaged });
    expect(inputsOf("oxidevm-control", "restore")).toMatchObject([{ snapshot: EARLIER.ref }]);
    await vm.dispose();
  });

  it("boots the live disk when the latest restore point cannot resume this VM", async () => {
    const older = info(2, "older-format");
    ScriptedWorker.answers.set("snapshot-resume-candidates", () => [older]);
    const vm = await freshVm();

    const image = await vm.bootManagedImage(MANIFEST, { resume: "latest" });

    expect(image.start).toEqual({ kind: "booted", reason: "incompatible", skipped: older });
    expect(inputsOf("oxidevm-storage", "prepare-managed-image")).toMatchObject([{ boot: "live" }]);
    expect(operations("oxidevm-control")).toContain("boot-system");
    expect(operations("oxidevm-control")).not.toContain("restore");
    await expect(vm.spawn({ command: "true" })).resolves.toMatchObject({ pid: 7 });
    await vm.dispose();
  });

  it("boots the disk from before the resume when the resumed guest agent does not answer", async () => {
    let greetings = 0;
    ScriptedWorker.answers.set("wait-agent", () => {
      greetings += 1;
      // The restored agent stays silent; the cold-booted one answers.
      if (greetings === 1) throw new Error("the guest agent did not answer in time");
      return { version: "7", capabilities: { files: true, processes: true } };
    });
    const vm = await freshVm();

    const image = await vm.bootManagedImage(MANIFEST, { resume: "latest" });

    expect(image.start).toEqual({ kind: "booted", reason: "agent-unavailable", skipped: LATEST });
    expect(inputsOf("oxidevm-storage", "prepare-managed-image")).toMatchObject([{ boot: "live" }, { boot: "pre-resume" }]);
    expect(operations("oxidevm-control")).toContain("boot-system");
    await vm.dispose();
  });

  it("moves to the requested image only when asked to update, and names an update it kept back", async () => {
    ScriptedWorker.answers.set("prepare-managed-image", (input) => ({
      id: "alpine",
      version: "2026.10.01",
      memoryMiB: 256,
      vcpus: 1,
      workspaceBaseSha256: "a".repeat(64),
      kernel: new Uint8Array([0x4b]),
      commandLine: "console=hvc0",
      diskBytes: 1024 * 1024,
      aot: { kind: "skipped", reason: "no-catalog" },
      runtimes: { alpine: "3.24.1", node: "24.18.1", bun: "1.3.14", next: "16.2.12" },
      ...(input["boot"] === "update-image" ? {} : { update: { id: "alpine", version: "2026.10.02" } }),
    }));
    const vm = await freshVm();

    const kept = await vm.bootManagedImage(MANIFEST, { resume: "none" });
    const updated = await vm.bootManagedImage(MANIFEST, { resume: "update-image" });

    expect(kept).toMatchObject({ version: "2026.10.01", update: { id: "alpine", version: "2026.10.02" } });
    expect(updated.start).toEqual({ kind: "booted", reason: "update-image" });
    expect(updated).not.toHaveProperty("update");
    expect(inputsOf("oxidevm-storage", "prepare-managed-image")).toMatchObject([{ boot: "live" }, { boot: "update-image" }]);
    await vm.dispose();
  });

  it("writes the running workspace out before an update boots the new image", async () => {
    ScriptedWorker.answers.set("prepare-managed-image", (input) => ({
      id: "alpine",
      version: "2026.10.01",
      memoryMiB: 256,
      vcpus: 1,
      workspaceBaseSha256: "a".repeat(64),
      kernel: new Uint8Array([0x4b]),
      commandLine: "console=hvc0",
      diskBytes: 1024 * 1024,
      aot: { kind: "skipped", reason: "no-catalog" },
      runtimes: { alpine: "3.24.1", node: "24.18.1", bun: "1.3.14", next: "16.2.12" },
      ...(input["boot"] === "update-image" ? {} : { update: { id: "alpine", version: "2026.10.02" } }),
    }));
    ScriptedWorker.answers.set("agent-sync-workspace", () => true);
    const vm = await freshVm();
    await vm.bootManagedImage(MANIFEST, { resume: "none" });

    await vm.bootManagedImage(MANIFEST, { resume: "update-image" });

    const control = operations("oxidevm-control");
    const boots = control.flatMap((operation, index) => operation === "boot-system" ? [index] : []);
    const flushed = control.indexOf("agent-sync-workspace");
    expect(boots).toHaveLength(2);
    expect(flushed).toBeGreaterThan(boots[0] ?? Infinity);
    expect(flushed).toBeLessThan(boots[1] ?? -Infinity);
    await vm.dispose();
  });

  it("does not write the workspace out when an update boot keeps the image the disk runs", async () => {
    ScriptedWorker.answers.set("agent-sync-workspace", () => true);
    const vm = await freshVm();
    await vm.bootManagedImage(MANIFEST, { resume: "none" });

    // Today's IDE reboots this way: the disk already runs the page's image, so nothing moves.
    await vm.bootManagedImage(MANIFEST, { resume: "update-image" });

    expect(operations("oxidevm-control")).not.toContain("agent-sync-workspace");
    await vm.dispose();
  });

  it("restarts from the live disk without resuming when asked", async () => {
    const vm = await freshVm();

    const image = await vm.bootManagedImage(MANIFEST, { resume: "none" });

    expect(image.start).toEqual({ kind: "booted", reason: "restart" });
    expect(inputsOf("oxidevm-storage", "prepare-managed-image")).toMatchObject([{ boot: "live" }]);
    expect(operations("oxidevm-storage")).not.toContain("snapshot-resume-candidates");
    await vm.dispose();
  });

  it("restarts from the disk the last resume replaced on Restart instead", async () => {
    const vm = await freshVm();

    const image = await vm.bootManagedImage(MANIFEST, { resume: "pre-resume" });

    expect(image.start).toEqual({ kind: "booted", reason: "restart" });
    expect(inputsOf("oxidevm-storage", "prepare-managed-image")).toMatchObject([{ boot: "pre-resume" }]);
    expect(operations("oxidevm-storage")).not.toContain("snapshot-resume-candidates");
    await vm.dispose();
  });

  it("lets a page take over a resumed process, its saved screen first", async () => {
    const vm = await freshVm();
    const image = await vm.bootManagedImage(MANIFEST, { resume: "latest" });
    const resumed = image.start?.kind === "resumed" ? image.start.terminals.find((terminal) => terminal.source === "process") : undefined;
    if (resumed?.source !== "process") throw new Error("no resumed process");

    const process = await resumed.attach();

    expect(inputsOf("oxidevm-control", "agent-attach-process")).toMatchObject([{ agentRequestId: 3 }]);
    expect(resumed.screenTail).toEqual(bytes("Ready"));
    void process.exit.catch(() => undefined);
    await vm.dispose();
  });

  it("refuses an unknown resume request", async () => {
    const vm = await freshVm();

    await expect(vm.bootManagedImage(MANIFEST, { resume: { id: "latest", createdAt: "now" } })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await vm.dispose();
  });
});
