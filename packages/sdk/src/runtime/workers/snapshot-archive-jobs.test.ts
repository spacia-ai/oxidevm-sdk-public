import { describe, expect, it } from "vitest";

import { ManagedBases } from "./managed-base.js";
import type { ManagedDisk } from "./managed-disk.js";
import { liveGenerationFor } from "./managed-disk-head.js";
import { cachedTestImage, chunkFill, openTestDisk, readChunk, type TestImage } from "./managed-image.test-support.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import {
  type ArchiveRun,
  exportBackup,
  importBackup,
  inspectBackup,
} from "./snapshot-archive-jobs.js";
import { sha256Hex } from "./snapshot-content.js";
import { SnapshotStore, type WorkspaceSource } from "./snapshot-store.js";
import { workspaceSnapshot } from "./workspace-snapshot.test-support.js";

const MIB = 1024 * 1024;
const NOW = Date.parse("2026-10-02T15:00:00.000Z");
const CLOCK = { now: () => NOW, startOfDay: (unixMs: number) => unixMs - (unixMs % 86_400_000) };
const KERNEL = new Uint8Array([0x4b, 0x45, 0x52]);

interface Browser {
  readonly workspace: MemoryDirectory;
  readonly images: MemoryDirectory;
  readonly store: SnapshotStore;
  readonly disk: ManagedDisk;
  readonly image: TestImage;
}

/** A browser with the test image kept and a managed VM of `memoryMiB` booted from it. */
async function browser(memoryMiB = 16, imageVersion = "2026.10.02", workspaceSource?: WorkspaceSource): Promise<Browser> {
  const workspace = new MemoryDirectory("workspace");
  const images = new MemoryDirectory("managed-images");
  const bases = new ManagedBases();
  const image = await cachedTestImage(images, [1, 2, 0, 0], imageVersion);
  const store = await SnapshotStore.open(workspace, {
    images,
    bases,
    workspaceId: "test",
    clock: CLOCK,
    machine: { memoryMiB, vcpus: 1 },
    image: () => ({ id: image.ref.id, version: image.ref.version }),
    ...(workspaceSource === undefined ? {} : { workspace: workspaceSource }),
  });
  const disks = workspace.directory("managed-disks", true);
  const disk = await openTestDisk(disks, images, bases, image, await liveGenerationFor(disks, image.ref));
  await store.rememberBoot({ type: "remember-boot", kernel: KERNEL, managedDisk: true }, disk);
  return { workspace, images, store, disk, image };
}

