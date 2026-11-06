import { expect, it } from "vitest";
import { decodeStorageIncoming, PROTOCOL_VERSION, storageResponseDecoders } from "./protocol.js";
import { ORIGIN_STORAGE } from "./storage-scope.js";
import { MAX_ROOTFS_METADATA_BYTES } from "./userspace-rootfs.js";

it("decodes storage backend evidence and ephemeral creation with a pinned manifest", () => {
  expect(storageResponseDecoders["workspace-persistence"]("indexeddb")).toBe("indexeddb");
  expect(() => storageResponseDecoders["workspace-persistence"]("memory")).toThrow();
  const channel = new MessageChannel();
  expect(decodeStorageIncoming({ id: 1, version: PROTOCOL_VERSION, type: "initialize", workspaceId: "ephemeral", snapshotPort: channel.port1, ephemeral: true })).toMatchObject({ ephemeral: true });
  expect(decodeStorageIncoming({ id: 2, version: PROTOCOL_VERSION, type: "prepare-userspace-rootfs", manifestUrl: "https://image.test/manifest.json", trustedKeyId: "author", trustedPublicKey: new Uint8Array(32), manifestSHA256: "a".repeat(64) })).toMatchObject({ manifestSHA256: "a".repeat(64) });
  expect(() => decodeStorageIncoming({ id: 3, version: PROTOCOL_VERSION, type: "prepare-managed-image", manifestUrl: "https://image.test/manifest.json", manifestSHA256: "bad" })).toThrow();
  channel.port1.close(); channel.port2.close();
});

it("takes a Userspace start's handed manifest as its own copy within the manifest bound", () => {
  const request = { id: 1, version: PROTOCOL_VERSION, type: "prepare-userspace-rootfs", manifestUrl: "https://image.test/manifest.json",
    trustedKeyId: "author", trustedPublicKey: new Uint8Array(32), manifestSHA256: "a".repeat(64) };
  const shared = new Uint8Array(new SharedArrayBuffer(4));
  shared.set([1, 2, 3, 4]);
  const decoded = decodeStorageIncoming({ ...request, manifestBytes: shared });
  shared[0] = 9;
  expect(decoded).toMatchObject({ manifestBytes: new Uint8Array([1, 2, 3, 4]) });
  expect(() => decodeStorageIncoming({ ...request, manifestBytes: "manifest" })).toThrow();
  expect(() => decodeStorageIncoming({ ...request, manifestBytes: new Uint8Array(MAX_ROOTFS_METADATA_BYTES + 1) })).toThrow(/exceed their bound/u);
});

it("opens storage in the origin's own scope unless the runtime frame names its embedder's", () => {
  const channel = new MessageChannel();
  const request = { id: 1, version: PROTOCOL_VERSION, type: "initialize", workspaceId: "notes", snapshotPort: channel.port1 };
  const embedder = "fedcba9876543210fedcba9876543210";
  expect(decodeStorageIncoming(request)).toMatchObject({ storage: ORIGIN_STORAGE });
  expect(decodeStorageIncoming({ ...request, storage: embedder })).toMatchObject({ storage: { kind: "embedder", id: embedder } });
  for (const storage of ["", "fedcba9876543210", embedder.toUpperCase(), 1, { kind: "embedder", id: embedder }]) {
    expect(() => decodeStorageIncoming({ ...request, storage })).toThrow(expect.objectContaining({ code: "PROTOCOL_ERROR" }));
  }
  channel.port1.close(); channel.port2.close();
});

it("decodes a prepared Userspace rootfs with its workspace start (protocol 59) and refuses an inconsistent one", () => {
  const prepared = {
    id: "image", version: "1", cpuProfile: "x86-64-v2", rootTreeSha256: "a".repeat(64), workspaceBaseSha256: "b".repeat(64),
    fileCount: 0, totalBytes: 0, metadata: new Uint8Array(12), runtimes: { supportingFiles: [] },
  };
  const workspace = { state: "reconciled", conflicts: [], omittedConflicts: 0 };
  const decode = storageResponseDecoders["prepare-userspace-rootfs"];
  expect(decode({ ...prepared, workspace }).workspace).toEqual(workspace);
  // Read-only checkpoint metadata includes a verified base without replaying the workspace.
  expect(decode(prepared).workspaceBaseSha256).toBe(prepared.workspaceBaseSha256);
  expect(decode(prepared).workspace).toBeUndefined();
  const { workspaceBaseSha256: _base, ...baseless } = prepared;
  void _base;
  expect(decode(baseless).workspace).toBeUndefined();
  expect(() => decode({ ...baseless, workspace })).toThrow();
  expect(() => decode({ ...prepared, workspace: { ...workspace, state: "merged" } })).toThrow();
});
