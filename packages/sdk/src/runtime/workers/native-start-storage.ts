import { VMError } from "../errors.js";
import type { NativeColdFiles, NativeColdRequest, NativeColdSelection } from "./native-cold-files.js";
import type { SnapshotStorageRequest } from "./snapshot-channel.js";
import type { SnapshotStore } from "./snapshot-store.js";

/** A Userspace cold start's storage requests, whichever owner serves them in this storage session. */
export interface NativeColdStarts {
  select(request: NativeColdSelection, signal: AbortSignal): Promise<{ readonly sourceId: string; readonly replaced?: string }>;
  abort(sourceId: string): Promise<void>;
  handle(request: NativeColdRequest, signal: AbortSignal): Promise<unknown>;
}

/** Restore points live in the snapshot store, which only OPFS provides. */
export function requireSnapshotStore(store: SnapshotStore | undefined): SnapshotStore {
  if (store === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "snapshots require OPFS");
  return store;
}

/**
 * Where a Userspace cold start goes. With restore-point storage (OPFS) the snapshot store serves it, so it waits for no
 * capture or restore in progress. Without it (the IndexedDB fallback) the cold start needs no restore point, so its own
 * owner serves it over the workspace selections; only restore-point requests refuse.
 */
export function nativeColdStarts(store: SnapshotStore | undefined, cold: NativeColdFiles | undefined): NativeColdStarts {
  if (store !== undefined) {
    return {
      select: (request, signal) => store.selectNativeFiles(request, signal),
      abort: sourceId => store.abortNativeFiles(sourceId),
      handle: (request, signal) => store.handleNative(request, signal),
    };
  }
  if (cold !== undefined) {
    return {
      select: (request, signal) => cold.select(request, signal),
      abort: sourceId => cold.abort(sourceId),
      handle: (request, signal) => cold.handle(request, signal),
    };
  }
  throw new VMError("FEATURE_NOT_AVAILABLE", "Userspace file storage is unavailable");
}

/**
 * The selection a retained workspace read names. During a restore it is the restore's prepared files; without
 * restore-point storage no restore exists, so a retained selection (a cold start's source) names itself.
 */
export function retainedReadId(store: SnapshotStore | undefined, id: string): string {
  return store?.retainedNativeReadId(id) ?? id;
}

export function isNativeColdRequest(request: SnapshotStorageRequest): request is NativeColdRequest {
  return request.type === "stage-native-cold-workspace" || request.type === "publish-native-cold" || request.type === "complete-native-cold";
}
