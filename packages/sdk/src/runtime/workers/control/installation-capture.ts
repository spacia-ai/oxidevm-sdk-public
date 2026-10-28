import { integer } from "../../decode.js";
import { VMError } from "../../errors.js";
import type { InstallationReply } from "../../protocol/assistance-installation-reply.js";
import type { WorkspaceStreamInput } from "../workspace-stream.js";
import { CAPTURE_WINDOW } from "../../protocol/assistance-installation.js";

type Operation = { readonly kind: "capture-read"; readonly length: number } | { readonly kind: "capture-retire" };

/** Reads kept in flight per capture so the console round trip is not paid per
 * 64 KiB frame. The guest admits exactly this window and answers in order. */
export const CAPTURE_READ_WINDOW = CAPTURE_WINDOW;
const FRAME_BYTES = 65536;

/** Uses the installation's existing sequence/ACK owner. Data failure and physical
 * retirement are independent: only an uncertain receipt prevents cleanup. */
export function installationCapture(bytes: number, exchange: (operation: Operation) => Promise<InstallationReply>): WorkspaceStreamInput & { retire(): Promise<void> } {
  integer(bytes, "capture length", 0, 1024 ** 4);
  let opened = false;
  let stopping = false;
  const inFlight: Promise<InstallationReply>[] = [];
  let retirement: Promise<number> | undefined;
  let detach = () => {};
  const retireOutcome = (): Promise<number> => {
    stopping = true;
    retirement ??= (async () => {
      const pendingReads = [...inFlight];
      const reply = await exchange({ kind: "capture-retire" });
      if (reply.result.kind !== "capture-retired") throw new VMError("PROTOCOL_ERROR", "Missing capture retirement receipt");
      // The receipt may overtake data delivery. Outstanding ACKs still own credits.
      await Promise.allSettled(pendingReads);
      detach();
      return reply.result.errno;
    })();
    void retirement.catch(() => {});
    return retirement;
  };
  const retire = async (): Promise<void> => { await retireOutcome(); };
  return { bytes, retire, source(signal) {
    if (opened) throw new VMError("PROTOCOL_ERROR", "Capture stream already consumed");
    opened = true;
    const abort = () => { void retire().catch(() => {}); };
    if (!stopping) {
      signal.addEventListener("abort", abort, { once: true });
      detach = () => signal.removeEventListener("abort", abort);
    }
    if (signal.aborted) abort();
    const cancelled = () => signal.aborted || stopping;
    const frames = (async function* (): AsyncGenerator<Uint8Array<ArrayBuffer>, void, unknown> {
      let received = 0;
      // Keep the window full until EOF is seen: one read may run past the
      // announced length to observe EOF. Replies settle in request order.
      const fill = () => {
        while (inFlight.length < CAPTURE_READ_WINDOW && received + inFlight.length * FRAME_BYTES <= bytes) {
          const read = exchange({ kind: "capture-read", length: FRAME_BYTES });
          inFlight.push(read);
          void read.catch(() => {});
        }
      };
      for (;;) {
        if (cancelled()) throw new VMError("ABORTED", "Dependency capture cancelled");
        fill();
        const pending = inFlight[0];
        if (pending === undefined) throw new VMError("PROTOCOL_ERROR", "Capture read window is empty");
        let reply: InstallationReply;
        try { reply = await pending; }
        finally { void inFlight.splice(inFlight.indexOf(pending), 1); }
        if (cancelled()) throw new VMError("ABORTED", "Dependency capture cancelled");
        if (reply.result.kind !== "data") throw new VMError("STORAGE_ERROR", "Dependency capture read failed",
          reply.result.kind === "error" ? { errno: reply.result.errno } : undefined);
        const frame = reply.result.bytes;
        if (!(frame.buffer instanceof ArrayBuffer) || frame.byteOffset !== 0 || frame.buffer.byteLength !== frame.byteLength
          || frame.byteLength > FRAME_BYTES || frame.byteLength > bytes - received) {
          throw new VMError("PROTOCOL_ERROR", "Invalid dependency capture frame");
        }
        if (frame.byteLength === 0) {
          const errno = await retireOutcome();
          if (errno !== 0 || received !== bytes) throw new VMError("STORAGE_ERROR", "Dependency capture did not complete", { errno });
          return;
        }
        received += frame.byteLength;
        // Refill before handing the frame over so a slow consumer never drains the window.
        fill();
        yield new Uint8Array(frame.buffer);
      }
    })();
    return { frames, retire };
  } };
}
