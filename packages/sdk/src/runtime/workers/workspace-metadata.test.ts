import { describe, expect, it } from "vitest";
import { materializeUserspaceRootfsMetadata, mergeUserspaceWorkspaceDelta, mergeUserspaceWorkspaceSnapshot } from "../userspace-rootfs.js";
import { buildWorkspaceDelta, decodeSnapshot, mergeWorkspaceDeltas } from "./workspace-delta.js";
import { decodeWorkspaceIndex, decodeWorkspacePlan, encodeWorkspaceIndex, indexEntry, indexWorkspaceSnapshot, workspaceChanges } from "./workspace-index.js";
import { AgentPayloadWriter, decodeAgentWorkspaceManifest } from "../agent-protocol.js";
import { captureSystemWorkspace, sameWorkspaceManifest } from "../workspace-sync.js";
import { richWorkspaceSnapshot as fixture } from "./workspace-snapshot.test-support.js";

function empty(kind: "OXRF" | "OXWD"): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(12);
  bytes.set(new TextEncoder().encode(kind));
  new DataView(bytes.buffer).setUint16(4, kind === "OXRF" ? 5 : 1, true);
  return bytes;
}

function entryOffset(bytes: Uint8Array<ArrayBuffer>, path: string): number {
  const view = new DataView(bytes.buffer);
  for (let offset = 12; offset < bytes.length;) {
    const pathLength = view.getUint32(offset + 4, true), payloadLength = view.getUint32(offset + 8, true);
    if (new TextDecoder().decode(bytes.subarray(offset + 24, offset + 24 + pathLength)) === path) return offset;
    offset += 24 + pathLength + payloadLength + view.getUint32(offset + 20, true);
  }
  throw new Error("missing fixture path");
}

function nativeManifest(): Uint8Array<ArrayBuffer> {
  const entries = decodeSnapshot(fixture()), byPath = new Map(entries.map(entry => [entry.path, entry]));
  const writer = new AgentPayloadWriter().u32(entries.length);
  for (const entry of entries) {
    const source = entry.tag === 4 ? byPath.get(new TextDecoder().decode(entry.payload)) : entry;
    if (source === undefined || entry.metadata === undefined) throw new Error("missing inode fixture");
    const kind = source.tag === 0 ? 1 : source.tag === 2 ? 3 : source.tag === 6 ? 4 : 2;
    const inode = source.tag === 0 ? 1n : source.tag === 2 ? 3n : source.tag === 6 ? 4n : 2n;
    writer.u8(kind).u32(entry.mode).u32(1000).u32(1000).u64(BigInt(source.payload.length))
      .i64(2_000_000_123n).i64(3_000_000_456n).u64(8n).u64(inode).string(entry.path);
    if (kind === 3) writer.string(new TextDecoder().decode(source.payload));
    writer.bytes(entry.metadata);
  }
  const body = writer.finish(), output = new Uint8Array(8 + body.length);
  output.set(new TextEncoder().encode("OXWM")); output[4] = 2; output.set(body, 8);
  return output;
}

