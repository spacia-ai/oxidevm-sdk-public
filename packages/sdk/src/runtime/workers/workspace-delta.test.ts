import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { requireWorkspaceDialect } from "../workspace-record.js";

import type { UserspaceRootfsBlob, UserspaceRootfsEntry } from "../userspace-rootfs.js";
import { buildWorkspaceDelta, mergeWorkspaceDeltas } from "./workspace-delta.js";
import { mergeUserspaceWorkspaceDelta, materializeUserspaceRootfsMetadata } from "../userspace-rootfs.js";

describe("workspace delta", () => {
  it("omits unchanged signed base hardlinks without copying their file content", async () => {
    const bytes = new TextEncoder().encode("data");
    const digest = await sha256(bytes);
    const snapshot = snapshotEntries([
      [3, 0o600, "/workspace/a", baseReference(bytes.byteLength, digest)],
      [4, 0o600, "/workspace/b", new TextEncoder().encode("/workspace/a")],
    ]);
    const base: UserspaceRootfsEntry[] = [
      { type: "file", path: "workspace/a", mode: 0o600, blob: digest },
      { type: "hardlink", path: "workspace/b", mode: 0o600, target: "workspace/a" },
    ];
    const delta = await buildWorkspaceDelta(snapshot, base, [{ sha256: digest, bytes: bytes.byteLength, url: new URL("https://image.test/blob") }]);
    expect(readU32(delta, 8)).toBe(0);
  });
  it("rejects a merged rootfs beyond the restore entry limit while allowing replacement and deletion", () => {
    const entries = Array.from({ length: 65_536 }, (_, index): readonly [number, number, string, Uint8Array<ArrayBuffer>] =>
      [0, 0o755, `/workspace/entry-${index}`, new Uint8Array()]);
    const rootfs = snapshotEntries(entries);
    const addition = deltaEntries([[0, 0o755, "/workspace/extra", new Uint8Array()]]);
    expect(() => mergeUserspaceWorkspaceDelta(rootfs, addition)).toThrow("too many entries");
    const replacement = deltaEntries([[0, 0o700, "/workspace/entry-0", new Uint8Array()]]);
    expect(readU32(mergeUserspaceWorkspaceDelta(rootfs, replacement), 8)).toBe(65_536);
    const deletion = deltaEntries([[5, 0, "/workspace/entry-0", new Uint8Array()]]);
    expect(readU32(mergeUserspaceWorkspaceDelta(mergeUserspaceWorkspaceDelta(rootfs, deletion), addition), 8)).toBe(65_536);
  }, 30_000);
  it.each([["a-b", "a_b"], ["\ue000", "\u{10000}"]])("restores guest byte-ordered hardlinks %s and %s without locale reordering", (source, link) => {
    const encoder = new TextEncoder();
    const entries: readonly (readonly [number, number, string, Uint8Array<ArrayBuffer>])[] = [
      [1, 0o600, `/workspace/${source}`, encoder.encode("data")],
      [4, 0o600, `/workspace/${link}`, encoder.encode(`/workspace/${source}`)],
    ];
    expect(mergeUserspaceWorkspaceDelta(snapshotEntries([]), deltaEntries(entries)))
      .toEqual(snapshotEntries(entries));
  });
  it("agrees with Rust ownership golden bytes and rejects v3 downgrade", async () => {
    const fixtures = new Map(readFileSync(new URL("../../../../../tests/fixtures/workspace/ownership.hex", import.meta.url), "utf8")
      .trim().split("\n").map(line => {
        const [name, hex] = line.split(" ");
        if (name === undefined || hex === undefined) throw new Error("invalid fixture");
        return [name, Uint8Array.from(Buffer.from(hex, "hex"))];
      }));
    const snapshot = fixtures.get("snapshot-v6"); const delta = fixtures.get("delta-v2");
    if (snapshot === undefined || delta === undefined) throw new Error("missing golden");
    expect(await buildWorkspaceDelta(snapshot, [], [])).toEqual(delta);
    expect(() => requireWorkspaceDialect(snapshot, 3, "OXRF")).toThrow("requires guest protocol v4");
    expect(() => requireWorkspaceDialect(delta, 3, "OXWD")).toThrow("requires guest protocol v4");
    expect(() => requireWorkspaceDialect(delta, 4, "OXWD")).not.toThrow();
    expect(() => requireWorkspaceDialect(deltaEntries([]), 3, "OXWD")).not.toThrow();
  });
  it("preserves ownership records and legacy metadata while composing deltas", async () => {
    const legacy = snapshotEntries([[1, 0o600, "/workspace/private", Uint8Array.of(65)]]);
    const owned = new Uint8Array(legacy.length + 8);
    owned.set(legacy.subarray(0, 24));
    writeU16(owned, 4, 6); owned[13] = 1;
    writeU32(owned, 24, 1000); writeU32(owned, 28, 1001);
    owned.set(legacy.subarray(24), 32);
    const delta = await buildWorkspaceDelta(owned, [], []);
    expect(new DataView(delta.buffer).getUint16(4, true)).toBe(2);
    expect(readU32(delta, 24)).toBe(1000);
    expect(readU32(delta, 28)).toBe(1001);
    const root = new Uint8Array(12);
    root.set(new TextEncoder().encode("OXRF")); writeU16(root, 4, 4);
    const metadata = mergeUserspaceWorkspaceDelta(root, delta);
    expect(new DataView(metadata.buffer).getUint16(4, true)).toBe(6);
    expect(readU32(metadata, 24)).toBe(1000);
    expect(readU32(metadata, 28)).toBe(1001);
    expect(await materializeUserspaceRootfsMetadata(metadata, new Map())).toEqual(metadata);
    const merged = mergeWorkspaceDeltas(deltaEntries([[1, 0o644, "/workspace/old", Uint8Array.of(66)]]), delta);
    expect(new DataView(merged.buffer).getUint16(4, true)).toBe(2);
    expect(merged[13]).toBe(0); // Legacy ownership stays unspecified.
    const second = 32 + new TextEncoder().encode("/workspace/old").length + 1;
    expect(merged[second + 1]).toBe(1);
    expect(readU32(merged, second + 12)).toBe(1000);
    expect(readU32(merged, second + 16)).toBe(1001);
    owned[13] = 2;
    await expect(buildWorkspaceDelta(owned, [], [])).rejects.toThrow();
  });
  it("omits signed base files and emits changes and tombstones", async () => {
    const same = new TextEncoder().encode("same");
    const sameSha256 = await sha256(same);
    const baseEntries: UserspaceRootfsEntry[] = [
      { type: "file", path: "workspace/keep", mode: 0o644, blob: sameSha256 },
      { type: "file", path: "workspace/remove", mode: 0o644, blob: sameSha256 },
    ];
    const baseBlobs: UserspaceRootfsBlob[] = [{
      bytes: same.byteLength,
      sha256: sameSha256,
      url: new URL(`https://root.test/${sameSha256}`),
    }];
    const snapshot = snapshotEntries([
      [3, 0o644, "/workspace/keep", baseReference(same.byteLength, sameSha256)],
      [1, 0o600, "/workspace/new", new TextEncoder().encode("new")],
    ]);
    const delta = await buildWorkspaceDelta(snapshot, baseEntries, baseBlobs);
    expect(new TextDecoder().decode(delta.subarray(0, 4))).toBe("OXWD");
    expect(readU32(delta, 8)).toBe(2);
    expect(entryIdentities(delta)).toEqual([
      [5, "/workspace/remove"],
      [1, "/workspace/new"],
    ]);
  });

  it("rejects traversal and malformed snapshots", async () => {
    const traversal = snapshotEntries([
      [1, 0o600, "/workspace/../escape", new Uint8Array()],
    ]);
    await expect(buildWorkspaceDelta(traversal, [], [])).rejects.toThrow("escapes root");
    await expect(buildWorkspaceDelta(new Uint8Array([1, 2, 3]), [], []))
      .rejects.toThrow("header");
  });

  it("composes incremental changes without losing older overrides", () => {
    const existing = deltaEntries([
      [1, 0o644, "/workspace/old", new TextEncoder().encode("old")],
      [5, 0, "/workspace/deleted", new Uint8Array()],
      [5, 0, "/workspace/recreated", new Uint8Array()],
    ]);
    const incremental = deltaEntries([
      [1, 0o600, "/workspace/new", new TextEncoder().encode("new")],
      [0, 0o755, "/workspace/recreated", new Uint8Array()],
      [1, 0o644, "/workspace/recreated/file", new TextEncoder().encode("value")],
    ]);
    expect(entryIdentities(mergeWorkspaceDeltas(existing, incremental))).toEqual([
      [0, "/workspace/recreated"],
      [1, "/workspace/new"],
      [1, "/workspace/old"],
      [1, "/workspace/recreated/file"],
      [5, "/workspace/deleted"],
    ]);
  });

  it("collapses descendant overrides beneath a tombstone", () => {
    const existing = deltaEntries([
      [0, 0o755, "/workspace/tree", new Uint8Array()],
      [1, 0o644, "/workspace/tree/file", new Uint8Array([1])],
    ]);
    const incremental = deltaEntries([[5, 0, "/workspace/tree", new Uint8Array()]]);
    expect(entryIdentities(mergeWorkspaceDeltas(existing, incremental))).toEqual([
      [5, "/workspace/tree"],
    ]);
  });
});

