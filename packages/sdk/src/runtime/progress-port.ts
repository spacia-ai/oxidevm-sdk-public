import { type ArchiveProgress, decodeArchiveProgressMessage } from "./protocol.js";

/**
 * Runs a storage request that reports progress on its own port: each progress message reaches
 * `onProgress` in its own microtask, and a malformed one ends the reporting, not the request.
 * The port closes when the request settles.
 */
export async function withProgressPort<T>(
  onProgress: ((progress: ArchiveProgress) => void) | undefined,
  request: (port: MessagePort) => Promise<T>,
): Promise<T> {
  const { port1, port2 } = new MessageChannel();
  if (onProgress !== undefined) {
    port1.addEventListener("message", (event: MessageEvent<unknown>) => {
      let progress: ArchiveProgress;
      try {
        progress = decodeArchiveProgressMessage(event.data);
      } catch {
        port1.close();
        return;
      }
      queueMicrotask(() => {
        onProgress(progress);
      });
    });
    port1.start();
  }
  try {
    return await request(port2);
  } finally {
    port1.close();
  }
}
