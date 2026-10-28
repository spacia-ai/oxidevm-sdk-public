import { describe, expect, it } from "vitest";
import { MemoryDirectory, MemoryQuota } from "./opfs-double.test-support.js";
import { NativeSnapshotCapture } from "./snapshot-userspace-capture.js";
import { SnapshotObjects } from "./snapshot-objects.js";
import { SNAPSHOT_CHUNK_BYTES } from "./snapshot-manifest.js";
import { nativeGraphFixture } from "./userspace-checkpoint.test-support.js";
import { USERSPACE_API_VERSION } from "../userspace-abi.js";
import { NATIVE_LOGICAL_CHECKPOINT_VERSION } from "../protocol/native-capture.js";

async function setup(quota?: MemoryQuota) {
  const objects = await SnapshotObjects.open(new MemoryDirectory("snapshots", undefined, quota));
  const rootfs = { origin: "managed", image: { id: "alpine", version: "v1" }, rootTreeSha256: "a".repeat(64),
    manifest: await objects.put(new Uint8Array([1])) } as const;
  const capture = new NativeSnapshotCapture(objects, {
    snapshot: { id: "123e4567-e89b-42d3-a456-426614174000", createdAt: "2026-10-13T10:00:00.000Z" },
    kind: "named", memoryBytes: 256 * SNAPSHOT_CHUNK_BYTES,
  }, rootfs);
  return { capture, objects, rootfs };
}

describe("native snapshot capture", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])("records the actual native graph version %s", async version => {
    const { capture } = await setup();
    await capture.put("graph", 0, nativeGraphFixture(version));
    await capture.seal({ capturedAtUnixMs: 100, graphBytes: 85, payloadBytes: 0 });
    expect(capture.manifest().compatibility.version).toBe(version);
  });
  it("rejects malformed and unsupported graph headers before committing objects", async () => {
    const { capture } = await setup();
    for (const index of [0, 4, 8, 12, 16, 20, 24, 69, 73, 77, 83]) {
      const bytes = nativeGraphFixture(); bytes[index] = 255;
      await expect(capture.put("graph", 0, bytes)).rejects.toThrow();
    }
    await expect(capture.put("graph", 0, nativeGraphFixture(NATIVE_LOGICAL_CHECKPOINT_VERSION + 1))).rejects.toThrow();
    await expect(capture.put("graph", 0, nativeGraphFixture().subarray(0, 84))).rejects.toThrow();
  });
  it("preserves empty application data separately from no application data", async () => {
    const { capture, objects } = await setup();
    await capture.put("graph", 0, nativeGraphFixture());
    await capture.seal({ capturedAtUnixMs: 100, graphBytes: 85, payloadBytes: 0, appData: new Uint8Array() });
    const appData = capture.manifest().host?.appData;
    if (appData === undefined) throw new Error("empty application data was lost");
    expect(await objects.read(appData)).toEqual(new Uint8Array());
  });
  it("seals the final live streams and drops obsolete precopy chunks", async () => {
    const { capture, objects } = await setup();
    await capture.put("payloads", 0, new Uint8Array(SNAPSHOT_CHUNK_BYTES).fill(4));
    await capture.put("payloads", 1, new Uint8Array([5]));
    await capture.seal({ capturedAtUnixMs: 100, graphBytes: 85, payloadBytes: 2, appData: new Uint8Array([7]) });
    expect(() => capture.manifest()).toThrow(/incomplete/u);
    await capture.put("graph", 0, nativeGraphFixture());
    await capture.put("payloads", 0, new Uint8Array([8, 9]));
    const manifest = capture.manifest();
    expect(manifest).toMatchObject({ schema: 4, mode: "userspace", parent: null, compatibility: { format: "OXUC", version: 1, abiVersion: USERSPACE_API_VERSION },
      payloads: { bytes: 2, chunks: [{ index: 0, bytes: 2 }] } });
    const payload = manifest.payloads.chunks[0];
    const graph = manifest.graph.chunks[0];
    const appData = manifest.host?.appData;
    if (payload === undefined || graph === undefined || appData === undefined) throw new Error("capture objects missing");
    expect(await objects.read(payload)).toEqual(new Uint8Array([8, 9]));
    expect([...capture.objectRefs()]).toEqual(expect.arrayContaining([graph.sha256, appData.sha256]));
    await expect(capture.put("payloads", 1, new Uint8Array([6]))).rejects.toThrow(/chunk/u);
  });

  it("reuses unchanged precopy contents and requires every final chunk", async () => {
    const { capture } = await setup();
    await capture.put("payloads", 0, new Uint8Array(SNAPSHOT_CHUNK_BYTES).fill(2));
    await capture.put("graph", 0, nativeGraphFixture());
    await capture.seal({ capturedAtUnixMs: 100, graphBytes: 85, payloadBytes: SNAPSHOT_CHUNK_BYTES + 1 });
    expect(() => capture.manifest()).toThrow(/incomplete/u);
    await capture.put("payloads", 1, new Uint8Array([9]));
    expect(capture.manifest().payloads.chunks).toHaveLength(2);
    await expect(capture.seal({ capturedAtUnixMs: 101, graphBytes: 85, payloadBytes: 0 })).rejects.toThrow(/sealed/u);
  });

  it("never turns failed writes or invalid bounds into a complete capture", async () => {
    const quota = new MemoryQuota(4 * SNAPSHOT_CHUNK_BYTES);
    const { capture } = await setup(quota);
    await capture.seal({ capturedAtUnixMs: 100, graphBytes: 85, payloadBytes: SNAPSHOT_CHUNK_BYTES });
    await capture.put("graph", 0, nativeGraphFixture());
    quota.limit = quota.used;
    await expect(capture.put("payloads", 0, new Uint8Array(SNAPSHOT_CHUNK_BYTES))).rejects.toThrow();
    expect(() => capture.manifest()).toThrow(/incomplete/u);
    await expect(capture.put("payloads", -1, new Uint8Array([1]))).rejects.toThrow();
    await expect(capture.put("payloads", 0, new Uint8Array(SNAPSHOT_CHUNK_BYTES + 1))).rejects.toThrow();
  });
});
