import type { BackupDestination } from "../../contracts.js";
import { VMError, deserializeError, serializeUnknownError } from "../../runtime/errors.js";
import { MAX_BACKUP_CHUNK, decodeBackupCallReply } from "../protocol/backup-port.js";

/**
 * A backup destination that lives in the page, used from the runtime frame: every call waits for
 * the page's reply, and writes larger than one message are split.
 */
export function remoteBackupDestination(port: MessagePort): BackupDestination {
  const pending = new Map<number, PromiseWithResolvers<undefined>>();
  let nextId = 1;
  let failure: VMError | undefined;
  port.addEventListener("message", (event: MessageEvent) => {
    let reply;
    try { reply = decodeBackupCallReply(event.data); }
    catch (error: unknown) {
      failure = error instanceof VMError ? error : new VMError("PROTOCOL_ERROR", "backup destination reply is invalid");
      for (const call of pending.values()) call.reject(failure);
      pending.clear();
      return;
    }
    const call = pending.get(reply.id);
    pending.delete(reply.id);
    if (reply.error === null) call?.resolve(undefined); else call?.reject(deserializeError(reply.error));
  });
  port.start();
  const send = (message: Readonly<Record<string, unknown>>, transfer: readonly Transferable[] = []): Promise<void> => {
    if (failure !== undefined) return Promise.reject(failure);
    const id = nextId++;
    const call = Promise.withResolvers<undefined>();
    pending.set(id, call);
    port.postMessage({ ...message, id }, [...transfer]);
    return call.promise.then(() => undefined);
  };
  return {
    kind: "file",
    createWritable: async options => {
      await send({ type: "open", keepExistingData: options?.keepExistingData === true });
      return {
        write: async bytes => {
          for (let offset = 0; offset < bytes.byteLength; offset += MAX_BACKUP_CHUNK) {
            const piece = bytes.slice(offset, offset + MAX_BACKUP_CHUNK);
            await send({ type: "write", bytes: piece }, [piece.buffer]);
          }
        },
        close: async () => { await send({ type: "close" }); port.close(); },
        abort: async reason => { await send({ type: "abort", reason: reason === undefined ? null : serializeUnknownError(reason) }); port.close(); },
      };
    },
  };
}
