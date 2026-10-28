import { workspacePublicationTransfers } from "../protocol/workspace-publication.js";
import { VMError, normalizeStorageError } from "../errors.js";
import { decodeRequestId } from "../protocol.js";
import {
  decodeUserspaceStorageIncoming, userspaceStorageClose, userspaceStorageFailure, userspaceStorageSuccess,
  type UserspaceStorageRequest, type UserspaceStorageValue,
} from "./userspace-storage-channel.js";
import { retireWorkspaceTransfer } from "./workspace-transfer.js";

/** One port owns its request identities and cancellation signals. A terminal
 * reply is sent only after the storage producer settles; cancellation never
 * discards a publication result. The storage worker retains all filesystem I/O. */
export function serveUserspaceStorage(port: MessagePort,
  handle: (request: UserspaceStorageRequest, signal: AbortSignal) => Promise<UserspaceStorageValue>,
): { close(): Promise<void> } {
  const active = new Map<number, AbortController>();
  let lastId = 0;
  let queue = Promise.resolve();
  let closing: Promise<void> | undefined;
  let peerClosed = false;
  let finishClose: (() => void) | undefined;
  const receive = (event: MessageEvent<unknown>): void => {
    let incoming: ReturnType<typeof decodeUserspaceStorageIncoming> | undefined;
    try {
      const request = incoming = decodeUserspaceStorageIncoming(event.data);
      if (request.type === "close") {
        peerClosed = true;
        void close().catch(() => {});
        finishClose?.();
        return;
      }
      if (request.type === "cancel") { active.get(request.requestId)?.abort(); return; }
      if (closing !== undefined) throw new VMError("ABORTED", "Userspace storage channel is retiring");
      if (request.id <= lastId) throw new VMError("PROTOCOL_ERROR", "Duplicate Userspace storage request");
      lastId = request.id;
      if (active.size >= 128) throw new VMError("QUOTA_EXCEEDED", "Userspace storage request queue is full");
      const controller = new AbortController();
      active.set(request.id, controller);
      queue = queue.then(async () => {
        try {
          if (!ownsRetirement(request)) requireActive(controller.signal);
          const value = await handle(request, controller.signal);
          if (request.type !== "commit-workspace-snapshot" && request.type !== "write-workspace" && !ownsRetirement(request)) requireActive(controller.signal);
          const buffer = transferBuffer(value);
          port.postMessage(userspaceStorageSuccess(request.id, value), buffer === undefined ? [] : [buffer]);
        } catch (error) {
          port.postMessage(userspaceStorageFailure(request.id, normalizeStorageError(error)));
        } finally { active.delete(request.id); }
      });
    } catch (error) {
      if (incoming?.type === "commit-root-overlay" || incoming?.type === "workspace" && incoming.request.type === "commit-workspace-streams") {
        const request = incoming;
        queue = queue.then(async () => {
          let failure = error;
          try {
            const transfers = request.type === "commit-root-overlay" ? [request.input]
              : request.request.type === "commit-workspace-streams" ? workspacePublicationTransfers(request.request.publication) : [];
            const results = await Promise.allSettled(transfers.map(retireWorkspaceTransfer));
            for (const result of results) if (result.status === "rejected") throw result.reason;
          }
          catch (retirementError) { failure = retirementError; }
          port.postMessage(userspaceStorageFailure(request.id, failure, true));
        });
        // Fence a saturated or invalid channel while draining all attached producers.
        void close().catch(() => {});
        return;
      }
      const id = decodeRequestId(event.data);
      if (id !== undefined) port.postMessage(userspaceStorageFailure(id, error));
    }
  };
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    const done = Promise.withResolvers<undefined>();
    closing = done.promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      port.removeEventListener("message", receive);
      port.removeEventListener("messageerror", messageError);
      port.close();
    };
    finishClose = () => {
      if (!peerClosed) return;
      finishClose = undefined;
      clearTimeout(timer);
      // The peer's close follows every transferred request on this same port.
      void queue.then(() => { cleanup(); done.resolve(undefined); }, (error: unknown) => { cleanup(); done.reject(error); });
    };
    for (const controller of active.values()) controller.abort();
    void queue.then(() => {
      if (peerClosed) { finishClose?.(); return; }
      port.postMessage(userspaceStorageClose());
      timer = setTimeout(() => {
        cleanup();
        done.reject(new VMError("STORAGE_ERROR", "Userspace storage peer retirement is uncertain", { cleanupFailed: true }));
      }, 30_000);
    }, (error: unknown) => { cleanup(); done.reject(error); });
    return closing;
  };
  const messageError = (): void => { void close().catch(() => { /* The storage worker also awaits close during disposal. */ }); };
  port.addEventListener("message", receive);
  port.addEventListener("messageerror", messageError);
  port.start();
  return { close };
}

function transferBuffer(value: UserspaceStorageValue): ArrayBuffer | undefined {
  if (value instanceof Uint8Array) return value.buffer;
  if (value !== undefined && typeof value !== "number" && "sha256" in value) return value.bytes.buffer;
  if(value!==undefined&&typeof value!=="number"&&"metadata" in value){if(!(value.metadata.buffer instanceof ArrayBuffer))throw new VMError("PROTOCOL_ERROR","Workspace metadata has no transferable owned buffer");return value.metadata.buffer;}
  return undefined;
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new VMError("ABORTED", "Userspace storage producer cancelled");
}

function ownsRetirement(request: UserspaceStorageRequest): boolean {
  return request.type === "commit-root-overlay" || request.type === "open-root-overlay" || request.type === "close-root-overlay"
    || request.type === "workspace" && request.request.type !== "read-workspace-frame";
}
