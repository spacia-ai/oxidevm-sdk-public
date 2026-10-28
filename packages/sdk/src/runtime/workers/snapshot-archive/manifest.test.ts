import { describe, expect, it } from "vitest";

import { decodeSnapshotManifest, type SnapshotManifest } from "../snapshot-manifest.js";
import { backupFixture, hash, MIB, NOW } from "./backup.test-support.js";
import { backupObjectsOf, decodeBackupManifest, encodeBackupManifest, MAX_BACKUP_MANIFEST_BYTES } from "./manifest.js";

const encoder = new TextEncoder();

/** The JSON of a valid manifest, edited by `change`. */
function edited(
  change: (manifest: Record<string, unknown>) => void,
  snapshot: SnapshotManifest = decodeSnapshotManifest(backupFixture()),
): Uint8Array {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(encodeBackupManifest(snapshot)));
  if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
  const fields: Record<string, unknown> = { ...parsed };
  change(fields);
  return encoder.encode(JSON.stringify(fields));
}

function refusal(bytes: Uint8Array): unknown {
  try {
    decodeBackupManifest(bytes, NOW);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("backup manifest", () => {
  it("round-trips a restore point and lists every object but the profile's boot assets", () => {
    const snapshot = decodeSnapshotManifest(backupFixture());

    const decoded = decodeBackupManifest(encodeBackupManifest(snapshot), NOW);

    expect(decoded.snapshot).toEqual(snapshot);
    expect(decoded.objects.map((object) => object.sha256)).toEqual([1, 2, 3, 4, 6, 7, 8].map(hash));
    expect(encodeBackupManifest(decoded.snapshot)).toEqual(encodeBackupManifest(snapshot));
  });

  it("carries the kernel, initrd and base of a raw-kernel machine", () => {
    const raw = decodeSnapshotManifest(backupFixture({
      disk: {
        origin: "core",
        bytes: 2 * MIB,
        baseIdentity: hash(100),
        base: [{ index: 0, sha256: hash(9), bytes: MIB }],
        chunks: [{ index: 1, sha256: hash(10), bytes: MIB }],
      },
      assets: { kernel: { sha256: hash(5), bytes: 10 }, initrd: { sha256: hash(11), bytes: 20 } },
    }));

    expect(backupObjectsOf(raw).map((object) => object.sha256)).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10, 11].map(hash));
  });

  it("reports a file that is not a backup, or one from a newer or older OxideVM, before any strict check", () => {
    const cases: [Uint8Array, string][] = [
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "backup-wrong-file"],
      [encoder.encode("[1, 2, 3]"), "backup-wrong-file"],
      [encoder.encode('{"format":"zip"}'), "backup-wrong-file"],
      [encoder.encode('{"format":"oxidevm-backup","formatVersion":2,"somethingNew":true}'), "backup-newer"],
      [encoder.encode('{"format":"oxidevm-backup","formatVersion":0}'), "backup-older"],
      [edited((fields) => { fields["snapshot"] = { schema: 5, somethingNew: true }; }), "backup-newer"],
      [edited((fields) => { fields["snapshot"] = { schema: 1 }; }), "backup-older"],
      [edited((fields) => { fields["extra"] = true; }), "backup-damaged"],
      [encoder.encode('{"format":"oxidevm-backup","formatVersion":"1"}'), "backup-damaged"],
    ];
    for (const [bytes, reason] of cases) {
      expect(refusal(bytes), new TextDecoder().decode(bytes.slice(0, 80))).toMatchObject({ detail: { reason } });
    }
    expect(refusal(cases[3]?.[0] ?? new Uint8Array())).toMatchObject({ code: "SNAPSHOT_VERSION" });
    expect(refusal(cases[0]?.[0] ?? new Uint8Array())).toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("enforces every limit of the description", () => {
    const damaged = { detail: { reason: "backup-damaged" } };
    const oversized = new Uint8Array(MAX_BACKUP_MANIFEST_BYTES + 1).fill(0x20);
    oversized.set(encodeBackupManifest(decodeSnapshotManifest(backupFixture())));
    expect(refusal(oversized), "manifest size").toMatchObject(damaged);

    const record = { sha256: hash(1), bytes: 4096 };
    const disk = {
      origin: "managed",
      bytes: 64 * 1024 * MIB + 512,
      baseIdentity: hash(100),
      image: { id: "alpine", version: "1" },
      chunks: [{ index: 0, zero: true }, { index: 2, sha256: hash(4), bytes: MIB }],
    };
    for (const [label, fields] of [
      ["memory below 16 MiB", backupFixture({ machine: { record, memoryBytes: 15 * MIB, vcpus: 1 } })],
      ["memory above 3 GiB", backupFixture({ machine: { record, memoryBytes: 3073 * MIB, vcpus: 1 } })],
      ["machine record above 128 MiB", backupFixture({ machine: { record: { sha256: hash(1), bytes: 128 * MIB + 1 }, memoryBytes: 16 * MIB, vcpus: 1 } })],
      ["disk above 64 GiB", backupFixture({ disk })],
      ["label above 256 bytes", backupFixture({ label: "x".repeat(257) })],
      ["capture before 2020", backupFixture({ capturedAtUnixMs: Date.UTC(2019, 11, 31) })],
      ["capture after tomorrow", backupFixture({ capturedAtUnixMs: NOW + 24 * 3_600_000 + 1 })],
      ["created before 2020", backupFixture({ createdAt: "2019-12-31T23:59:59.999Z" })],
      ["one hash, two sizes", backupFixture({ ram: [{ index: 0, sha256: hash(1), bytes: MIB }] })],
    ] as const) {
      const bytes = edited((manifest) => {
        manifest["snapshot"] = fields;
      });
      expect(refusal(bytes), label).toMatchObject(damaged);
    }
  });
});