describe("rich workspace records", () => {
  it("preserves the shared Rust fixture through snapshot, delta, materialization and mount merge", async () => {
    const rich = fixture();
    expect(decodeSnapshot(rich).map(entry => entry.tag)).toEqual([0, 1, 4, 2, 4, 6, 4]);
    expect(await materializeUserspaceRootfsMetadata(rich, new Map())).toEqual(rich);
    expect(mergeUserspaceWorkspaceSnapshot(empty("OXRF"), rich)).toEqual(rich);
    const delta = await buildWorkspaceDelta(rich, [], []);
    expect(new DataView(delta.buffer).getUint16(4, true)).toBe(4);
    expect(mergeUserspaceWorkspaceDelta(empty("OXRF"), delta)).toEqual(rich);
    expect(mergeUserspaceWorkspaceDelta(empty("OXRF"), mergeWorkspaceDeltas(empty("OXWD"), delta))).toEqual(rich);
  });

  it("retains metadata-only differences from the immutable base", async () => {
    const delta = await buildWorkspaceDelta(fixture(), [{ type: "directory", path: "workspace", mode: 0o755,
      ownership: { uid: 1000, gid: 1000 } }], []);
    expect(new DataView(delta.buffer).getUint32(8, true)).toBe(7);
  });

  it("rejects recorded hardlinks with conflicting ownership, mode or inode metadata", () => {
    for (const field of ["ownership", "mode", "metadata"]) {
      const rich = fixture(), offset = entryOffset(rich, "/workspace/b"), view = new DataView(rich.buffer);
      const byte = field === "ownership" ? offset + 12 : field === "mode" ? offset + 2
        : offset + 24 + view.getUint32(offset + 4, true) + view.getUint32(offset + 8, true) + 24;
      rich[byte] = (rich[byte] ?? 0) ^ 1;
      expect(() => decodeSnapshot(rich)).toThrow();
      expect(() => mergeUserspaceWorkspaceSnapshot(empty("OXRF"), rich)).toThrow();
    }
  });

  it("indexes FIFOs and metadata changes, including the workspace root, across restore-point serialization", async () => {
    const rich = fixture(), index = await indexWorkspaceSnapshot(rich);
    expect(index.get("/workspace/pipe")?.kind).toBe("fifo");
    const encoded = encodeWorkspaceIndex(index);
    expect(new TextDecoder().decode(encoded)).toContain('"formatVersion":3');
    expect(decodeWorkspaceIndex(encoded)).toEqual(index);
    const changed = rich.slice();
    changed[46] = (changed[46] ?? 0) ^ 1;
    const changes = await workspaceChanges(index, changed);
    expect(changes.map(change => change.path)).toEqual(["/workspace"]);
    const plan = { kind: "changed", generation: 2, changes };
    expect(decodeWorkspacePlan(structuredClone(plan))).toEqual(plan);
    const file = decodeSnapshot(rich)[1];
    if (file?.metadata === undefined) throw new Error("missing file metadata");
    const metadata = file.metadata.slice(); metadata[0] = (metadata[0] ?? 0) ^ 1;
    expect(await indexEntry({ ...file, metadata })).not.toEqual(await indexEntry(file));
  });

  it("captures a native OXWM2 manifest without opening FIFOs or duplicating inode aliases", async () => {
    const wire = nativeManifest(), manifest = decodeAgentWorkspaceManifest(wire), reads: string[] = [];
    expect(await captureSystemWorkspace(manifest, path => {
      reads.push(path);
      if (path !== "/workspace/a") throw new Error("capture opened a non-file or repeated inode");
      return Promise.resolve(new TextEncoder().encode("body"));
    })).toEqual(fixture());
    expect(reads).toEqual(["/workspace/a"]);
    expect(sameWorkspaceManifest(manifest, decodeAgentWorkspaceManifest(wire))).toBe(true);
    const modified = wire.slice(); modified[modified.length - 40] = (modified[modified.length - 40] ?? 0) ^ 1;
    expect(sameWorkspaceManifest(manifest, decodeAgentWorkspaceManifest(modified))).toBe(false);
    for (let end = 0; end < wire.length; end += 1) expect(() => decodeAgentWorkspaceManifest(wire.slice(0, end))).toThrow();
  });

  it("rejects every truncated record, malformed metadata and forbidden FIFO payloads", () => {
    const rich = fixture();
    for (let end = 0; end < rich.length; end += 1) expect(() => decodeSnapshot(rich.slice(0, end))).toThrow();
    for (const [offset, value] of [[4, 8], [6, 1], [12, 5], [13, 2], [32, 255], [57, 255]]) {
      if (offset === undefined || value === undefined) throw new Error("invalid mutation");
      const malformed = rich.slice(); malformed[offset] = value;
      expect(() => decodeSnapshot(malformed)).toThrow();
      expect(() => mergeUserspaceWorkspaceSnapshot(empty("OXRF"), malformed)).toThrow();
    }
    const payloadFifo = rich.slice(); payloadFifo[entryOffset(payloadFifo, "/workspace/a")] = 6;
    expect(() => decodeSnapshot(payloadFifo)).toThrow();
  });
});
