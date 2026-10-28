import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VMError } from "./errors.js";
import { createRuntimeVM } from "./index.js";
import { PROTOCOL_VERSION, type SnapshotInfo } from "./protocol.js";
import { describeSnapshotError } from "./snapshot-errors.js";
import type { BackupProgress } from "./snapshot-types.js";
import { bootedManagedVm, ScriptedWorker } from "./system-vm.test-support.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));
vi.mock("./userspace-process.js", async () => {
  const { nativeBackend } = await import("./userspace-vm.test-support.js");
  return { UserspaceProcessBackend: { create: () => Promise.resolve(nativeBackend()) } };
});

const SNAPSHOT = { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-02T10:00:00.000Z" };
const IMPORTED: SnapshotInfo = {
  mode: "system",
  ref: { id: "123e4567-e89b-42d3-a456-426614174009", createdAt: "2026-10-02T15:00:00.000Z" },
  kind: "imported",
  label: "Before upgrading Next",
  capturedAtUnixMs: 1_790_000_000_000,
  profile: { id: "alpine", version: "2026.10.02" },
  bytes: { ram: 0, disk: 0, unique: 0 },
  resumable: true,
};
const INSPECTION = {
  mode: "system",
  kind: "named",
  label: "Before upgrading Next",
  capturedAtUnixMs: 1_790_000_000_000,
  profile: { id: "alpine", version: "2026.10.02" },
  machine: { memoryMiB: 256, vcpus: 1 },
  fileBytes: 3,
  compatible: true,
};

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** An answer that reports progress on the request's port before it settles. */
function reporting<T>(steps: readonly [number, number][], value: T) {
  return async (input: Record<string, unknown>): Promise<T> => {
    const port = input["progress"];
    if (!(port instanceof MessagePort)) throw new Error("no progress port");
    for (const [completedBytes, totalBytes] of steps) port.postMessage({ version: PROTOCOL_VERSION, completedBytes, totalBytes });
    await settle();
    return value;
  };
}

function storage(): ScriptedWorker {
  return ScriptedWorker.named("oxidevm-storage");
}

function requestOf(type: string): Record<string, unknown> | undefined {
  return storage().inputs.find((input) => input["type"] === type);
}

describe("system VM backups", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://ide.example.test/"));
  });

  afterEach(() => {
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("exports a restore point to a staged file, reporting progress", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "oxidevm-x-2026-10-02-1432.oxvm");
    ScriptedWorker.answers.set("snapshot-export", reporting([[0, 10], [10, 10]], { kind: "file", file, suggestedName: "oxidevm-x-2026-10-02-1432.oxvm" }));
    const vm = await bootedManagedVm();
    const progress: BackupProgress[] = [];

    const exported = await vm.snapshots.export(SNAPSHOT, { onProgress: (step) => progress.push(step) });
    await settle();

    expect(exported).toEqual({ kind: "file", file, suggestedName: "oxidevm-x-2026-10-02-1432.oxvm" });
    expect(progress).toEqual([{ completedBytes: 0, totalBytes: 10 }, { completedBytes: 10, totalBytes: 10 }]);
    expect(requestOf("snapshot-export")).toMatchObject({ snapshot: SNAPSHOT });
    expect(requestOf("snapshot-export")).not.toHaveProperty("destination");
    await vm.dispose();
  });

  it("writes to a file the user picked", async () => {
    ScriptedWorker.answers.set("snapshot-export", reporting([], { kind: "written", bytes: 42 }));
    const vm = await bootedManagedVm();
    const picked = { kind: "file", name: "backup.oxvm", createWritable: () => Promise.reject(new Error("not here")) };
    const untyped: { export(snapshot: unknown, options: unknown): Promise<unknown> } = vm.snapshots;

    await expect(untyped.export(SNAPSHOT, { destination: picked })).resolves.toEqual({ kind: "written", bytes: 42 });
    expect(requestOf("snapshot-export")).toMatchObject({ destination: picked });
    await expect(untyped.export(SNAPSHOT, { destination: { kind: "directory" } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await vm.dispose();
  });

  it("imports and inspects a backup file", async () => {
    ScriptedWorker.answers.set("snapshot-import", reporting([[3, 3]], IMPORTED));
    ScriptedWorker.answers.set("snapshot-inspect", () => INSPECTION);
    const vm = await bootedManagedVm();
    const file = new File([new Uint8Array([1, 2, 3])], "backup.oxvm");
    const progress: BackupProgress[] = [];

    await expect(vm.snapshots.inspect(file)).resolves.toEqual(INSPECTION);
    await expect(vm.snapshots.import(file, { onProgress: (step) => progress.push(step) })).resolves.toEqual(IMPORTED);
    await settle();

    expect(progress).toEqual([{ completedBytes: 3, totalBytes: 3 }]);
    expect(requestOf("snapshot-import")?.["file"]).toBe(file);
    const untyped: { import(file: unknown): Promise<unknown>; inspect(file: unknown): Promise<unknown> } = vm.snapshots;
    await expect(untyped.import("backup.oxvm")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(untyped.inspect(undefined)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await vm.dispose();
  });

  it("cancels an import through its signal", async () => {
    let cancelled = (): void => undefined;
    ScriptedWorker.answers.set("snapshot-import", () => new Promise((_, reject) => {
      cancelled = () => {
        reject(new VMError("ABORTED", "the backup was cancelled"));
      };
    }));
    const vm = await bootedManagedVm();
    const cancel = new AbortController();

    const importing = vm.snapshots.import(new File([new Uint8Array(1)], "backup.oxvm"), { signal: cancel.signal });
    await settle();
    cancel.abort();
    await settle();
    cancelled();

    await expect(importing).rejects.toMatchObject({ code: "ABORTED" });
    expect(storage().operations).toContain("cancel");
    await vm.dispose();
  });

  it("passes each refusal on, and words it plainly", async () => {
    const vm = await bootedManagedVm();
    const file = new File([new Uint8Array(1)], "photo.png");
    const plain: Record<string, string> = {};

    for (const [reason, code] of [
      ["backup-wrong-file", "INVALID_ARGUMENT"],
      ["backup-damaged", "INVALID_ARGUMENT"],
      ["backup-newer", "SNAPSHOT_VERSION"],
      ["backup-older", "SNAPSHOT_VERSION"],
      ["backup-other-environment", "INVALID_ARGUMENT"],
      ["backup-no-space", "QUOTA_EXCEEDED"],
    ] as const) {
      ScriptedWorker.answers.set("snapshot-import", () => {
        throw new VMError(code, "internal wording", { reason });
      });
      const error = await vm.snapshots.import(file).catch((caught: unknown) => caught);
      expect(error, reason).toMatchObject({ code, detail: { reason } });
      plain[reason] = describeSnapshotError(error);
    }

    expect(plain).toEqual({
      "backup-wrong-file": "This file isn't an OxideVM backup.",
      "backup-damaged": "This backup is damaged or incomplete.",
      "backup-newer": "This backup needs a newer version of OxideVM.",
      "backup-older": "This backup is from an older version of OxideVM and can't be opened.",
      "backup-other-environment": "This backup belongs to another environment.",
      "backup-no-space": "There isn't enough space in this browser.",
    });
    expect(describeSnapshotError(new VMError("QUOTA_EXCEEDED", "full"))).toBe("There isn't enough space in this browser.");
    expect(describeSnapshotError(new VMError("ABORTED", "stop"))).toBe("Cancelled.");
    expect(describeSnapshotError(new Error("boom"))).toBe("Something went wrong. Try again.");
    await vm.dispose();
  });

  it("exports, imports and inspects Userspace backups through the same storage owner", async () => {
    const vm = await createRuntimeVM({ mode: "userspace", workspaceId: "userspace", memoryMiB: 256, network: "local" });
    const file = new File([new Uint8Array(1)], "backup.oxvm");

    ScriptedWorker.answers.set("snapshot-export", reporting([[1, 1]], { kind: "written", bytes: 1 }));
    ScriptedWorker.answers.set("snapshot-import", reporting([[1, 1]], { ...IMPORTED, mode: "userspace" }));
    ScriptedWorker.answers.set("snapshot-inspect", () => ({ ...INSPECTION, mode: "userspace" }));
    await expect(vm.snapshots.export(SNAPSHOT)).resolves.toMatchObject({ kind: "written", bytes: 1 });
    await expect(vm.snapshots.import(file)).resolves.toMatchObject({ mode: "userspace" });
    await expect(vm.snapshots.inspect(file)).resolves.toMatchObject({ mode: "userspace" });
    expect(storage().operations).toContain("snapshot-import");
    await vm.dispose();
  });
});
