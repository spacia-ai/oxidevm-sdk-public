import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { materializeUserspaceRootfsMetadata, mergeUserspaceWorkspaceDelta, mergeUserspaceWorkspaceSnapshot } from "../userspace-rootfs.js";
import { buildWorkspaceDelta, decodeSnapshot, mergeWorkspaceDeltas } from "./workspace-delta.js";
import { decodeWorkspaceIndex, encodeWorkspaceIndex, indexWorkspaceSnapshot, workspaceChanges } from "./workspace-index.js";
import type { UserspaceRootfsEntry } from "../userspace-rootfs.js";
import { sha256Hex } from "./snapshot-content.js";

const fixtures = new Map(readFileSync(new URL("../../../../../tests/fixtures/workspace/timestamps.hex", import.meta.url), "utf8")
  .trim().split("\n").map(line => {
    const [name, hex] = line.split(" ");
    if (name === undefined || hex === undefined) throw new Error("Invalid independent timestamp fixture");
    return [name, Uint8Array.from(Buffer.from(hex, "hex"))];
  }));
function fixture(name: string): Uint8Array<ArrayBuffer> {
  const value = fixtures.get(name);
  if (value === undefined) throw new Error("Missing timestamp fixture");
  return value.slice();
}
const times = { accessNs: "12123456789", modificationNs: "23987654321" };
function empty(magic: string, version: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(12); bytes.set(new TextEncoder().encode(magic));
  new DataView(bytes.buffer).setUint16(4, version, true); return bytes;
}

describe("native workspace timestamp records", () => {
  it("omits an unchanged timed signed base and retains timestamp-only changes", async () => {
    const snapshot = fixture("snapshot-v8");
    const file = decodeSnapshot(snapshot)[0];
    if (file === undefined || file.tag !== 1 || file.ownership === undefined) throw new Error("Independent fixture omitted its owned file payload");
    const sha256 = await sha256Hex(file.payload);
    const base: UserspaceRootfsEntry[] = [
      { type: "file", path: "workspace/file", mode: file.mode, ownership: file.ownership, times, blob: sha256 },
      { type: "hardlink", path: "workspace/link", target: "workspace/file", mode: file.mode, ownership: file.ownership, times },
    ];
    const blobs = [{ sha256, bytes: file.payload.byteLength, url: new URL("https://image.test/actual-base") }];
    const unchanged = await buildWorkspaceDelta(snapshot, base, blobs);
    expect(new DataView(unchanged.buffer).getUint32(8, true)).toBe(0);
    const changed = snapshot.slice();
    for (const offset of [40, 96]) new DataView(changed.buffer).setBigInt64(offset, -1n, true);
    const delta = await buildWorkspaceDelta(changed, base, blobs);
    expect(new DataView(delta.buffer).getUint32(8, true)).toBe(2);
    expect(mergeUserspaceWorkspaceDelta(snapshot, delta)).toEqual(changed);
  });

  it("preserves exact nanoseconds and hardlink metadata through delta and rootfs composition", async () => {
    const snapshot = fixture("snapshot-v8"); const delta = fixture("delta-v3");
    expect(decodeSnapshot(snapshot)).toHaveLength(2);
    for (const entry of decodeSnapshot(snapshot)) expect(entry).toMatchObject({ times, ownership: { uid: 1000, gid: 1000 } });
    expect(await buildWorkspaceDelta(snapshot, [], [])).toEqual(delta);
    expect(mergeWorkspaceDeltas(empty("OXWD", 1), delta)).toEqual(delta);
    expect(mergeUserspaceWorkspaceDelta(empty("OXRF", 4), delta)).toEqual(snapshot);
    expect(mergeUserspaceWorkspaceSnapshot(empty("OXRF", 4), snapshot)).toEqual(snapshot);
    expect(await materializeUserspaceRootfsMetadata(snapshot, new Map())).toEqual(snapshot);
  });

  it("records a timestamp-only change in restore indexes and transfers", async () => {
    const snapshot = fixture("snapshot-v8");
    const index = await indexWorkspaceSnapshot(snapshot);
    expect(index.get("/workspace/file")).toMatchObject({ times });
    expect(decodeWorkspaceIndex(encodeWorkspaceIndex(index))).toEqual(index);
    const changed = snapshot.slice();
    for (const offset of [40, 96]) new DataView(changed.buffer).setBigInt64(offset, -1n, true);
    const changes = await workspaceChanges(index, changed);
    expect(changes.map(change => change.path)).toEqual(["/workspace/file", "/workspace/link"]);
    for (const change of changes) expect(change.current).toMatchObject({ times: { accessNs: times.accessNs, modificationNs: "-1" } });
  });

  it("rejects invalid flags, hidden absent times and truncated timestamp headers", () => {
    for (const flags of [1, 7, 255]) {
      const bytes = fixture("snapshot-v8"); bytes[13] = flags;
      expect(() => decodeSnapshot(bytes)).toThrow();
    }
    expect(() => decodeSnapshot(fixture("snapshot-v8").slice(0, 47))).toThrow();
  });

  it("retains epoch zero and the signed i64 limits without number coercion", async () => {
    const bytes = fixture("snapshot-v8"); const view = new DataView(bytes.buffer);
    for (const offset of [12, 68]) {
      view.setBigInt64(offset + 20, -(1n << 63n), true);
      view.setBigInt64(offset + 28, (1n << 63n) - 1n, true);
    }
    const limits = { accessNs: "-9223372036854775808", modificationNs: "9223372036854775807" };
    const index = decodeWorkspaceIndex(encodeWorkspaceIndex(await indexWorkspaceSnapshot(bytes)));
    expect(index.get("/workspace/file")?.times).toEqual(limits);
    for (const entry of decodeSnapshot(bytes)) expect(entry.times).toEqual(limits);
    for (const offset of [12, 68]) {
      view.setBigInt64(offset + 20, 0n, true); view.setBigInt64(offset + 28, 0n, true);
    }
    for (const entry of decodeSnapshot(bytes)) expect(entry.times).toEqual({ accessNs: "0", modificationNs: "0" });
  });

  it("rejects malformed or out-of-range index timestamp strings while retaining legacy indexes", () => {
    const row = ["/workspace/file", "file", 0o660, "0".repeat(64), null];
    for (const accessNs of ["-0", "01", "1.0", "9223372036854775808", "-9223372036854775809", 0]) {
      const value = { formatVersion: 2, entries: [[...row, { accessNs, modificationNs: "0" }]] };
      expect(() => decodeWorkspaceIndex(new TextEncoder().encode(JSON.stringify(value)))).toThrow();
    }
    const legacy = { formatVersion: 1, entries: [row.slice(0, 4)] };
    expect(decodeWorkspaceIndex(new TextEncoder().encode(JSON.stringify(legacy))).get("/workspace/file")?.times).toBeUndefined();
  });
});
