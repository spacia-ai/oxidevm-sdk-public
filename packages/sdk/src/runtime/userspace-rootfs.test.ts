import { describe, expect, it } from "vitest";

import {
  canonicalUserspaceRootfsBytes,
  userspaceTreeIdentity,
  decodeUserspaceRootfsMetadataFile,
  decodeUserspaceRootfsManifest,
  encodeUserspaceRootfsMetadata,
  materializeUserspaceRootfsMetadata,
  mergeUserspaceWorkspaceDelta,
  mergeUserspaceWorkspaceSnapshot,
  verifyUserspaceRootfsManifest,
} from "./userspace-rootfs.js";

const manifestUrl = new URL("https://profiles.example/rootfs/manifest.json");
const hash = "a".repeat(64);

it("schema 8 authenticates complete pack mappings while preserving the logical tree", () => {
  const original = base(), entries = original.entries.map(entry => ({...entry,ownership:{uid:1000,gid:1000},times:{accessNs:"0",modificationNs:"0"}}));
  const refs = [...new Map([...original.blobs,...[original.provenance.sbom,original.provenance.notices,original.provenance.correspondingSources,original.provenance.reproducibility]].map(blob=>[blob.sha256,blob])).values()];
  let offset=0;
  const blobs=refs.map(blob=>{const extent={chunk:hash,offset,bytes:blob.bytes,fileOffset:0};offset+=blob.bytes;return {sha256:blob.sha256,extents:blob.bytes===0?[]:[extent]};});
  const packs={index:{version:1,chunks:[{sha256:hash,bytes:offset}],blobs},artifacts:[{sha256:hash,encoding:"gzip",url:"./packs/a.gz",encodedBytes:10,encodedSha256:hash}]};
  const source={...original,schemaVersion:8,workspaceBaseSha256:hash,entries,packs};
  const decoded=decodeUserspaceRootfsManifest(source,manifestUrl);
  expect(decoded.packs?.index.blobs).toHaveLength(refs.length);
  expect(canonicalUserspaceRootfsBytes(decoded)).not.toEqual(canonicalUserspaceRootfsBytes(decodeUserspaceRootfsManifest({...source,packs:{...packs,artifacts:[{...packs.artifacts[0],encodedSha256:"f".repeat(64)}]}},manifestUrl)));
  expect(()=>decodeUserspaceRootfsManifest({...source,schemaVersion:7},manifestUrl)).toThrow();
  expect(()=>decodeUserspaceRootfsManifest({...source,packs:{...packs,index:{...packs.index,blobs:[]}}},manifestUrl)).toThrow();
});

it("signed schema 6 authenticates exact base timestamps and rejects missing or contradictory inode times", async () => {
  const ownership = { uid: 1000, gid: 1000 };
  const times = { accessNs: "-1", modificationNs: "123000000001" };
  const original = base();
  const entries = original.entries.map(entry => ({ ...entry, ownership, times }));
  const input = { ...original, schemaVersion: 6, workspaceBaseSha256: hash, entries };
  const decoded = decodeUserspaceRootfsManifest(input, manifestUrl);
  expect(decoded.entries[1]?.times).toEqual(times);
  const bytes = encodeUserspaceRootfsMetadata(decoded);
  const view = new DataView(bytes.buffer);
  expect(view.getUint16(4, true)).toBe(8);
  expect(view.getBigInt64(32, true)).toBe(-1n);
  expect(view.getBigInt64(40, true)).toBe(123_000_000_001n);
  const modified = decodeUserspaceRootfsManifest({ ...input, entries: entries.map(entry => ({ ...entry, times: { ...times, accessNs: "0" } })) }, manifestUrl);
  expect(canonicalUserspaceRootfsBytes(modified)).not.toEqual(canonicalUserspaceRootfsBytes(decoded));
  expect(await userspaceTreeIdentity(modified.entries, modified.blobs, 6)).not.toEqual(await userspaceTreeIdentity(decoded.entries, decoded.blobs, 6));
  expect(() => decodeUserspaceRootfsManifest({ ...input, entries: original.entries.map(entry => ({ ...entry, ownership })) }, manifestUrl)).toThrow();
  expect(() => decodeUserspaceRootfsManifest({ ...input, schemaVersion: 5 }, manifestUrl)).toThrow();
  const hardlink = { type: "hardlink", path: "bin/other", target: "bin/node", mode: 0o755, ownership, times: { ...times, modificationNs: "0" } };
  expect(() => decodeUserspaceRootfsManifest({ ...input, fileCount: 3, entries: [...entries, hardlink] }, manifestUrl)).toThrow();
});

