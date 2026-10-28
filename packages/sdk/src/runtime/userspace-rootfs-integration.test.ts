import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeFilesystemRecord, encodeFilesystemRecord } from "./userspace-rootfs-record.js";
import { mergeUserspaceWorkspaceDelta, mergeUserspaceWorkspaceSnapshot } from "./userspace-rootfs.js";
import { workspaceMetadataTimes } from "./workspace-record.js";

function fixture(name: string): Uint8Array<ArrayBuffer> {
  const hex = readFileSync(new URL("../../../../tests/fixtures/workspace/integration.hex", import.meta.url), "utf8")
    .split("\n").find(line => line.startsWith(name + " "))?.split(" ")[1];
  if (hex === undefined) throw new Error("missing independent fixture");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

it("compares rich and signed timestamp-only hardlink claims before admitting any record", () => {
  const entries = decodeFilesystemRecord(fixture("mixed-hardlinks"), "snapshot");
  expect(entries[2]?.times).toEqual({ accessNs: "-1", modificationNs: "2" });
  expect(encodeFilesystemRecord(entries, "snapshot")).toEqual(fixture("mixed-hardlinks"));
  expect(() => decodeFilesystemRecord(fixture("bad-hardlink-times"), "snapshot")).toThrow("hardlink");
  expect(() => decodeFilesystemRecord(fixture("legacy-rich-delta-v3"), "delta")).toThrow();
});

it("keeps unclaimed root ownership and xattrs through legacy snapshots and deltas", () => {
  const rich = fixture("mixed-hardlinks"), root = decodeFilesystemRecord(rich, "rootfs")[0];
  if (root?.metadata === undefined) throw new Error("missing rich root");
  expect(decodeFilesystemRecord(mergeUserspaceWorkspaceSnapshot(rich, fixture("empty-v5")), "rootfs")[0]).toEqual(root);
  for (const delta of [false, true]) {
    const partial = fixture("partial-root-v8");
    if (delta) { partial.set(new TextEncoder().encode("OXWD")); new DataView(partial.buffer).setUint16(4, 3, true); }
    const merged = delta ? mergeUserspaceWorkspaceDelta(rich, partial) : mergeUserspaceWorkspaceSnapshot(rich, partial);
    const result = decodeFilesystemRecord(merged, "rootfs")[0];
    expect(result?.mode).toBe(0o750);
    expect(result?.ownership).toEqual({ uid: 1000, gid: 1000 });
    expect(result?.metadata).toEqual(root.metadata);
    if (result?.metadata === undefined) throw new Error("lost root xattrs");
    expect(workspaceMetadataTimes(result.metadata)).toEqual({ accessNs: "-1", modificationNs: "2" });
  }
});
