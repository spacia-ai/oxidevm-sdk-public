import { VMError, normalizeStorageError, serializeUnknownError } from "../errors.js";
import { decodeRequestId } from "../protocol.js";
import {
  decodeSnapshotStorageRequest,
  cancellableWorkspaceOperation,
  snapshotStorageFailure,
  snapshotStorageResponse,
  snapshotCaptureProgress, snapshotImageProgress, type SnapshotStorageProgress,
  type SnapshotStorageRequest,
} from "./snapshot-channel.js";

export function serveSnapshotStorage(
  port: MessagePort,
  handle: (request: SnapshotStorageRequest, signal: AbortSignal, progress: (progress: SnapshotStorageProgress) => void) => Promise<unknown>,
  retire?: () => Promise<void>,
): { close(): Promise<void> } {
  const pending = new Map<number, { controller: AbortController; type: SnapshotStorageRequest["type"]; work: Promise<void> }>();
  let lastId = 0;
  let closing: Promise<void> | undefined;
  let closed = false;
  const failure = (id: number, error: unknown): void => {
    port.postMessage(snapshotStorageFailure(id, serializeUnknownError(normalizeStorageError(error))));
  };
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closed = true;
    for (const entry of pending.values()) entry.controller.abort();
    closing = Promise.allSettled([...pending.values()].map(entry => entry.work)).then(async () => {
      try { await retire?.(); }
      finally { port.close(); }
    });
    return closing;
  };
  port.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (closed) return;
    let id: number | undefined;
    try {
      const decoded = decodeSnapshotStorageRequest(event.data);
      id = decoded.id;
      if (id <= lastId) throw new VMError("PROTOCOL_ERROR", "stale snapshot storage request");
      lastId = id;
      if (decoded.request.type === "cancel-workspace-operation") {
        if (decoded.request.requestId >= id) throw new VMError("PROTOCOL_ERROR", "invalid publication cancellation identity");
        const target = pending.get(decoded.request.requestId);
        if (target !== undefined && !cancellableWorkspaceOperation(target.type)) throw new VMError("PROTOCOL_ERROR", "cancellation target is not a workspace operation");
        target?.controller.abort();
        port.postMessage(snapshotStorageResponse(id, undefined));
        return;
      }
      if (pending.size >= 128) throw new VMError("QUOTA_EXCEEDED", "snapshot storage request queue is full");
      const controller = new AbortController();
      const completed = Promise.withResolvers<undefined>();
      pending.set(id, { controller, type: decoded.request.type, work: completed.promise });
      const requestId = id;
      // Enqueue synchronously in the storage owner's existing queue before disposal can enter it.
      let result: Promise<unknown>;
      try {
        result = handle(decoded.request, controller.signal, completedObjects => {
          if(typeof completedObjects!=="number"){
            if((decoded.request.type!=="prepare-native-image"&&decoded.request.type!=="open-native-capture")||!Number.isSafeInteger(completedObjects.completedBytes)||!Number.isSafeInteger(completedObjects.totalBytes)||completedObjects.completedBytes<0||completedObjects.totalBytes<completedObjects.completedBytes)throw new VMError("PROTOCOL_ERROR","Invalid image preparation progress");
            if(!controller.signal.aborted)port.postMessage(snapshotImageProgress(requestId,completedObjects));return;
          }
          if (decoded.request.type !== "open-native-capture" || !Number.isSafeInteger(completedObjects) || completedObjects < 1) {
            throw new VMError("PROTOCOL_ERROR", "Unexpected snapshot capture progress");
          }
          if (!controller.signal.aborted) port.postMessage(snapshotCaptureProgress(requestId, completedObjects));
        });
      } catch (error) {
        result = Promise.reject(normalizeStorageError(error));
      }
      void result.then(value => {
        // A response that cannot be posted fails its own request; closing would leave every
        // caller waiting on a channel that no longer answers.
        try {
          port.postMessage(snapshotStorageResponse(requestId, value), value instanceof Uint8Array ? [value.buffer] : []);
        } catch (error) {
          failure(requestId, error);
        }
      }, (error: unknown) => failure(requestId, error)).catch(() => {
        void close().catch(() => {});
      }).finally(() => {
        pending.delete(requestId);
        completed.resolve(undefined);
      });
    } catch (error) {
      id ??= decodeRequestId(event.data);
      if (id !== undefined) failure(id, error);
    }
  });
  port.addEventListener("messageerror", () => { void close().catch(() => {}); });
  port.start();
  return { close };
}