function snapshotEntries(
  entries: readonly (readonly [number, number, string, Uint8Array<ArrayBuffer>])[],
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const encoded = entries.map(([tag, mode, path, payload]) => ({
    tag,
    mode,
    path: encoder.encode(path),
    payload,
  }));
  const bytes = new Uint8Array(encoded.reduce(
    (total, entry) => total + 12 + entry.path.byteLength + entry.payload.byteLength,
    12,
  ));
  bytes.set(encoder.encode("OXRF"));
  writeU16(bytes, 4, 5);
  writeU32(bytes, 8, encoded.length);
  let offset = 12;
  for (const entry of encoded) {
    bytes[offset] = entry.tag;
    writeU16(bytes, offset + 2, entry.mode);
    writeU32(bytes, offset + 4, entry.path.byteLength);
    writeU32(bytes, offset + 8, entry.payload.byteLength);
    bytes.set(entry.path, offset + 12);
    bytes.set(entry.payload, offset + 12 + entry.path.byteLength);
    offset += 12 + entry.path.byteLength + entry.payload.byteLength;
  }
  return bytes;
}

function deltaEntries(
  entries: readonly (readonly [number, number, string, Uint8Array<ArrayBuffer>])[],
): Uint8Array<ArrayBuffer> {
  const bytes = snapshotEntries(entries);
  bytes.set(new TextEncoder().encode("OXWD"), 0);
  writeU16(bytes, 4, 1);
  return bytes;
}

function entryIdentities(bytes: Uint8Array<ArrayBuffer>): readonly (readonly [number, string])[] {
  const entries: Array<readonly [number, string]> = [];
  let offset = 12;
  for (let index = 0; index < readU32(bytes, 8); index += 1) {
    const pathLength = readU32(bytes, offset + 4);
    const payloadLength = readU32(bytes, offset + 8);
    entries.push([
      bytes[offset] ?? -1,
      new TextDecoder().decode(bytes.subarray(offset + 12, offset + 12 + pathLength)),
    ]);
    offset += 12 + pathLength + payloadLength;
  }
  return entries;
}

function baseReference(bytes: number, sha256: string): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(40);
  new DataView(result.buffer).setBigUint64(0, BigInt(bytes), true);
  for (let index = 0; index < 32; index += 1) {
    result[index + 8] = Number.parseInt(sha256.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint16(offset, value, true);
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint32(offset, value, true);
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
