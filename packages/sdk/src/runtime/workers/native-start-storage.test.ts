import { expect, it } from "vitest";
import { NativeColdFiles } from "./native-cold-files.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { isNativeColdRequest, nativeColdStarts, requireSnapshotStore, retainedReadId } from "./native-start-storage.js";
import { opfsWorkspaceStoreBackend } from "./workspace-backend.js";
import { WorkspaceSelections } from "./workspace-selections.js";

const ROOT = "b".repeat(64);
const signal = () => new AbortController().signal;
function thrown(work: () => unknown): unknown {
  try { work(); } catch (error: unknown) { return error; }
  return undefined;
}

function coldOnly(): NativeColdFiles {
  const selections = new WorkspaceSelections(opfsWorkspaceStoreBackend(new MemoryDirectory()));
  const rootfs = { origin: "managed", image: { id: "alpine", version: "v1" }, rootTreeSha256: ROOT, manifest: { sha256: "c".repeat(64), bytes: 1 } } as const;
  return new NativeColdFiles({ workspaceId: "test", selections, rootfs: {
    pinImage: () => Promise.resolve({ rootfs, manifest: new Uint8Array([1]) }),
    releaseCheckpoint: () => Promise.resolve(),
    currentRootfs: () => ({ id: "alpine", version: "v1", cpuProfile: "x86-64-v2", rootTreeSha256: ROOT, fileCount: 0, totalBytes: 0, metadata: new Uint8Array(), runtimes: { supportingFiles: [] } }),
    beginCheckpointVerification: () => Promise.resolve(() => undefined),
  } });
}

it("serves a Userspace cold start (restorePoint: \"none\") without restore-point storage", async () => {
  const starts = nativeColdStarts(undefined, coldOnly());
  const { sourceId } = await starts.select({ boot: "live", rootTreeSha256: ROOT, rootPersistence: "ephemeral" }, signal());
  expect(sourceId).toMatch(/^[0-9a-f-]{36}$/u);
  await starts.abort(sourceId);
});

it("still refuses restore points without restore-point storage, naming OPFS", () => {
  expect(thrown(() => requireSnapshotStore(undefined))).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", message: "snapshots require OPFS" });
});

it("refuses a cold start when the session has no Userspace file storage at all", () => {
  expect(thrown(() => nativeColdStarts(undefined, undefined))).toMatchObject({ code: "FEATURE_NOT_AVAILABLE", message: "Userspace file storage is unavailable" });
});

it("routes exactly the three cold-start requests to the cold-start owner", () => {
  expect(isNativeColdRequest({ type: "publish-native-cold", sourceId: "s" })).toBe(true);
  expect(isNativeColdRequest({ type: "complete-native-cold", sourceId: "s" })).toBe(true);
  expect(isNativeColdRequest({ type: "native-session" })).toBe(false);
  expect(isNativeColdRequest({ type: "complete-native-restore" })).toBe(false);
});

it("reads a cold start's retained source by its own id when there is no restore-point storage", () => {
  expect(retainedReadId(undefined, "source")).toBe("source");
});
