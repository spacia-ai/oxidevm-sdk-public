import type { BackupDestination } from "../../contracts.js";
import { VMError, deserializeError, serializeUnknownError } from "../../runtime/errors.js";
import { decodeBackupCall } from "../protocol/backup-port.js";

type Writable = Awaited<ReturnType<BackupDestination["createWritable"]>>;

/**
 * Serves a page-held backup destination to the runtime frame over `port`, one call at a time. The
 * port closes when the frame closes or aborts the writable, or sends anything malformed.
 */
export function serveBackupDestination(destination: BackupDestination, port: MessagePort): void {
  let writable: Writable | undefined;
  let queue = Promise.resolve();
  const finish = () => port.close();
  port.addEventListener("message", (event: MessageEvent) => {
    let call;
    try { call = decodeBackupCall(event.data); } catch { finish(); return; }
    queue = queue.then(async () => {
      try {
        switch (call.type) {
          case "open":
            if (writable !== undefined) throw new VMError("PROTOCOL_ERROR", "the backup destination is already open");
            writable = await destination.createWritable({ keepExistingData: call.keepExistingData });
            break;
          case "write":
            if (writable === undefined) throw new VMError("PROTOCOL_ERROR", "the backup destination is not open");
            await writable.write(call.bytes);
            break;
          case "close":
            await writable?.close();
            writable = undefined;
            break;
          case "abort":
            await writable?.abort(call.reason === null ? undefined : deserializeError(call.reason));
            writable = undefined;
            break;
        }
        port.postMessage({ type: "reply", id: call.id, error: null });
      } catch (error: unknown) {
        port.postMessage({ type: "reply", id: call.id, error: serializeUnknownError(error) });
      }
      if (call.type === "close" || call.type === "abort") finish();
    });
  });
  port.start();
}
