import { describe, expect, it } from "vitest";

import { VMError } from "../errors.js";
import {
  decodeArchiveProgressMessage,
  decodeBackupExportResult,
  decodeBackupInspection,
  decodeStorageIncoming,
  PROTOCOL_VERSION,
  storageResponseDecoders,
} from "../protocol.js";

const SNAPSHOT = { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-02T10:00:00.000Z" };
const INSPECTION = {
  mode: "system",
  kind: "named",
  label: "Before upgrading Next",
  capturedAtUnixMs: 1_790_000_000_000,
  profile: { id: "alpine", version: "2026.10.02" },
  machine: { memoryMiB: 1536, vcpus: 1 },
  fileBytes: 412 * 1024 * 1024,
  compatible: true,
};

describe("backup requests", () => {
  it("decodes export, import and inspect requests exactly", () => {
    const { port1, port2 } = new MessageChannel();
    const base = { id: 4, version: PROTOCOL_VERSION };
    const file = new Blob([new Uint8Array([1, 2, 3])]);
    // What structured cloning hands the worker for a file the user picked.
    const picked = { kind: "file", name: "backup.oxvm", createWritable: () => Promise.reject(new Error("not in this test")) };

    expect(decodeStorageIncoming({ ...base, type: "snapshot-export", snapshot: SNAPSHOT, progress: port1 })).toMatchObject({ type: "snapshot-export", snapshot: SNAPSHOT });
    expect(decodeStorageIncoming({ ...base, type: "snapshot-export", snapshot: SNAPSHOT, destination: picked, progress: port1 })).toMatchObject({ destination: picked });
    expect(decodeStorageIncoming({ ...base, type: "snapshot-import", file, progress: port1 })).toMatchObject({ file });
    expect(decodeStorageIncoming({ ...base, type: "snapshot-inspect", file })).toMatchObject({ file });
    const shipped = { ...base, type: "snapshot-install-shipped", name: "container-ready", trustedKeyId: "boundary-development-2026", trustedPublicKey: new Uint8Array(32), progress: port1 };
    expect(decodeStorageIncoming(shipped)).toMatchObject({ name: "container-ready", trustedKeyId: "boundary-development-2026" });
    for (const malformed of [
      { ...shipped, name: "../escape" },
      { ...shipped, trustedKeyId: "" },
      { ...shipped, trustedPublicKey: new Uint8Array(31) },
      { ...shipped, progress: undefined },
      { ...shipped, extra: true },
    ]) {
      expect(() => decodeStorageIncoming(malformed), JSON.stringify(Object.keys(malformed))).toThrow(VMError);
    }
    for (const malformed of [
      { ...base, type: "snapshot-export", snapshot: SNAPSHOT },
      { ...base, type: "snapshot-export", snapshot: SNAPSHOT, progress: "port" },
      { ...base, type: "snapshot-export", snapshot: { id: "x" }, progress: port1 },
      { ...base, type: "snapshot-export", snapshot: SNAPSHOT, destination: { kind: "directory" }, progress: port1 },
      { ...base, type: "snapshot-import", file: "backup.oxvm", progress: port1 },
      { ...base, type: "snapshot-import", file, progress: port1, extra: true },
      { ...base, type: "snapshot-inspect", file, progress: port1 },
    ]) {
      expect(() => decodeStorageIncoming(malformed), JSON.stringify(Object.keys(malformed))).toThrow(VMError);
    }
    port1.close();
    port2.close();
  });

  it("decodes what export, import and inspect answer strictly", () => {
    const file = new File([new Uint8Array([1])], "x.oxvm");
    expect(decodeBackupExportResult({ kind: "written", bytes: 42 })).toEqual({ kind: "written", bytes: 42 });
    expect(decodeBackupExportResult({ kind: "file", file, suggestedName: "oxidevm-bun-dev-2026-10-02-1432.oxvm" }))
      .toEqual({ kind: "file", file, suggestedName: "oxidevm-bun-dev-2026-10-02-1432.oxvm" });
    expect(decodeBackupInspection(INSPECTION)).toEqual(INSPECTION);
    expect(storageResponseDecoders["snapshot-import"]).toBeTypeOf("function");
    for (const malformed of [
      () => decodeBackupExportResult({ kind: "written", bytes: -1 }),
      () => decodeBackupExportResult({ kind: "file", file: "x", suggestedName: "oxidevm-x-2026-10-02-1432.oxvm" }),
      () => decodeBackupExportResult({ kind: "file", file, suggestedName: "../../etc/passwd" }),
      () => decodeBackupExportResult({ kind: "file", file, suggestedName: "oxidevm-x-2026-10-02-1432.oxvm", extra: 1 }),
      () => decodeBackupInspection({ ...INSPECTION, compatible: "older-format" }),
      () => decodeBackupInspection({ ...INSPECTION, kind: "favourite" }),
      () => decodeBackupInspection({ ...INSPECTION, machine: { memoryMiB: 8, vcpus: 1 } }),
      () => decodeBackupInspection({ ...INSPECTION, extra: true }),
    ]) {
      expect(malformed).toThrow(VMError);
    }
  });

  it("decodes progress messages of this protocol version only", () => {
    expect(decodeArchiveProgressMessage({ version: PROTOCOL_VERSION, completedBytes: 5, totalBytes: 10 })).toEqual({ completedBytes: 5, totalBytes: 10 });
    for (const malformed of [
      { version: PROTOCOL_VERSION - 1, completedBytes: 5, totalBytes: 10 },
      { version: PROTOCOL_VERSION, completedBytes: 11, totalBytes: 10 },
      { version: PROTOCOL_VERSION, completedBytes: 5, totalBytes: 10, extra: 1 },
    ]) {
      expect(() => decodeArchiveProgressMessage(malformed)).toThrow(VMError);
    }
  });
});
