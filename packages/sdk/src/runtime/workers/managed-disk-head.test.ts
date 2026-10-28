import { describe, expect, it } from "vitest";

import {
  clearResumePoint,
  collectGenerations,
  freshGenerationFor,
  generationFor,
  liveGenerationFor,
  managedImageStem,
  preResumeGenerationFor,
  promoteGeneration,
  readDiskHead,
  settleHead,
  writeDiskHead,
  writeGenerationRecord,
} from "./managed-disk-head.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";

const FIRST = { id: "alpine", version: "2026.10.01", identity: "a".repeat(64) };
const SECOND = { id: "alpine", version: "2026.10.02", identity: "b".repeat(64) };
const SAVED = "123e4567-e89b-42d3-a456-426614174001";
const LATER = "123e4567-e89b-42d3-a456-426614174002";

async function generation(disks: MemoryDirectory, name: string, image: typeof FIRST): Promise<void> {
  await writeGenerationRecord(disks.directory(name, true), { schema: 1, image, bytes: 4096, changeBase: null });
}

async function failure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("managed disk head", () => {
  it("boots an image's own generation and records it when there is no head", async () => {
    const disks = new MemoryDirectory("managed-disks");

    expect(await liveGenerationFor(disks, FIRST)).toBe(managedImageStem(FIRST));
    expect(await readDiskHead(disks)).toEqual({ schema: 1, generation: managedImageStem(FIRST), previous: null, resume: null });
  });

  it("keeps booting the head generation while it runs the same image", async () => {
    const disks = new MemoryDirectory("managed-disks");
    await generation(disks, "g-restored", FIRST);
    await promoteGeneration(disks, "g-restored", SAVED);

    expect(await liveGenerationFor(disks, FIRST)).toBe("g-restored");
  });

  it("moves to another image only on an update, never on a live boot or a restart", async () => {
    const disks = new MemoryDirectory("managed-disks");
    await generation(disks, "g-restored", FIRST);
    await promoteGeneration(disks, "g-restored", SAVED);
    const head = await readDiskHead(disks);

    expect(await failure(liveGenerationFor(disks, SECOND))).toMatchObject({ detail: { reason: "disk-runs-another-image" } });
    expect(await failure(generationFor(disks, SECOND, "pre-resume"))).toMatchObject({ detail: { reason: "disk-runs-another-image" } });
    expect(await readDiskHead(disks)).toEqual(head);
    expect((await collectGenerations(disks, new Set())).removed).toEqual([]);

    expect(await generationFor(disks, SECOND, "update-image")).toBe(managedImageStem(SECOND));
    expect(await readDiskHead(disks)).toEqual({ schema: 1, generation: managedImageStem(SECOND), previous: null, resume: null });
  });

  it("keeps the generation each restore replaced, which holds the newest files, until a named save releases it", async () => {
    const disks = new MemoryDirectory("managed-disks");
    await liveGenerationFor(disks, FIRST);

    await promoteGeneration(disks, "g-first-restore", SAVED);
    // Work since the first restore lives on its generation, so the second restore keeps that one.
    await promoteGeneration(disks, "g-second-restore", SAVED);
    expect(await readDiskHead(disks)).toEqual({
      schema: 1,
      generation: "g-second-restore",
      previous: "g-first-restore",
      resume: SAVED,
    });

    // An automatic or safety save keeps it.
    expect(await settleHead(disks, LATER, false)).toBeNull();
    expect(await readDiskHead(disks)).toEqual({ schema: 1, generation: "g-second-restore", previous: "g-first-restore", resume: LATER });
    expect(await settleHead(disks, LATER, true)).toBe("g-first-restore");
    expect(await readDiskHead(disks)).toEqual({ schema: 1, generation: "g-second-restore", previous: null, resume: LATER });
    expect(await settleHead(disks, LATER, true)).toBeNull();
  });

  it("forgets the generation a resume replaced once the live disk boots again", async () => {
    const disks = new MemoryDirectory("managed-disks");
    await generation(disks, managedImageStem(FIRST), FIRST);
    await liveGenerationFor(disks, FIRST);
    await generation(disks, "g-resumed", FIRST);
    await promoteGeneration(disks, "g-resumed", SAVED);

    // A restart or the next page's start: the resume's work is on the live disk now.
    expect(await liveGenerationFor(disks, FIRST)).toBe("g-resumed");
    expect(await readDiskHead(disks)).toEqual({ schema: 1, generation: "g-resumed", previous: null, resume: SAVED });
    // So "Restart instead" can only ever boot the disk this session's resume replaced.
    expect(await preResumeGenerationFor(disks, FIRST)).toBe("g-resumed");
  });

  it("remembers the restore point the running VM matches until the image boots cold", async () => {
    const disks = new MemoryDirectory("managed-disks");
    await liveGenerationFor(disks, FIRST);
    await generation(disks, "g-restored", FIRST);

    await promoteGeneration(disks, "g-restored", SAVED);
    expect((await readDiskHead(disks))?.resume).toBe(SAVED);
    await settleHead(disks, LATER, true);
    expect((await readDiskHead(disks))?.resume).toBe(LATER);
    await clearResumePoint(disks);
    expect(await readDiskHead(disks)).toEqual({ schema: 1, generation: "g-restored", previous: null, resume: null });
    // A head written before restore points resumed reads as having none.
    disks.file("head.json", true).setBytes(new TextEncoder().encode('{"schema":1,"generation":"g-restored","previous":null}'));
    expect((await readDiskHead(disks))?.resume).toBeNull();
  });

  it("restarts from the generation the last resume replaced, forgetting the resume point", async () => {
    const disks = new MemoryDirectory("managed-disks");
    await generation(disks, managedImageStem(FIRST), FIRST);
    await liveGenerationFor(disks, FIRST);
    await generation(disks, "g-resumed", FIRST);
    await promoteGeneration(disks, "g-resumed", SAVED);

    expect(await preResumeGenerationFor(disks, FIRST)).toBe(managedImageStem(FIRST));
    expect(await readDiskHead(disks)).toEqual({ schema: 1, generation: managedImageStem(FIRST), previous: null, resume: null });
    // Without a pre-resume generation, the live one boots.
    expect(await preResumeGenerationFor(disks, FIRST)).toBe(managedImageStem(FIRST));
  });

  it("starts a fresh image on a new generation that nothing else boots", async () => {
    const disks = new MemoryDirectory("managed-disks");
    await liveGenerationFor(disks, FIRST);
    await promoteGeneration(disks, "g-resumed", SAVED);

    const fresh = await freshGenerationFor(disks);

    expect(fresh).toMatch(/^g-[0-9a-f-]{36}$/u);
    expect(await readDiskHead(disks)).toEqual({ schema: 1, generation: fresh, previous: null, resume: null });
  });

  it("boots the generation each kind of start asks for", async () => {
    async function resumed(): Promise<MemoryDirectory> {
      const disks = new MemoryDirectory("managed-disks");
      await generation(disks, managedImageStem(FIRST), FIRST);
      await generation(disks, "g-resumed", FIRST);
      await liveGenerationFor(disks, FIRST);
      await promoteGeneration(disks, "g-resumed", SAVED);
      return disks;
    }

    expect(await generationFor(await resumed(), FIRST, "live")).toBe("g-resumed");
    expect(await generationFor(await resumed(), FIRST, "pre-resume")).toBe(managedImageStem(FIRST));
    expect(await generationFor(await resumed(), FIRST, "fresh-image")).toMatch(/^g-/u);
  });

  it("rejects a damaged head instead of guessing a generation", async () => {
    const disks = new MemoryDirectory("managed-disks");
    disks.file("head.json", true).setBytes(new TextEncoder().encode('{"schema":1,"generation":"../escape","previous":null}'));

    expect(await failure(readDiskHead(disks))).toMatchObject({ code: "STORAGE_ERROR" });
  });

  it("collects restore generations and superseded per-image ones, never live ones or another image's", async () => {
    const disks = new MemoryDirectory("managed-disks");
    for (const name of ["g-live", "g-previous", "g-orphan", "g-building", managedImageStem(FIRST)]) {
      await generation(disks, name, FIRST);
    }
    await generation(disks, managedImageStem(SECOND), SECOND);
    await writeDiskHead(disks, { schema: 1, generation: "g-live", previous: "g-previous", resume: null });

    const collected = await collectGenerations(disks, new Set(["g-building"]));

    expect(collected.removed).toEqual(["g-orphan", managedImageStem(FIRST)].sort());
    expect(collected.liveImages).toEqual([FIRST]);
    expect(disks.names()).toEqual(["g-building", "g-live", "g-previous", "head.json", managedImageStem(SECOND)].sort());
  });

  it("leaves a generation whose files are still open for a later pass", async () => {
    const disks = new MemoryDirectory("managed-disks");
    await generation(disks, "g-live", FIRST);
    await generation(disks, "g-orphan", FIRST);
    await writeDiskHead(disks, { schema: 1, generation: "g-live", previous: null, resume: null });
    const handle = await disks.directory("g-orphan", false).file("overlay.bitmap", true).createSyncAccessHandle();

    expect((await collectGenerations(disks, new Set())).removed).toEqual([]);
    handle.close();
    expect((await collectGenerations(disks, new Set())).removed).toEqual(["g-orphan"]);
  });
});
