import { describe, expect, it } from "vitest";

import { VMError } from "../errors.js";
import { decodeStorageIncoming, PROTOCOL_VERSION, storageResponseDecoders } from "../protocol.js";

const SNAPSHOT = { id: "123e4567-e89b-42d3-a456-426614174001", createdAt: "2026-10-02T10:00:00.000Z" };

const INFO = {
  mode: "system",
  ref: SNAPSHOT,
  kind: "named",
  label: "bun dev · 14:32",
  capturedAtUnixMs: Date.parse("2026-10-02T14:32:00.000Z"),
  profile: { id: "alpine", version: "2026.10.02" },
  bytes: { ram: 512 * 1024 * 1024, disk: 64 * 1024 * 1024, unique: 120 * 1024 * 1024 },
  resumable: true,
};

function request(type: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 7, version: PROTOCOL_VERSION, type, ...fields };
}

describe("restore point catalogue protocol", () => {
  it("decodes each catalogue request exactly", () => {
    expect(decodeStorageIncoming(request("snapshot-list"))).toEqual(request("snapshot-list"));
    expect(decodeStorageIncoming(request("snapshot-usage"))).toEqual(request("snapshot-usage"));
    expect(decodeStorageIncoming(request("snapshot-delete", { snapshot: SNAPSHOT })))
      .toEqual(request("snapshot-delete", { snapshot: SNAPSHOT }));
    expect(decodeStorageIncoming(request("snapshot-rename", { snapshot: SNAPSHOT, label: "Before upgrading Next" })))
      .toEqual(request("snapshot-rename", { snapshot: SNAPSHOT, label: "Before upgrading Next" }));
  });

  it("asks for the restore points a resume tries", () => {
    expect(decodeStorageIncoming(request("snapshot-resume-candidates"))).toEqual(request("snapshot-resume-candidates"));
    expect(() => decodeStorageIncoming(request("snapshot-resume-candidates", { snapshot: SNAPSHOT }))).toThrow(VMError);
    expect(storageResponseDecoders["snapshot-resume-candidates"]([INFO])).toEqual([INFO]);
  });

  it("tells the storage worker which disk generation a managed image boots", () => {
    const prepare = request("prepare-managed-image", { manifestUrl: "https://ide.example.test/managed/manifest.json" });

    for (const boot of ["live", "pre-resume", "fresh-image"]) {
      expect(decodeStorageIncoming({ ...prepare, boot })).toMatchObject({ boot });
    }
    expect(decodeStorageIncoming(prepare)).not.toHaveProperty("boot");
    expect(() => decodeStorageIncoming({ ...prepare, boot: "previous" })).toThrow(VMError);
  });

  it("rejects malformed catalogue requests and extra fields", () => {
    for (const malformed of [
      request("snapshot-list", { extra: true }),
      request("snapshot-usage", { snapshot: SNAPSHOT }),
      request("snapshot-delete"),
      request("snapshot-delete", { snapshot: { ...SNAPSHOT, id: "latest" } }),
      request("snapshot-delete", { snapshot: { ...SNAPSHOT, extra: 1 } }),
      request("snapshot-rename", { snapshot: SNAPSHOT }),
      request("snapshot-rename", { snapshot: SNAPSHOT, label: "" }),
      request("snapshot-rename", { snapshot: SNAPSHOT, label: "   " }),
      request("snapshot-rename", { snapshot: SNAPSHOT, label: "x".repeat(257) }),
      request("snapshot-rename", { snapshot: SNAPSHOT, label: 7 }),
      { ...request("snapshot-list"), version: PROTOCOL_VERSION - 1 },
    ]) {
      expect(() => decodeStorageIncoming(malformed), JSON.stringify(malformed)).toThrow(VMError);
    }
  });

  it("tells the storage worker which machine its restore points must fit", () => {
    const { port1, port2 } = new MessageChannel();
    const initialize = request("initialize", { workspaceId: "default", snapshotPort: port1, machine: { memoryMiB: 1536, vcpus: 1 } });

    expect(decodeStorageIncoming(initialize)).toMatchObject({ machine: { memoryMiB: 1536, vcpus: 1 } });
    for (const machine of [{ memoryMiB: 1536 }, { memoryMiB: 8, vcpus: 1 }, { memoryMiB: 1536, vcpus: 5 }, { memoryMiB: 1536, vcpus: 1, cpu: "v4" }]) {
      expect(() => decodeStorageIncoming({ ...initialize, machine })).toThrow(VMError);
    }
    port1.close();
    port2.close();
  });

  it("reads restore points strictly", () => {
    const decode = storageResponseDecoders["snapshot-list"];
    const unlabelled = {
      mode: "system",
      ref: SNAPSHOT,
      kind: "automatic",
      capturedAtUnixMs: INFO.capturedAtUnixMs,
      profile: null,
      bytes: INFO.bytes,
      resumable: "base-missing",
    };

    expect(decode([INFO, unlabelled])).toEqual([INFO, unlabelled]);
    for (const malformed of [
      { ...INFO, kind: "manual" },
      { ...INFO, resumable: false },
      { ...INFO, resumable: "damaged" },
      { ...INFO, label: "x".repeat(257) },
      { ...INFO, capturedAtUnixMs: -1 },
      { ...INFO, capturedAtUnixMs: 1.5 },
      { ...INFO, bytes: { ...INFO.bytes, unique: -1 } },
      { ...INFO, bytes: { ram: 1, disk: 1 } },
      { ...INFO, profile: { id: "", version: "1" } },
      { ...INFO, profile: { id: "alpine" } },
      { ...INFO, ref: { id: SNAPSHOT.id } },
      { ...INFO, extra: true },
    ]) {
      expect(() => decode([malformed]), JSON.stringify(malformed)).toThrow(VMError);
    }
    expect(() => decode(INFO)).toThrow(VMError);
  });

  it("returns the renamed restore point and nothing for a delete", () => {
    expect(storageResponseDecoders["snapshot-rename"](INFO)).toEqual(INFO);
    expect(() => storageResponseDecoders["snapshot-rename"]({ ...INFO, kind: undefined })).toThrow(VMError);
    expect(() => {
      storageResponseDecoders["snapshot-delete"](undefined);
    }).not.toThrow();
    expect(() => storageResponseDecoders["snapshot-delete"](INFO)).toThrow(VMError);
  });

  it("reads storage usage, including a browser that reports no estimate", () => {
    const decode = storageResponseDecoders["snapshot-usage"];
    const usage = {
      referencedBytes: 1_400_000_000,
      reclaimableBytes: 0,
      estimate: { usage: 1_500_000_000, quota: 9_600_000_000 },
      persisted: false,
    };

    expect(decode(usage)).toEqual(usage);
    expect(decode({ ...usage, estimate: null, persisted: null })).toEqual({ ...usage, estimate: null, persisted: null });
    for (const malformed of [
      { ...usage, referencedBytes: -1 },
      { ...usage, estimate: { usage: 1 } },
      { ...usage, persisted: "yes" },
      { ...usage, extra: 0 },
    ]) {
      expect(() => decode(malformed), JSON.stringify(malformed)).toThrow(VMError);
    }
  });
});
