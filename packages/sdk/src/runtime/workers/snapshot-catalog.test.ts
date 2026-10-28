import { describe, expect, it } from "vitest";

import { MemoryDirectory, MemoryFile } from "./opfs-double.test-support.js";
import { SnapshotCatalog } from "./snapshot-catalog.js";
import { encodeSnapshotManifest, type ObjectRef, type SnapshotManifest } from "./snapshot-manifest.js";
import { sha256Hex } from "./snapshot-content.js";
import { SnapshotObjects, writeOpfsFile } from "./snapshot-objects.js";
import {decodeShippedInstallIdentity} from "../protocol/shipped-source.js";

const FIRST = "123e4567-e89b-42d3-a456-426614174001";
const SECOND = "123e4567-e89b-42d3-a456-426614174002";
const THIRD = "123e4567-e89b-42d3-a456-426614174003";

interface Fixture {
  readonly root: MemoryDirectory;
  readonly objects: SnapshotObjects;
  readonly catalog: SnapshotCatalog;
  readonly record: ObjectRef;
  readonly kernel: ObjectRef;
}

async function fixture(): Promise<Fixture> {
  const root = new MemoryDirectory("snapshots-v2");
  const objects = await SnapshotObjects.open(root);
  const record = await objects.put(new Uint8Array([0x4f, 0x58, 0x4d, 0x53, 0, 0, 0, 0, 0, 0, 0, 0]));
  const kernel = await objects.put(new Uint8Array([0x4b]));
  return { root, objects, catalog: new SnapshotCatalog(root, objects), record, kernel };
}

function manifest(context: Fixture, id: string, options: { label?: string; ram?: ObjectRef } = {}): SnapshotManifest {
  return {
    schema: 2,
    id,
    createdAt: "2026-10-02T10:00:00.000Z",
    kind: "named",
    ...(options.label === undefined ? {} : { label: options.label }),
    capturedAtUnixMs: 1_790_000_000_000 + Number(id.slice(-1)),
    parent: null,
    machine: { record: context.record, memoryBytes: 16 * 1024 * 1024, vcpus: 1 },
    ram: options.ram === undefined ? [] : [{ index: 0, ...options.ram }],
    disk: null,
    assets: { kernel: context.kernel },
  };
}

function file(root: MemoryDirectory, path: string): MemoryFile {
  const found = root.find(path);
  if (!(found instanceof MemoryFile)) throw new Error(`${path} is missing`);
  return found;
}

function names(root: MemoryDirectory, path: string): string[] {
  const found = root.find(path);
  return found instanceof MemoryDirectory ? found.names() : [];
}

async function writeManifestOnly(root: MemoryDirectory, value: SnapshotManifest): Promise<void> {
  await writeOpfsFile(root.directory("manifests", true), `${value.id}.json`, encodeSnapshotManifest(value));
}

/** Replaces a committed manifest with `value` and a commit marker that matches it. */
async function recommit(root: MemoryDirectory, id: string, value: unknown): Promise<void> {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  await writeOpfsFile(root.directory("manifests", true), `${id}.json`, bytes);
  await writeOpfsFile(root.directory("commits", true), id, new TextEncoder().encode(await sha256Hex(bytes)));
}