/** Saves `source` as a named restore point after writing a disk chunk and two RAM chunks. */
async function save(source: Browser, label = "Before upgrading Next") {
  source.disk.write(2 * MIB, new Uint8Array(MIB).fill(9));
  await source.store.openCapture({
    type: "open-capture",
    snapshot: { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-02T10:00:00.000Z" },
    kind: "named",
    label,
    memoryBytes: 16 * MIB,
    vcpus: 1,
  }, source.disk);
  await source.store.sealCapture({
    type: "seal-capture",
    capturedAtUnixMs: Date.parse("2026-10-02T10:00:02.000Z"),
    machineRecord: new Uint8Array([0x4f, 0x58, 0x4d, 0x53, 0, 0, 0, 0, 0, 0, 0, 0]),
    ramChunks: [0, 3],
    // A managed capture reads the disk's changed chunks itself.
    disk: { kind: "managed", bytes: source.disk.length, chunks: [] },
  }, source.disk);
  await source.store.putCaptureChunk("ram", 0, new Uint8Array(MIB).fill(5));
  await source.store.putCaptureChunk("ram", 3, new Uint8Array(MIB).fill(6));
  return source.store.commitCapture();
}

/** A storage queue that runs one turn at a time and logs what ran. */
function queue(log: string[] = []) {
  let tail = Promise.resolve();
  const enqueue = <T>(turn: () => Promise<T>): Promise<T> => {
    const work = tail.then(turn);
    tail = work.then(() => undefined, () => undefined);
    return work;
  };
  return { enqueue, log };
}

function run(overrides: Partial<ArchiveRun> = {}): ArchiveRun {
  return { enqueue: queue().enqueue, signal: new AbortController().signal, now: () => NOW, ...overrides };
}

/** The backup of `source`'s restore point, written to a staged file. */
async function backup(source: Browser, snapshot: { readonly id: string; readonly createdAt: string }): Promise<File> {
  const exported = await exportBackup(source.store, snapshot, { kind: "staged", directory: source.workspace.directory("exports", true) }, run());
  if (exported.kind !== "file") throw new Error("a staged export returns a file");
  return exported.file;
}

function objectCount(browser: Browser): number {
  return browser.workspace.directory("snapshots-v2", true).directory("objects", true).names().length;
}

async function refusal(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("backup export and import", () => {
  it("imports another browser's restore point as a new imported point that restores the same disk", async () => {
    const source = await browser();
    const snapshot = await save(source);
    const file = await backup(source, snapshot);
    const target = await browser();

    const first = await importBackup(target.store, file, run());
    const second = await importBackup(target.store, file, run());

    expect(first).toMatchObject({ kind: "imported", label: "Before upgrading Next", resumable: true, profile: { id: "test-image" } });
    expect(first.ref.id).not.toBe(snapshot.id);
    expect(second.ref.id).not.toBe(first.ref.id);
    expect((await target.store.list()).map((info) => info.ref.id).sort()).toEqual([first.ref.id, second.ref.id].sort());
    const prepared = await target.store.prepareRestore(first.ref, true, target.disk);
    expect(prepared.ramChunks).toEqual([0, 3]);
    const restored = await target.store.commitRestoreDisk();
    target.store.completeRestore();
    if (restored === undefined) throw new Error("the import restored no disk");
    expect([0, 1, 2, 3].map((index) => chunkFill(readChunk(restored, index)).fill)).toEqual([1, 2, 9, 0]);
    restored.close();
  });

  it("writes to a file the user picked, or names a staged file after the restore point", async () => {
    const source = await browser();
    const snapshot = await save(source, "bun dev · 14:32");
    const picked = new MemoryDirectory("downloads").file("backup.oxvm", true);

    const written = await exportBackup(source.store, snapshot, { kind: "handle", handle: picked }, run());
    const staged = await backup(source, snapshot);

    expect(written).toEqual({ kind: "written", bytes: staged.size });
    expect(await sha256Hex(new Uint8Array(await (await picked.getFile()).arrayBuffer()))).toBe(await sha256Hex(new Uint8Array(await staged.arrayBuffer())));
  });

  it("leaves nothing visible after a damaged backup or a cancel, and collection reclaims what it wrote", async () => {
    const source = await browser();
    const file = await backup(source, await save(source));
    const target = await browser();
    const objects = objectCount(target);
    const bytes = new Uint8Array(await file.arrayBuffer());
    bytes[bytes.byteLength - 1100] = (bytes[bytes.byteLength - 1100] ?? 0) ^ 0xff;

    expect(await refusal(importBackup(target.store, new Blob([bytes]), run()))).toMatchObject({ detail: { reason: "backup-damaged" } });
    const cancel = new AbortController();
    const cancelled = importBackup(target.store, file, run({
      signal: cancel.signal,
      progress: (completed) => {
        if (completed > 0) cancel.abort();
      },
    }));
    expect(await refusal(cancelled)).toMatchObject({ code: "ABORTED" });

    expect(await target.store.list()).toEqual([]);
    expect(objectCount(target)).toBeGreaterThan(objects);
    await target.store.maintain();
    expect(objectCount(target)).toBe(objects);
  });

  it("refuses a backup cut short at any point as damaged, leaving nothing behind", async () => {
    const source = await browser();
    const file = await backup(source, await save(source));
    const bytes = new Uint8Array(await file.arrayBuffer());

    for (const fraction of [0.1, 0.5, 0.9]) {
      const target = await browser();
      const cut = bytes.slice(0, Math.floor(bytes.byteLength * fraction));
      expect(await refusal(importBackup(target.store, new Blob([cut]), run())), String(fraction)).toMatchObject({ detail: { reason: "backup-damaged" } });
      expect(await target.store.list(), String(fraction)).toEqual([]);
    }
  });

  it("refuses another machine shape or an image this browser lacks, before writing", async () => {
    const source = await browser();
    const file = await backup(source, await save(source));

    for (const [label, target, reason] of [
      ["other memory", await browser(32), "backup-other-environment"],
      ["other image", await browser(16, "2026.11.01"), "backup-other-environment"],
    ] as const) {
      const objects = objectCount(target);
      const error = await refusal(importBackup(target.store, file, run()));
      expect(error, label).toMatchObject({ detail: { reason } });
      expect(objectCount(target), label).toBe(objects);
    }
  });

  it("lets other storage requests run between the chunks of an export and an import", async () => {
    const source = await browser();
    const snapshot = await save(source);
    const target = await browser();
    const file = await backup(source, snapshot);
    const { enqueue, log } = queue();
    const traced = <T>(turn: () => Promise<T>): Promise<T> => enqueue(async () => {
      log.push("chunk");
      return turn();
    });
    let asked = false;
    const other = (): void => {
      if (asked) return;
      asked = true;
      void enqueue(async () => {
        log.push("other");
        return Promise.resolve();
      });
    };

    await exportBackup(source.store, snapshot, { kind: "staged", directory: source.workspace.directory("exports", true) }, run({ enqueue: traced, progress: other }));
    const exportLog = [...log];
    log.length = 0;
    asked = false;
    await importBackup(target.store, file, run({ enqueue: traced, progress: other }));

    for (const turns of [exportLog, log]) {
      const position = turns.indexOf("other");
      expect(position, turns.join(",")).toBeGreaterThan(0);
      expect(position, turns.join(",")).toBeLessThan(turns.length - 1);
    }
  });

  it("keeps what an export reads and an import stores out of a collection that runs meanwhile", async () => {
    const source = await browser();
    const snapshot = await save(source);
    const { enqueue } = queue();
    let collected = false;
    const collectOnce = (): void => {
      if (collected) return;
      collected = true;
      void enqueue(async () => {
        await source.store.delete(snapshot);
        await source.store.maintain();
      });
    };
    const exported = await exportBackup(source.store, snapshot, { kind: "staged", directory: source.workspace.directory("exports", true) }, run({ enqueue, progress: collectOnce }));
    if (exported.kind !== "file") throw new Error("a staged export returns a file");
    expect(collected).toBe(true);

    const target = await browser();
    collected = false;
    const imported = await importBackup(target.store, exported.file, run({
      enqueue,
      progress: () => {
        if (collected) return;
        collected = true;
        void enqueue(() => target.store.maintain());
      },
    }));

    expect(collected).toBe(true);
    const prepared = await target.store.prepareRestore(imported.ref, true, target.disk);
    expect(prepared.ramChunks).toEqual([0, 3]);
    await target.store.abort();
  });

  it("holds an export's objects only while it reads them, and writes an import's intent ahead", async () => {
    const source = await browser();
    const snapshot = await save(source);
    await backup(source, snapshot);
    // A new boot leaves the saved point, so only the finished export could still hold its objects.
    await source.store.rememberBoot({ type: "remember-boot", kernel: KERNEL, managedDisk: true }, source.disk);
    const before = objectCount(source);
    await source.store.delete(snapshot);
    await source.store.maintain();
    expect(objectCount(source)).toBeLessThan(before);

    const target = await browser();
    const intents = target.workspace.directory("snapshots-v2", true).directory("intents", true);
    const seen: string[][] = [];
    const elsewhere = await browser();
    const file = await backup(elsewhere, await save(elsewhere));
    await importBackup(target.store, file, run({ progress: () => seen.push(intents.names()) }));
    expect(seen.some((names) => names.length === 1)).toBe(true);
    expect(intents.names()).toEqual([]);
  });

  it("commits an import only with every object it needs", async () => {
    const source = await browser();
    const snapshot = await save(source);
    const exported = await source.store.openExport(snapshot);
    const target = await browser();

    const transaction = await target.store.beginImport(exported.manifest);
    exported.release();

    expect(await refusal(transaction.commit())).toMatchObject({ detail: { reason: "snapshot-damaged" } });
    expect(await target.store.list()).toEqual([]);
  });

  it("opens a backup without asking the browser how much space is free", async () => {
    // Brave reports 2 GiB whatever it allows, so its figure for free space cannot refuse a backup.
    const source = await browser();
    const file = await backup(source, await save(source));
    const target = await browser();

    const opened = await importBackup(target.store, file, run());

    expect(opened).toMatchObject({ kind: "imported", resumable: true });
  });

  it("reports a full disk during an import as no space, and leaves nothing visible", async () => {
    const source = await browser();
    const file = await backup(source, await save(source));
    const target = await browser();
    target.workspace.directory("snapshots-v2", true).directory("objects", true).failWrites(new DOMException("no room", "QuotaExceededError"));

    expect(await refusal(importBackup(target.store, file, run()))).toMatchObject({ code: "QUOTA_EXCEEDED", detail: { reason: "backup-no-space" } });
    expect(await target.store.list()).toEqual([]);
  });

  it("refuses a restore point booted with a kernel other than its image's", async () => {
    const source = await browser();
    await source.store.rememberBoot({ type: "remember-boot", kernel: new Uint8Array([0x4b]), managedDisk: true }, source.disk);
    const file = await backup(source, await save(source));
    const target = await browser();

    expect(await refusal(importBackup(target.store, file, run()))).toMatchObject({ detail: { reason: "backup-other-environment" } });
  });

  it("refuses a backup whose image this browser keeps without its kernel", async () => {
    const source = await browser();
    const file = await backup(source, await save(source));
    const target = await browser();
    await target.images.removeEntry(`${target.image.stem}.kernel`);

    expect(await refusal(importBackup(target.store, file, run()))).toMatchObject({ detail: { reason: "backup-other-environment" } });
    expect(await target.store.list()).toEqual([]);
  });

  it("drops the workspace record, which names another browser's workspace store", async () => {
    const base = "e".repeat(64);
    const overlay = { generation: 3, snapshot: workspaceSnapshot([[1, 0o644, "/workspace/app.ts", new TextEncoder().encode("hi")]]) };
    const source = await browser(16, "2026.10.02", { base: () => base, read: () => Promise.resolve(overlay) });
    const file = await backup(source, await save(source));
    const target = await browser(16, "2026.10.02", { base: () => base, read: () => Promise.resolve(overlay) });

    const imported = await importBackup(target.store, file, run());

    await expect(target.store.planWorkspace(imported.ref)).resolves.toEqual({ kind: "unrecorded" });
  });

  it("keeps one staged export, and leaves no file behind when an export fails", async () => {
    const source = await browser();
    const snapshot = await save(source);
    const exports = source.workspace.directory("exports", true);
    await backup(source, snapshot);
    const other = await source.store.rename(snapshot, "Another name");
    await backup(source, other.ref);
    expect(exports.names()).toEqual([expect.stringMatching(/^oxidevm-another-name-/u)]);

    const objects = source.workspace.directory("snapshots-v2", true).directory("objects", true);
    for (const name of objects.names()) await objects.removeEntry(name);
    const picked = new MemoryDirectory("downloads").file("backup.oxvm", true);
    picked.setBytes(new Uint8Array([1, 2, 3]));

    expect(await refusal(exportBackup(source.store, snapshot, { kind: "staged", directory: exports }, run()))).toBeDefined();
    expect(await refusal(exportBackup(source.store, snapshot, { kind: "handle", handle: picked }, run()))).toBeDefined();
    expect(exports.names()).toEqual([]);
    expect(new Uint8Array(await (await picked.getFile()).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("inspects a backup without writing anything", async () => {
    const source = await browser();
    const file = await backup(source, await save(source));
    const target = await browser(32);
    const objects = objectCount(target);

    const inspection = await inspectBackup(target.store, file, NOW);

    expect(inspection).toEqual({
      mode: "system",
      kind: "named",
      label: "Before upgrading Next",
      capturedAtUnixMs: Date.parse("2026-10-02T10:00:02.000Z"),
      profile: { id: "test-image", version: "2026.10.02" },
      machine: { memoryMiB: 16, vcpus: 1 },
      fileBytes: file.size,
      compatible: "machine-mismatch",
    });
    expect(objectCount(target)).toBe(objects);
    expect(await refusal(inspectBackup(target.store, new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), NOW)))
      .toMatchObject({ detail: { reason: "backup-wrong-file" } });
  });
});
