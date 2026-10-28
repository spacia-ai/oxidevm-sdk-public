import { VMError } from "../errors.js";
import { mergeUserspaceWorkspaceDelta, mergeUserspaceWorkspaceSnapshot } from "../userspace-rootfs.js";
import { IN_SYNC_WORKSPACE, workspaceStart, type UserspaceWorkspaceStart, type PreservedWorkspaceReason } from "../protocol/workspace-start.js";
import { buildWorkspaceDelta, decodeDelta, decodeSnapshot, encodeDelta, type SnapshotEntry } from "./workspace-delta.js";
import { rebaseWorkspaceDelta, type WorkspaceImage } from "./workspace-rebase.js";
import type { WorkspaceStore } from "./workspace-store.js";

/** The images a Userspace start can consult: the one it boots and those this browser cached. */
export interface UserspaceWorkspaceImages {
  workspaceImage(workspaceBaseSha256: string): Promise<WorkspaceImage | undefined>;
  cachedBlob(sha256: string, bytes: number): Promise<Uint8Array<ArrayBuffer> | undefined>;
}

/** The image being booted: its workspace identity and its runtime metadata (OXRF). */
export interface BootingUserspaceImage {
  readonly workspaceBaseSha256: string;
  readonly metadata: Uint8Array;
}

/**
 * Makes the workspace's saved /workspace bootable on `image` before the runtime mounts it. A save
 * made on this image is checked and kept. One made on another image is carried over as the
 * user's changes against that image, onto this one. A save that cannot be read or applied is kept
 * aside under a preserved id and the image's own /workspace boots; it never stops the VM.
 */
export async function openUserspaceWorkspace(
  store: WorkspaceStore,
  images: UserspaceWorkspaceImages,
  image: BootingUserspaceImage,
  signal: AbortSignal,
): Promise<UserspaceWorkspaceStart> {
  const overlay = await store.readOverlay(signal);
  if (overlay.kind === "none") return IN_SYNC_WORKSPACE;
  if (overlay.kind === "damaged") return setAside(store, image, "unreadable", signal);
  if (overlay.workspaceBaseSha256 === image.workspaceBaseSha256) {
    return replays(image.metadata, overlay.snapshot, overlay.delta) ? IN_SYNC_WORKSPACE : setAside(store, image, "unreplayable", signal);
  }
  const previous = await images.workspaceImage(overlay.workspaceBaseSha256);
  let changes: SnapshotEntry[] | undefined;
  try {
    // The delta is what the user changed against the image the save was made on. An older save
    // that holds only the whole tree yields it when that image is still known here.
    changes = overlay.delta !== undefined ? decodeDelta(overlay.delta)
      : overlay.snapshot !== undefined && previous !== undefined
        ? decodeDelta(await buildWorkspaceDelta(overlay.snapshot, previous.entries, previous.blobs))
        : undefined;
  } catch (error) {
    if (!isRecordFailure(error)) throw error;
    return setAside(store, image, "unreadable", signal);
  }
  if (changes === undefined) return setAside(store, image, "base-unavailable", signal);
  const next = await images.workspaceImage(image.workspaceBaseSha256);
  if (next === undefined) throw new VMError("STORAGE_ERROR", "the booting image's workspace tree is unavailable", { reason: "workspace-base-missing" });
  const rebased = await rebaseWorkspaceDelta({ delta: changes, previous, next, content: (sha256, bytes) => images.cachedBlob(sha256, bytes) });
  const delta = encodeDelta(rebased.delta);
  if (!replays(image.metadata, undefined, delta)) return setAside(store, image, "unreplayable", signal);
  const unavailable = rebased.conflicts.some(conflict => conflict.reason === "content-unavailable");
  const replaced = await store.replace(image.workspaceBaseSha256, delta, unavailable, signal);
  return workspaceStart(true, rebased.conflicts, replaced.preserved === undefined ? undefined
    : { id: replaced.preserved, reason: unavailable ? "content-unavailable" : "unreadable" });
}

async function setAside(store: WorkspaceStore, image: BootingUserspaceImage, reason: PreservedWorkspaceReason, signal: AbortSignal): Promise<UserspaceWorkspaceStart> {
  const { preserved } = await store.replace(image.workspaceBaseSha256, encodeDelta([]), true, signal);
  return workspaceStart(false, [], preserved === undefined ? undefined : { id: preserved, reason });
}

/** Whether the runtime's replay of the saved records onto `metadata` would succeed. */
function replays(metadata: Uint8Array, snapshot: Uint8Array<ArrayBuffer> | undefined, delta: Uint8Array<ArrayBuffer> | undefined): boolean {
  try {
    if (snapshot !== undefined) decodeSnapshot(snapshot);
    if (delta !== undefined) decodeDelta(delta);
    const replayed = snapshot === undefined ? metadata : mergeUserspaceWorkspaceSnapshot(metadata, snapshot);
    if (delta !== undefined) mergeUserspaceWorkspaceDelta(replayed, delta);
    return true;
  } catch (error) {
    if (isRecordFailure(error)) return false;
    throw error;
  }
}

function isRecordFailure(error: unknown): boolean {
  return error instanceof VMError && (error.code === "STORAGE_ERROR" || error.code === "PROTOCOL_ERROR");
}