async function failure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("snapshot catalog", () => {
  it("commits shipped source identity with its manifest and reads legacy manifests", async () => {
    const context = await fixture();
    const source = decodeShippedInstallIdentity({mode:"system",snapshotManifestSHA256:"ab".repeat(32),imageManifestSHA256:"cd".repeat(32)});
    await context.catalog.commit(manifest(context, FIRST), source);
    expect(await context.catalog.shippedSource(FIRST)).toEqual(source);
    expect((await context.catalog.load(FIRST)).id).toBe(FIRST);
    await context.catalog.commit(manifest(context, SECOND));
    expect(await context.catalog.shippedSource(SECOND)).toBeUndefined();
  });
  it("rolls back a capture the tab closed between its manifest and its commit marker", async () => {
    const context = await fixture();
    await context.catalog.beginIntent({ kind: "capture", snapshot: FIRST });
    await writeManifestOnly(context.root, manifest(context, FIRST));

    await context.catalog.recover();

    expect(await context.catalog.exists(FIRST)).toBe(false);
    expect(names(context.root, "intents")).toEqual([]);
  });

  it("keeps a capture whose commit marker landed before the tab closed", async () => {
    const context = await fixture();
    await context.catalog.beginIntent({ kind: "capture", snapshot: FIRST });
    await context.catalog.commit(manifest(context, FIRST));

    await context.catalog.recover();

    expect(await context.catalog.load(FIRST)).toMatchObject({ id: FIRST });
    expect(names(context.root, "intents")).toEqual([]);
  });

  it("finishes a delete the tab closed in the middle of", async () => {
    const context = await fixture();
    await context.catalog.commit(manifest(context, FIRST));
    await context.catalog.beginIntent({ kind: "delete", snapshot: FIRST });

    await context.catalog.recover();

    expect(await context.catalog.exists(FIRST)).toBe(false);
  });

  it("finishes a rename the tab closed between its manifest and its commit marker", async () => {
    const context = await fixture();
    await context.catalog.commit(manifest(context, FIRST));
    await context.catalog.beginIntent({ kind: "rename", snapshot: FIRST, label: "Before upgrading Next" });
    await writeManifestOnly(context.root, manifest(context, FIRST, { label: "Before upgrading Next" }));
    expect(await failure(context.catalog.load(FIRST))).toMatchObject({ detail: { reason: "snapshot-damaged" } });

    await context.catalog.recover();

    expect(await context.catalog.load(FIRST)).toMatchObject({ label: "Before upgrading Next" });
  });

  it("drops an intent it cannot read instead of refusing to open", async () => {
    const context = await fixture();
    context.root.directory("intents", true).file(`${FIRST}.json`, true).setBytes(new TextEncoder().encode("{"));

    await context.catalog.recover();

    expect(names(context.root, "intents")).toEqual([]);
  });

  it("lists readable restore points newest first and a damaged one after them", async () => {
    const context = await fixture();
    await context.catalog.commit(manifest(context, FIRST));
    await context.catalog.commit(manifest(context, SECOND));
    await context.catalog.commit(manifest(context, THIRD));
    file(context.root, `manifests/${SECOND}.json`).setBytes(new TextEncoder().encode("{}"));

    const entries = await context.catalog.list();

    expect(entries.map((entry) => entry.id)).toEqual([THIRD, FIRST, SECOND]);
    expect(entries[2]).toMatchObject({ damaged: { code: "STORAGE_ERROR", detail: { reason: "snapshot-damaged" } } });
  });

  it("reads what a damaged restore point still says about itself", async () => {
    const context = await fixture();
    const named = manifest(context, FIRST, { label: "Before upgrading Next" });
    await context.catalog.commit(named);
    await context.catalog.commit(manifest(context, SECOND));
    // A newer OxideVM rewrote FIRST in a later schema; SECOND's manifest cannot be read at all.
    await recommit(context.root, FIRST, { ...JSON.parse(new TextDecoder().decode(encodeSnapshotManifest(named))), schema: 5 });
    await recommit(context.root, SECOND, "{");

    const entries = await context.catalog.list();

    expect(entries).toMatchObject([
      {
        id: FIRST,
        damaged: { detail: { reason: "snapshot-newer-format" } },
        identity: { createdAt: named.createdAt, kind: "named", label: "Before upgrading Next", capturedAtUnixMs: named.capturedAtUnixMs },
      },
      {
        id: SECOND,
        damaged: { detail: { reason: "snapshot-damaged" } },
        identity: { createdAt: "1970-01-01T00:00:00.000Z", kind: "automatic", capturedAtUnixMs: 0 },
      },
    ]);
  });

  it("removes manifests without commit markers and markers without manifests", async () => {
    const context = await fixture();
    await context.catalog.commit(manifest(context, FIRST));
    await writeManifestOnly(context.root, manifest(context, SECOND));
    context.root.directory("commits", true).file(THIRD, true).setBytes(new TextEncoder().encode("0".repeat(64)));

    await context.catalog.collect([]);

    expect(names(context.root, "manifests")).toEqual([`${FIRST}.json`]);
    expect(names(context.root, "commits")).toEqual([FIRST]);
  });

  it("keeps the objects of a restore point whose commit marker no longer matches", async () => {
    const context = await fixture();
    const ram = await context.objects.put(new Uint8Array(1024 * 1024).fill(5));
    const garbage = await context.objects.put(new Uint8Array(4).fill(6));
    await context.catalog.commit(manifest(context, FIRST, { ram }));
    await writeManifestOnly(context.root, manifest(context, FIRST, { label: "edited", ram }));

    expect(await context.catalog.collect([])).toBe(4);

    expect(names(context.root, "objects")).toContain(ram.sha256);
    expect(names(context.root, "objects")).not.toContain(garbage.sha256);
  });

  it("removes no object while a restore point cannot be read at all", async () => {
    const context = await fixture();
    const garbage = await context.objects.put(new Uint8Array(4).fill(6));
    await context.catalog.commit(manifest(context, FIRST));
    file(context.root, `manifests/${FIRST}.json`).setBytes(new TextEncoder().encode("not json"));

    expect(await context.catalog.collect([])).toBe(0);

    expect(names(context.root, "objects")).toContain(garbage.sha256);
  });

  it("refuses a name longer than 256 bytes", async () => {
    const context = await fixture();
    await context.catalog.commit(manifest(context, FIRST));

    expect(await failure(context.catalog.rename(FIRST, "x".repeat(257)))).toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("reports a restore point that does not exist as not found", async () => {
    const context = await fixture();

    expect(await failure(context.catalog.delete(FIRST))).toMatchObject({ code: "STORAGE_NOT_FOUND" });
    expect(await failure(context.catalog.rename(FIRST, "name"))).toMatchObject({ code: "STORAGE_NOT_FOUND" });
  });
});

describe("older userspace manifests in the catalogue", () => {
  it("lists only restorable manifests and reports an older userspace manifest only when it is named", async () => {
    const context = await fixture();
    await context.catalog.commit(manifest(context, FIRST));
    const legacy = new TextEncoder().encode(JSON.stringify({ schema: 3, mode: "linux-user", id: SECOND, createdAt: "2026-10-02T10:00:00.000Z", kind: "automatic", capturedAtUnixMs: 1_790_000_000_001, parent: null }));
    await writeOpfsFile(await context.root.getDirectoryHandle("manifests", { create: true }), `${SECOND}.json`, legacy);
    await writeOpfsFile(await context.root.getDirectoryHandle("commits", { create: true }), SECOND, new TextEncoder().encode(await sha256Hex(legacy)));
    expect((await SnapshotCatalog.inspectList(context.root)).map(entry => entry.id)).toEqual([FIRST]);
    await expect(SnapshotCatalog.inspect(context.root, SECOND)).rejects.toMatchObject({ code: "SNAPSHOT_VERSION" });
  });
});