function base(rootTreeSha256 = hash, signature = "A".repeat(86)) {
  return {
    schemaVersion: 1,
    kind: "linux-user-rootfs",
    id: "glibc-node-bun",
    version: "2026.08.07",
    architecture: "x86_64",
    cpuProfile: "x86-64-v2",
    sourceDateEpoch: 1_786_060_800,
    rootTreeSha256,
    fileCount: 2,
    totalBytes: 4,
    blobs: [{ sha256: hash, bytes: 4, url: "./blobs/aa" }],
    entries: [
      { type: "directory", path: "bin", mode: 0o755 },
      { type: "file", path: "bin/node", mode: 0o755, blob: hash },
    ],
    runtimes: { node: "bin/node", supportingFiles: [] },
    provenance: {
      keyId: "release-2026",
      signature,
      sbom: { url: "./evidence/sbom", bytes: 1, sha256: "b".repeat(64) },
      notices: { url: "./evidence/notices", bytes: 1, sha256: "c".repeat(64) },
      correspondingSources: { url: "./evidence/sources", bytes: 1, sha256: "d".repeat(64) },
      reproducibility: { url: "./evidence/reproducibility", bytes: 1, sha256: "e".repeat(64) },
    },
  };
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

describe("Userspace rootfs manifest", () => {
  it("supports a Python-only image without Node or Bun metadata", () => {
    const value = { ...base(), id: "python", runtimes: { supportingFiles: [] },
      entries: [{ type: "directory", path: "bin", mode: 0o755 },
        { type: "file", path: "bin/python", mode: 0o755, blob: hash }] };
    expect(decodeUserspaceRootfsManifest(value, manifestUrl).runtimes).toEqual({ supportingFiles: [] });
  });

  it("preserves base hardlink identity, ownership and raw metadata in schema 5", () => {
    const value = { ...base(), schemaVersion: 5, workspaceBaseSha256: hash, fileCount: 3,
      runtimes: { supportingFiles: [] }, entries: [
        { type: "directory", path: "bin", mode: 0o755, ownership: { uid: 0, gid: 0 } },
        { type: "file", path: "bin/python", mode: 0o755, blob: hash, ownership: { uid: 1000, gid: 1001 } },
        { type: "hardlink", path: "bin/python3", mode: 0o755, target: "bin/python", ownership: { uid: 1000, gid: 1001 } },
      ] };
    const manifest = decodeUserspaceRootfsManifest(value, manifestUrl);
    const metadata = encodeUserspaceRootfsMetadata(manifest);
    expect(new DataView(metadata.buffer).getUint16(4, true)).toBe(9);
    expect(decodeUserspaceRootfsMetadataFile(metadata, "/bin/python3")).toEqual({ bytes: 4, sha256: hash });
    expect(new TextDecoder().decode(metadata)).toContain("/bin/python3");
    expect(manifest.entries[2]).toMatchObject({ type: "hardlink", target: "bin/python", ownership: { uid: 1000, gid: 1001 } });
    // Main's pinned Boundary rootfs ships owned schema-4 hardlinks; both schema lines share the v7 base-hardlink record.
    expect(encodeUserspaceRootfsMetadata(decodeUserspaceRootfsManifest({ ...value, schemaVersion: 4 }, manifestUrl))).toEqual(metadata);
  });

  it("rejects base hardlinks with absent, symlink or inconsistent inode metadata targets", () => {
    for (const target of ["bin/missing", "bin", "../escape"]) {
      const value = { ...base(), schemaVersion: 5, workspaceBaseSha256: hash, fileCount: 3,
        entries: [...base().entries.map(entry => ({ ...entry, ownership: { uid: 0, gid: 0 } })),
          { type: "hardlink", path: "bin/zz", mode: 0o755, target, ownership: { uid: 0, gid: 0 } }] };
      expect(() => decodeUserspaceRootfsManifest(value, manifestUrl)).toThrow();
    }
    for (const mismatch of [{ mode: 0o644 }, { ownership: { uid: 1, gid: 0 } }]) {
      const value = { ...base(), schemaVersion: 5, workspaceBaseSha256: hash, fileCount: 3,
        entries: [...base().entries.map(entry => ({ ...entry, ownership: { uid: 0, gid: 0 } })),
          { type: "hardlink", path: "bin/zz", mode: 0o755, target: "bin/node", ownership: { uid: 0, gid: 0 }, ...mismatch }] };
      expect(() => decodeUserspaceRootfsManifest(value, manifestUrl)).toThrow(/matching metadata/u);
    }
  });

  it("uses guest UTF-8 ordering for schema-4 inode aliases", () => {
    const ownership = { uid: 0, gid: 0 };
    const entries = [
      { type: "file", path: "bin/\ue000", mode: 0o755, blob: hash, ownership },
      { type: "hardlink", path: "bin/\u{10000}", mode: 0o755, target: "bin/\ue000", ownership },
    ];
    const value = { ...base(), schemaVersion: 4, workspaceBaseSha256: hash, entries, runtimes: { supportingFiles: [] } };
    expect(decodeUserspaceRootfsManifest(value, manifestUrl).entries).toEqual(entries);
    expect(() => decodeUserspaceRootfsManifest({ ...value, entries: [...entries].reverse() }, manifestUrl)).toThrow();
  });
  it("uses guest UTF-8 ordering for schema-6 timed inode aliases", () => {
    const ownership = { uid: 0, gid: 0 };
    const times = { accessNs: "1", modificationNs: "2" };
    const file = (path: string) => ({ type: "file", path, mode: 0o755, blob: hash, ownership, times });
    const alias = (path: string, target: string) => ({ type: "hardlink", path, mode: 0o755, target, ownership, times });
    const value = { ...base(), schemaVersion: 6, workspaceBaseSha256: hash, runtimes: { supportingFiles: [] } };
    // U+E000 precedes U+10000 in UTF-8 bytes (EE < F0) but follows it in UTF-16 code units (E000 > D800).
    const entries = [file("bin/\ue000"), alias("bin/\u{10000}", "bin/\ue000")];
    expect(decodeUserspaceRootfsManifest({ ...value, entries }, manifestUrl).entries).toEqual(entries);
    const utf16Order = [file("bin/\u{10000}"), alias("bin/\ue000", "bin/\u{10000}")];
    expect(() => decodeUserspaceRootfsManifest({ ...value, entries: utf16Order }, manifestUrl)).toThrow(/unique sorted paths/u);
  });
  it("preserves owned hardlinks and resolves executable metadata through the same inode", () => {
    const ownership = { uid: 123, gid: 456 };
    const entries = [
      { type: "directory", path: "bin", mode: 0o755, ownership },
      { type: "file", path: "bin/a", mode: 0o4755, blob: hash, ownership },
      { type: "hardlink", path: "bin/node", mode: 0o4755, target: "bin/a", ownership },
    ];
    const value = { ...base(), schemaVersion: 4, workspaceBaseSha256: hash, fileCount: 3, entries,
      runtimes: { supportingFiles: [] } };
    const manifest = decodeUserspaceRootfsManifest(value, manifestUrl);
    const metadata = encodeUserspaceRootfsMetadata(manifest);
    expect(decodeUserspaceRootfsMetadataFile(metadata, "/bin/node")).toEqual({ bytes: 4, sha256: hash });
    for (const patch of [{ target: "bin/missing" }, { target: "bin" }, { target: "/bin/a" }, { mode: 0o755 }, { ownership: { uid: 124, gid: 456 } }]) {
      expect(() => decodeUserspaceRootfsManifest({ ...value, entries: [...entries.slice(0, 2), { ...entries[2], ...patch }] }, manifestUrl)).toThrow();
    }
    const legacyEntries = entries.map(entry => { const legacy: Record<string, unknown> = { ...entry }; delete legacy["ownership"]; return legacy; });
    expect(() => decodeUserspaceRootfsManifest({ ...value, schemaVersion: 3, entries: legacyEntries }, manifestUrl)).toThrow(/unsupported/u);
  });
  it("requires schema 4 for ownership and preserves it in Wasm metadata", () => {
    const value = { ...base(), schemaVersion: 4, workspaceBaseSha256: hash,
      entries: base().entries.map(entry => ({ ...entry, ownership: { uid: 1000, gid: 1001 } })) };
    const manifest = decodeUserspaceRootfsManifest(value, manifestUrl);
    const metadata = encodeUserspaceRootfsMetadata(manifest);
    const view = new DataView(metadata.buffer);
    expect(view.getUint16(4, true)).toBe(6);
    expect(view.getUint32(24, true)).toBe(1000);
    expect(view.getUint32(28, true)).toBe(1001);
    expect(() => decodeUserspaceRootfsManifest({ ...value, schemaVersion: 3 }, manifestUrl)).toThrow();
    expect(() => encodeUserspaceRootfsMetadata({ ...manifest, schemaVersion: 3 })).toThrow();
  });
  it("decodes a sorted content-addressed tree", () => {
    const decoded = decodeUserspaceRootfsManifest(base(), manifestUrl);
    expect(decoded.blobs[0]?.url.href).toBe("https://profiles.example/rootfs/blobs/aa");
    expect(decoded.runtimes.node).toBe("bin/node");
  });

  it("preserves empty regular files in a managed workspace", () => {
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const value = {
      ...base(),
      totalBytes: 0,
      blobs: [{ sha256: emptyHash, bytes: 0, url: "./blobs/empty" }],
      entries: [
        { type: "directory", path: "workspace", mode: 0o755 },
        { type: "file", path: "workspace/.keep", mode: 0o644, blob: emptyHash },
      ],
      runtimes: { supportingFiles: [] },
    };
    expect(decodeUserspaceRootfsManifest(value, manifestUrl).blobs[0]?.bytes).toBe(0);
  });

  it.each([
    ["unknown key", { ...base(), kernel: {} }],
    ["absolute path", { ...base(), entries: [{ type: "file", path: "/bin/node", mode: 0o755, blob: hash }] }],
    ["duplicate path", { ...base(), fileCount: 3, entries: [...base().entries, base().entries[1]] }],
    ["unknown blob", { ...base(), entries: [base().entries[0], { ...base().entries[1], blob: "f".repeat(64) }] }],
    ["byte mismatch", { ...base(), totalBytes: 5 }],
    ["escaping symlink", { ...base(), fileCount: 3, entries: [...base().entries, { type: "symlink", path: "escape", mode: 0o777, target: "../outside" }] }],
  ])("rejects %s", (_name, value) => {
    expect(() => decodeUserspaceRootfsManifest(value, manifestUrl)).toThrow();
  });

  it("checks the tree digest and detached Ed25519 signature against a trusted key", async () => {
    const tree = {
      blobs: [{ bytes: 4, sha256: hash }],
      entries: [
        { mode: 0o755, path: "bin", type: "directory" },
        { blob: hash, mode: 0o755, path: "bin/node", type: "file" },
      ],
    };
    const treeHash = await sha256(tree);
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
    const versionTwo = { ...base(treeHash), schemaVersion: 2 };
    const unsigned = decodeUserspaceRootfsManifest(versionTwo, manifestUrl);
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, canonicalUserspaceRootfsBytes(unsigned)));
    const signed = decodeUserspaceRootfsManifest(
      { ...base(treeHash, base64url(signature)), schemaVersion: 2 },
      manifestUrl,
    );

    await expect(verifyUserspaceRootfsManifest(signed, { keyId: "release-2026", publicKey })).resolves.toBeUndefined();
    await expect(verifyUserspaceRootfsManifest(signed, { keyId: "wrong-key", publicKey })).rejects.toThrow(/trusted/u);
  });

  it("encodes immutable metadata without copying file blobs into Wasm staging", () => {
    const record = encodeUserspaceRootfsMetadata(
      decodeUserspaceRootfsManifest(base(), manifestUrl),
    );
    const view = new DataView(record.buffer);
    expect(new TextDecoder().decode(record.subarray(0, 4))).toBe("OXRF");
    expect(view.getUint16(4, true)).toBe(4);
    expect(view.getUint32(8, true)).toBe(2);
    const second = 12 + 12 + 4;
    expect(view.getUint8(second)).toBe(3);
    expect(view.getUint16(second + 2, true)).toBe(0o755);
    expect(view.getBigUint64(second + 12 + 9, true)).toBe(4n);
    expect(record.slice(second + 12 + 9 + 8)).toEqual(new Uint8Array(32).fill(0xaa));
    expect(record.byteLength).toBeLessThan(160);
    expect(decodeUserspaceRootfsMetadataFile(record, "/bin/node")).toEqual({
      bytes: 4,
      sha256: hash,
    });
    expect(() => decodeUserspaceRootfsMetadataFile(record, "/bin/missing"))
      .toThrow("absent");
    record[second + 1] = 1;
    expect(() => decodeUserspaceRootfsMetadataFile(record, "/bin/node"))
      .toThrow("entry is malformed");
  });

  it("materializes only verified supporting files", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const manifest = decodeUserspaceRootfsManifest({
      ...base(),
      blobs: [{ sha256: digest, bytes: bytes.byteLength, url: "./blobs/runtime" }],
      entries: [
        { type: "directory", path: "lib", mode: 0o755 },
        { type: "file", path: "lib/runtime.so", mode: 0o444, blob: digest },
      ],
      runtimes: { supportingFiles: ["lib/runtime.so"] },
    }, manifestUrl);
    const metadata = encodeUserspaceRootfsMetadata(manifest);

    const materialized = await materializeUserspaceRootfsMetadata(
      metadata,
      new Map([["/lib/runtime.so", bytes]]),
    );
    const firstLength = 12 + 12 + "/lib".length;
    expect(new DataView(materialized.buffer).getUint8(firstLength)).toBe(1);
    expect(materialized.slice(firstLength + 12 + "/lib/runtime.so".length)).toEqual(bytes);
    await expect(materializeUserspaceRootfsMetadata(
      metadata,
      new Map([["/lib/runtime.so", new Uint8Array([9])]]),
    )).rejects.toThrow(/length/u);
  });

  it("replaces the immutable workspace tree with an exact v5 snapshot", () => {
    const workspaceHash = "b".repeat(64);
    const rootfs = encodeUserspaceRootfsMetadata(decodeUserspaceRootfsManifest({
      ...base(),
      fileCount: 2,
      totalBytes: 4,
      blobs: [{ sha256: workspaceHash, bytes: 4, url: "./blobs/base" }],
      entries: [
        { type: "directory", path: "workspace", mode: 0o755 },
        { type: "file", path: "workspace/base", mode: 0o644, blob: workspaceHash },
      ],
      runtimes: { supportingFiles: [] },
    }, manifestUrl));
    const snapshot = workspaceMetadata([
      { tag: 1, mode: 0o640, path: "/workspace/live", payload: new TextEncoder().encode("changed") },
      { tag: 4, mode: 0o640, path: "/workspace/link", payload: new TextEncoder().encode("/workspace/live") },
    ]);

    const merged = mergeUserspaceWorkspaceSnapshot(rootfs, snapshot);
    const text = new TextDecoder().decode(merged);
    expect(new DataView(merged.buffer).getUint16(4, true)).toBe(5);
    expect(text).not.toContain("/workspace/base");
    expect(text).toContain("/workspace/live");
    expect(text).toContain("/workspace/link");
    expect(() => mergeUserspaceWorkspaceSnapshot(
      rootfs,
      workspaceMetadata([{ tag: 1, mode: 0o600, path: "/tmp/escape", payload: new Uint8Array() }]),
    )).toThrow(/outside/u);
  });

  it("keeps the /workspace root entry with its mode, owner and times on replay", () => {
    // Regression: replay once dropped the root entry, so /workspace reverted to the runtime's
    // default (0777, no owner, epoch) and tools refused its world-writable cache parents.
    const owner = { uid: 1000, gid: 1000 };
    const imageTimes = { accessNs: "1785369600000000000", modificationNs: "1785369600000000000" };
    const rootfs = encodeUserspaceRootfsMetadata(decodeUserspaceRootfsManifest({
      ...base(),
      schemaVersion: 6,
      workspaceBaseSha256: hash,
      fileCount: 2,
      totalBytes: 4,
      entries: [
        { type: "directory", path: "workspace", mode: 0o755, ownership: owner, times: imageTimes },
        { type: "file", path: "workspace/keep", mode: 0o644, blob: hash, ownership: owner, times: imageTimes },
      ],
      runtimes: { supportingFiles: [] },
    }, manifestUrl));
    const liveTimes = { accessNs: "1790000000000000000", modificationNs: "1790000000000000001" };
    const snapshot = timedRecord("OXRF", [
      { tag: 0, mode: 0o755, ownership: owner, times: liveTimes, path: "/workspace", payload: new Uint8Array() },
      { tag: 1, mode: 0o644, ownership: owner, times: liveTimes, path: "/workspace/live", payload: new TextEncoder().encode("live") },
    ]);
    const fromSnapshot = timedEntries(mergeUserspaceWorkspaceSnapshot(rootfs, snapshot));
    expect(fromSnapshot.map(entry => entry.path)).toEqual(["/workspace", "/workspace/live"]);
    expect(fromSnapshot[0]).toMatchObject({ mode: 0o755, ownership: owner, times: liveTimes });

    // A snapshot without the root (an older full-system flush) keeps the image's root entry.
    const rootless = timedRecord("OXRF", [
      { tag: 1, mode: 0o644, ownership: owner, times: liveTimes, path: "/workspace/live", payload: new TextEncoder().encode("live") },
    ]);
    expect(timedEntries(mergeUserspaceWorkspaceSnapshot(rootfs, rootless))[0]).toMatchObject({ path: "/workspace", mode: 0o755, ownership: owner, times: imageTimes });

    // A delta keeps the image's root unless it records the root itself.
    const untouched = timedRecord("OXWD", [
      { tag: 1, mode: 0o600, ownership: owner, times: liveTimes, path: "/workspace/new", payload: new TextEncoder().encode("new") },
    ]);
    const fromDelta = timedEntries(mergeUserspaceWorkspaceDelta(rootfs, untouched));
    expect(fromDelta.map(entry => entry.path)).toEqual(["/workspace", "/workspace/keep", "/workspace/new"]);
    expect(fromDelta[0]).toMatchObject({ mode: 0o755, ownership: owner, times: imageTimes });
    const touched = timedRecord("OXWD", [
      { tag: 0, mode: 0o750, ownership: owner, times: liveTimes, path: "/workspace", payload: new Uint8Array() },
    ]);
    expect(timedEntries(mergeUserspaceWorkspaceDelta(rootfs, touched))[0]).toMatchObject({ path: "/workspace", mode: 0o750, times: liveTimes });
  });

  it("applies workspace deltas over the immutable tree", () => {
    const rootfs = encodeUserspaceRootfsMetadata(decodeUserspaceRootfsManifest({
      ...base(),
      fileCount: 3,
      totalBytes: 4,
      entries: [
        { type: "directory", path: "workspace", mode: 0o755 },
        { type: "file", path: "workspace/keep", mode: 0o644, blob: hash },
        { type: "file", path: "workspace/remove", mode: 0o644, blob: hash },
      ],
      runtimes: { supportingFiles: [] },
    }, manifestUrl));
    const delta = workspaceMetadata([
      { tag: 5, mode: 0, path: "/workspace/remove", payload: new Uint8Array() },
      { tag: 1, mode: 0o600, path: "/workspace/new", payload: new TextEncoder().encode("new") },
    ]);
    delta.set(new TextEncoder().encode("OXWD"), 0);
    new DataView(delta.buffer).setUint16(4, 1, true);

    const merged = mergeUserspaceWorkspaceDelta(rootfs, delta);
    const text = new TextDecoder().decode(merged);
    expect(text).toContain("/workspace/keep");
    expect(text).toContain("/workspace/new");
    expect(text).not.toContain("/workspace/remove");

    const traversal = workspaceMetadata([
      { tag: 1, mode: 0o600, path: "/workspace/../escape", payload: new Uint8Array() },
    ]);
    traversal.set(new TextEncoder().encode("OXWD"), 0);
    new DataView(traversal.buffer).setUint16(4, 1, true);
    expect(() => mergeUserspaceWorkspaceDelta(rootfs, traversal)).toThrow(/path/u);
  });
});

