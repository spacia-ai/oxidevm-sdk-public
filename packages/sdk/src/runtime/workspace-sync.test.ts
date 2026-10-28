import { describe, expect, it } from "vitest";

import { AgentPayloadWriter, decodeAgentWorkspaceManifest, type AgentWorkspaceManifestEntry } from "./agent-protocol.js";
import { captureSystemWorkspace } from "./workspace-sync.js";

const node = {
  mode: 0o644,
  size: 5n,
  mtimeNs: 1n,
  ctimeNs: 1n,
  device: 7n,
  inode: 9n,
} as const;

describe("system workspace capture", () => {
  it("selects the same UTF-8 hardlink source as Linux", async () => {
    const reads: string[] = [];
    await captureSystemWorkspace([
      { ...node, kind: "file", path: "/workspace/\u{10000}" },
      { ...node, kind: "file", path: "/workspace/\ue000" },
    ], path => {
      reads.push(path);
      return Promise.resolve(new TextEncoder().encode("hello"));
    });
    expect(reads).toEqual(["/workspace/\ue000"]);
  });
  it("captures authenticated v4 ownership including the workspace root", async () => {
    const records = new AgentPayloadWriter().u32(1).u8(1).u32(0o750).u32(1000).u32(1001)
      .u64(0n).i64(0n).i64(0n).u64(1n).u64(2n).string("/workspace").finish();
    const bytes = new Uint8Array(8 + records.length);
    bytes.set(new TextEncoder().encode("OXWM")); bytes[4] = 1; bytes.set(records, 8);
    const manifest = decodeAgentWorkspaceManifest(bytes);
    expect(manifest[0]?.ownership).toEqual({ uid: 1000, gid: 1001 });
    const snapshot = await captureSystemWorkspace(manifest, () => { throw new Error("directory cannot be read as a file"); });
    const view = new DataView(snapshot.buffer);
    expect(view.getUint16(4, true)).toBe(6);
    expect(view.getUint32(24, true)).toBe(1000);
    expect(view.getUint32(28, true)).toBe(1001);
  });
  it("sorts paths and preserves hardlink identity in OXRF v5", async () => {
    const manifest: AgentWorkspaceManifestEntry[] = [
      { ...node, kind: "file", path: "/workspace/b" },
      { ...node, kind: "file", path: "/workspace/a" },
      { ...node, kind: "directory", mode: 0o755, size: 0n, inode: 2n, path: "/workspace/src" },
      { ...node, kind: "symlink", mode: 0o777, size: 1n, inode: 3n, path: "/workspace/z", target: "a" },
    ];
    const reads: string[] = [];
    const snapshot = await captureSystemWorkspace(manifest, (path) => {
      reads.push(path);
      return Promise.resolve(new TextEncoder().encode("hello"));
    });
    expect(new TextDecoder().decode(snapshot.subarray(0, 4))).toBe("OXRF");
    expect(new DataView(snapshot.buffer).getUint16(4, true)).toBe(5);
    expect(new DataView(snapshot.buffer).getUint32(8, true)).toBe(4);
    expect(reads).toEqual(["/workspace/a"]);
    expect([...snapshot].filter((value) => value === 4)).not.toHaveLength(0);
  });

  it("fails closed when a file changes during capture", async () => {
    await expect(captureSystemWorkspace(
      [{ ...node, kind: "file", path: "/workspace/a" }],
      () => Promise.resolve(new Uint8Array([1])),
    )).rejects.toThrow(/changed while synchronizing/u);
  });
});
