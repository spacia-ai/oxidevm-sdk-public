import { expect, it, vi } from "vitest";
import { decodeFilesystemRecord, encodeFilesystemRecord } from "./userspace-rootfs-record.js";
import { AgentPayloadWriter, decodeAgentWorkspaceManifest } from "./agent-protocol.js";
import { captureSystemWorkspace } from "./workspace-sync.js";
import { indexWorkspaceSnapshot, encodeWorkspaceIndex, decodeWorkspaceIndex } from "./workers/workspace-index.js";

it("preserves native whiteout manifests without opening the device for content", async () => {
  const writer = new AgentPayloadWriter().u32(2);
  for (const path of ["/workspace/a", "/workspace/b"]) {
    writer.u8(5).u32(0).u32(1000).u32(1000).u64(0n).i64(0n).i64(0n)
      .u64(1n).u64(3n).string(path).bytes(new Uint8Array(40));
  }
  const body = writer.finish(), bytes = new Uint8Array(8 + body.length);
  bytes.set(new TextEncoder().encode("OXWM")); bytes[4] = 3; bytes.set(body, 8);
  const manifest = decodeAgentWorkspaceManifest(bytes);
  expect(manifest.map(entry => entry.kind)).toEqual(["whiteout", "whiteout"]);
  const read = vi.fn<(_: string) => Promise<Uint8Array>>(() => Promise.reject(new Error("device content must not be read")));
  const snapshot = await captureSystemWorkspace(manifest, read);
  expect(read).not.toHaveBeenCalled();
  expect(decodeFilesystemRecord(snapshot, "snapshot").map(entry => entry.tag)).toEqual([7, 4]);
  const index = await indexWorkspaceSnapshot(snapshot);
  expect(index.get("/workspace/a")?.kind).toBe("whiteout");
  expect(decodeWorkspaceIndex(encodeWorkspaceIndex(index))).toEqual(index);
  bytes[4] = 2;
  expect(() => decodeAgentWorkspaceManifest(bytes)).toThrow();
});

it.each(["rootfs", "snapshot", "delta"] as const)("preserves whiteout records and aliases in %s", kind => {
  const text = new TextEncoder(), path = "/workspace/old", alias = "/workspace/old-alias";
  const entries = [
    { tag: 7, mode: 0, path: text.encode(path), pathText: path, payload: new Uint8Array(), ownership: { uid: 1000, gid: 1000 } },
    { tag: 4, mode: 0, path: text.encode(alias), pathText: alias, payload: text.encode(path), ownership: { uid: 1000, gid: 1000 } },
  ];
  const bytes = encodeFilesystemRecord(entries, kind);
  expect(new DataView(bytes.buffer).getUint16(4, true)).toBe(kind === "delta" ? 5 : 10);
  expect(decodeFilesystemRecord(bytes, kind)).toEqual(entries);
  const legacy = bytes.slice(); new DataView(legacy.buffer).setUint16(4, kind === "delta" ? 4 : 9, true);
  expect(() => decodeFilesystemRecord(legacy, kind)).toThrow();
  expect(() => encodeFilesystemRecord([{ ...entries[0], tag: 7, mode: 0, path: text.encode(path), pathText: path, payload: new Uint8Array([1]) }], kind)).toThrow();
});