interface TimedEntry {
  readonly tag: number;
  readonly mode: number;
  readonly ownership: { readonly uid: number; readonly gid: number };
  readonly times: { readonly accessNs: string; readonly modificationNs: string };
  readonly path: string;
  readonly payload: Uint8Array;
}

/** An OXRF v8 or OXWD v3 record: 36-byte entry headers with owner and nanosecond times. */
function timedRecord(magic: "OXRF" | "OXWD", entries: readonly TimedEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const encoded = entries.map(entry => ({ ...entry, pathBytes: encoder.encode(entry.path) }));
  const bytes = new Uint8Array(encoded.reduce((total, entry) => total + 36 + entry.pathBytes.byteLength + entry.payload.byteLength, 12));
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode(magic));
  view.setUint16(4, magic === "OXRF" ? 8 : 3, true);
  view.setUint32(8, encoded.length, true);
  let offset = 12;
  for (const entry of encoded) {
    view.setUint8(offset, entry.tag);
    view.setUint8(offset + 1, 3);
    view.setUint16(offset + 2, entry.mode, true);
    view.setUint32(offset + 4, entry.pathBytes.byteLength, true);
    view.setUint32(offset + 8, entry.payload.byteLength, true);
    view.setUint32(offset + 12, entry.ownership.uid, true);
    view.setUint32(offset + 16, entry.ownership.gid, true);
    view.setBigInt64(offset + 20, BigInt(entry.times.accessNs), true);
    view.setBigInt64(offset + 28, BigInt(entry.times.modificationNs), true);
    offset += 36;
    bytes.set(entry.pathBytes, offset);
    offset += entry.pathBytes.byteLength;
    bytes.set(entry.payload, offset);
    offset += entry.payload.byteLength;
  }
  return bytes;
}

