import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntimeVM } from "./index.js";
import { PROTOCOL_VERSION, type SnapshotInfo } from "./protocol.js";
import type { StartProgress } from "./snapshot-types.js";
import { createSystemRuntimeVM } from "./system-vm.js";
import { ScriptedWorker } from "./system-vm.test-support.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));
vi.mock("./userspace-process.js", async () => {
  const { nativeBackend } = await import("./userspace-vm.test-support.js");
  return { UserspaceProcessBackend: { create: () => Promise.resolve(nativeBackend()) } };
});

const MANIFEST = "https://images.example.test/boundary/manifest.json";
const TRUST = { trustedKeyId: "boundary-development-2026", trustedPublicKey: new Uint8Array(32).fill(7) };
const SHIPPED: SnapshotInfo = {
  mode: "system",
  ref: { id: "123e4567-e89b-42d3-a456-426614174009", createdAt: "2026-10-02T15:00:00.000Z" },
  kind: "shipped",
  label: "Boundary · container ready",
  capturedAtUnixMs: 1_790_000_000_000,
  profile: { id: "alpine", version: "2026.10.02" },
  bytes: { ram: 0, disk: 0, unique: 0 },
  resumable: true,
};

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function storage(): ScriptedWorker {
  return ScriptedWorker.named("oxidevm-storage");
}

describe("system VM shipped restore points", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://ide.example.test/"));
    ScriptedWorker.answers.set("snapshot-resume-candidates", () => []);
    ScriptedWorker.answers.set("snapshot-list", () => []);
    ScriptedWorker.answers.set("agent-reconcile-workspace", () => ({ workspace: "in-sync", unresolved: [] }));
  });

  afterEach(() => {
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("opens the example's shipped restore point on a first visit, reporting the download", async () => {
    ScriptedWorker.answers.set("snapshot-install-shipped", async (input) => {
      const port = input["progress"];
      if (!(port instanceof MessagePort)) throw new Error("no progress port");
      port.postMessage({ version: PROTOCOL_VERSION, completedBytes: 512, totalBytes: 1024 });
      port.postMessage({ version: PROTOCOL_VERSION, completedBytes: 1024, totalBytes: 1024 });
      await settle();
      return SHIPPED;
    });
    const vm = await createSystemRuntimeVM({ mode: "system", workspaceId: "example", memoryMiB: 256, vcpus: 1, network: "local" });
    const steps: StartProgress[] = [];

    const image = await vm.bootManagedImage(MANIFEST, { resume: "latest", shipped: "container-ready", ...TRUST, onProgress: (step) => steps.push(step) });

    expect(image.start).toMatchObject({ kind: "resumed", snapshot: SHIPPED });
    expect(storage().inputs.find((input) => input["type"] === "snapshot-install-shipped"))
      .toMatchObject({ name: "container-ready", trustedKeyId: TRUST.trustedKeyId });
    expect(steps.slice(0, 2)).toEqual([
      { step: "download", completedBytes: 512, totalBytes: 1024 },
      { step: "download", completedBytes: 1024, totalBytes: 1024 },
    ]);
    expect(steps.map((step) => step.step)).toEqual(["download", "download", "open", "wake", "reconnect"]);
    await vm.dispose();
  });

  it("boots cold without asking the storage worker when no trusted key was given", async () => {
    const vm = await createSystemRuntimeVM({ mode: "system", workspaceId: "example", memoryMiB: 256, vcpus: 1, network: "local" });

    const image = await vm.bootManagedImage(MANIFEST, { resume: "latest", shipped: "container-ready" });

    expect(image.start).toEqual({ kind: "booted", reason: "first-start", shipped: { reason: "untrusted" } });
    expect(storage().operations).not.toContain("snapshot-install-shipped");
    await vm.dispose();
  });

  it("refuses a shipped name that is not a catalog id", async () => {
    const vm = await createSystemRuntimeVM({ mode: "system", workspaceId: "example", memoryMiB: 256, vcpus: 1, network: "local" });
    const untyped: { bootManagedImage(url: string, options: unknown): Promise<unknown> } = vm;

    await expect(untyped.bootManagedImage(MANIFEST, { resume: "latest", shipped: "../escape", ...TRUST })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await vm.dispose();
  });

  it("opens a signed shipped native checkpoint on a first visit", async () => {
    const vm = await createRuntimeVM({ mode: "userspace", workspaceId: "userspace", memoryMiB: 256, network: "local" });

    const { nativeStartup } = await import("./userspace-vm.test-support.js"); nativeStartup();
    ScriptedWorker.answers.set("snapshot-install-shipped", () => ({ ...SHIPPED, mode: "userspace" }));
    ScriptedWorker.answers.set("restore-userspace-checkpoint", () => ({ newerFilesDropped: false, appData: null, consoleTail: new Uint8Array(), processes: [] }));
    await expect(vm.bootManagedImage(MANIFEST, { resume: "latest", shipped: "container-ready", ...TRUST }))
      .resolves.toMatchObject({ start: { kind: "resumed", snapshot: { mode: "userspace", kind: "shipped" } } });
    expect(storage().operations).toContain("snapshot-install-shipped");
    await vm.dispose();
  });
});
