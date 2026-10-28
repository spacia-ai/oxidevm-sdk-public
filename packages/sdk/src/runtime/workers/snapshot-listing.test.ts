import { describe, expect, it } from "vitest";

import { VMError } from "../errors.js";
import type { CatalogEntry } from "./snapshot-catalog.js";
import { describeSnapshots, type ListingContext } from "./snapshot-listing.js";
import type { ObjectRef, SystemSnapshotManifest } from "./snapshot-manifest.js";

const MIB = 1024 * 1024;
const NEWER = "123e4567-e89b-42d3-a456-426614174002";
const OLDER = "123e4567-e89b-42d3-a456-426614174001";
const ALPINE = { id: "alpine", version: "2026.10.02", identity: "e".repeat(64) };
const CAPTURED = "2026-10-02T14:32:00.000Z";

function object(n: number, bytes = MIB): ObjectRef {
  return { sha256: n.toString(16).padStart(64, "0"), bytes };
}

function manifest(id: string, overrides: Partial<SystemSnapshotManifest> = {}): SystemSnapshotManifest {
  return {
    schema: 2,
    id,
    createdAt: CAPTURED,
    kind: "automatic",
    capturedAtUnixMs: Date.parse(CAPTURED),
    parent: null,
    machine: { record: object(1, 4096), memoryBytes: 256 * MIB, vcpus: 1 },
    ram: [{ index: 0, ...object(10) }, { index: 1, ...object(11) }],
    disk: {
      origin: "managed",
      bytes: 64 * MIB,
      baseIdentity: ALPINE.identity,
      image: { id: ALPINE.id, version: ALPINE.version },
      chunks: [{ index: 0, zero: true }, { index: 3, ...object(20) }],
    },
    assets: { kernel: object(2, 10 * MIB) },
    ...overrides,
  };
}

function stored(value: SystemSnapshotManifest): CatalogEntry {
  return { id: value.id, manifest: value };
}

const CONTEXT: ListingContext = {
  machine: { memoryMiB: 256, vcpus: 1 },
  image: ALPINE,
  cachedImages: new Set([ALPINE.identity]),
};

describe("restore point listing", () => {
  it("describes a saved point the running VM can resume", () => {
    const [info] = describeSnapshots([stored(manifest(NEWER, { kind: "named", label: "bun dev · 14:32" }))], CONTEXT);

    expect(info).toEqual({
      mode: "system",
      ref: { id: NEWER, createdAt: CAPTURED },
      kind: "named",
      label: "bun dev · 14:32",
      capturedAtUnixMs: Date.parse(CAPTURED),
      profile: { id: "alpine", version: "2026.10.02" },
      bytes: { ram: 2 * MIB, disk: MIB, unique: 4096 + 10 * MIB + 3 * MIB },
      resumable: true,
    });
  });

  it("counts as unique only what no other restore point shares", () => {
    const older = manifest(OLDER);
    const newer = manifest(NEWER, {
      machine: { record: object(3, 4096), memoryBytes: 256 * MIB, vcpus: 1 },
      ram: [{ index: 0, ...object(10) }, { index: 1, ...object(12) }, { index: 2, ...object(12) }],
    });

    const [first, second] = describeSnapshots([stored(newer), stored(older)], CONTEXT);

    // The kernel, RAM chunk 10 and the disk chunk are shared; a chunk repeated inside one point
    // is one object.
    expect(first?.bytes).toEqual({ ram: 3 * MIB, disk: MIB, unique: 4096 + MIB });
    expect(second?.bytes).toEqual({ ram: 2 * MIB, disk: MIB, unique: 4096 + MIB });
  });

  it("says why a restore point cannot resume this VM", () => {
    const resumable = (value: SystemSnapshotManifest, context: ListingContext = CONTEXT) =>
      describeSnapshots([stored(value)], context)[0]?.resumable;
    const raw = manifest(NEWER, { disk: null });

    expect(resumable(manifest(NEWER, { machine: { record: object(1), memoryBytes: 512 * MIB, vcpus: 1 } })))
      .toBe("machine-mismatch");
    expect(resumable(manifest(NEWER, { machine: { record: object(1), memoryBytes: 256 * MIB, vcpus: 2 } })))
      .toBe("machine-mismatch");
    expect(resumable(manifest(NEWER, {
      disk: { origin: "managed", bytes: MIB, baseIdentity: "f".repeat(64), image: { id: "boundary", version: "1" }, chunks: [] },
    }))).toBe("profile-mismatch");
    expect(resumable(manifest(NEWER), { ...CONTEXT, image: undefined })).toBe("profile-mismatch");
    expect(resumable(raw)).toBe("profile-mismatch");
    expect(resumable(raw, { ...CONTEXT, image: undefined })).toBe(true);
    expect(resumable(manifest(NEWER), { ...CONTEXT, cachedImages: new Set() })).toBe("base-missing");
    // An earlier version of the same image stays resumable while its base is kept.
    expect(resumable(manifest(NEWER, {
      disk: { origin: "managed", bytes: MIB, baseIdentity: "d".repeat(64), image: { id: "alpine", version: "2026.09.01" }, chunks: [] },
    }), { ...CONTEXT, cachedImages: new Set([ALPINE.identity, "d".repeat(64)]) })).toBe(true);
  });

  it("lists a damaged restore point with what it still says about itself, so it can be deleted", () => {
    const identity = { createdAt: CAPTURED, kind: "named", label: "Before upgrading Next", capturedAtUnixMs: Date.parse(CAPTURED) } as const;
    const damaged = (reason: string): CatalogEntry => ({
      id: OLDER,
      damaged: new VMError("STORAGE_ERROR", "snapshot manifest is damaged", { reason }),
      identity,
    });

    const infos = describeSnapshots(
      [damaged("snapshot-older-format"), damaged("snapshot-newer-format"), damaged("snapshot-damaged")],
      CONTEXT,
    );

    expect(infos.map((info) => info.resumable)).toEqual(["older-format", "newer-format", "corrupt"]);
    expect(infos[0]).toEqual({
      mode: "system",
      ref: { id: OLDER, createdAt: CAPTURED },
      kind: "named",
      label: "Before upgrading Next",
      capturedAtUnixMs: Date.parse(CAPTURED),
      profile: null,
      bytes: { ram: 0, disk: 0, unique: 0 },
      resumable: "older-format",
    });
  });
});