/** The entries of an OXRF v8 record. */
function timedEntries(record: Uint8Array<ArrayBuffer>): Omit<TimedEntry, "payload">[] {
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  expect(view.getUint16(4, true)).toBe(8);
  const entries: Omit<TimedEntry, "payload">[] = [];
  let offset = 12;
  for (let index = 0; index < view.getUint32(8, true); index += 1) {
    const pathBytes = view.getUint32(offset + 4, true);
    const payloadBytes = view.getUint32(offset + 8, true);
    entries.push({
      tag: view.getUint8(offset), mode: view.getUint16(offset + 2, true),
      ownership: { uid: view.getUint32(offset + 12, true), gid: view.getUint32(offset + 16, true) },
      times: { accessNs: view.getBigInt64(offset + 20, true).toString(), modificationNs: view.getBigInt64(offset + 28, true).toString() },
      path: new TextDecoder().decode(record.subarray(offset + 36, offset + 36 + pathBytes)),
    });
    offset += 36 + pathBytes + payloadBytes;
  }
  return entries;
}

function workspaceMetadata(
  entries: readonly { readonly tag: number; readonly mode: number; readonly path: string; readonly payload: Uint8Array }[],
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const encoded = entries.map((entry) => ({ ...entry, path: encoder.encode(entry.path) }));
  const bytes = new Uint8Array(encoded.reduce(
    (total, entry) => total + 12 + entry.path.byteLength + entry.payload.byteLength,
    12,
  ));
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode("OXRF"));
  view.setUint16(4, 5, true);
  view.setUint32(8, encoded.length, true);
  let offset = 12;
  for (const entry of encoded) {
    view.setUint8(offset, entry.tag);
    view.setUint16(offset + 2, entry.mode, true);
    view.setUint32(offset + 4, entry.path.byteLength, true);
    view.setUint32(offset + 8, entry.payload.byteLength, true);
    offset += 12;
    bytes.set(entry.path, offset);
    offset += entry.path.byteLength;
    bytes.set(entry.payload, offset);
    offset += entry.payload.byteLength;
  }
  return bytes;
}

it("schema7 retains signed native start listings and rejects older or escaping listings",()=>{
  const listing={name:"ready",manifest:{url:"./snapshots/ready/manifest.json",bytes:1,sha256:hash},bytes:2};
  const input={...base(),schemaVersion:7,workspaceBaseSha256:hash,entries:base().entries.map(entry=>({...entry,ownership:{uid:1000,gid:1000},times:{accessNs:"0",modificationNs:"0"}})),snapshots:[listing]};
  const decoded=decodeUserspaceRootfsManifest(input,manifestUrl);
  expect(decoded.snapshots?.[0]).toMatchObject({name:"ready",manifest:{url:new URL("./snapshots/ready/manifest.json",manifestUrl)}});
  expect(new TextDecoder().decode(canonicalUserspaceRootfsBytes(decoded))).toContain('"snapshots"');
  for(const snapshots of [[listing,listing],[{...listing,manifest:{...listing.manifest,url:"https://other.test/manifest.json"}}]]) expect(()=>decodeUserspaceRootfsManifest({...input,snapshots},manifestUrl)).toThrow();
  expect(()=>decodeUserspaceRootfsManifest({...input,schemaVersion:6},manifestUrl)).toThrow();
});
