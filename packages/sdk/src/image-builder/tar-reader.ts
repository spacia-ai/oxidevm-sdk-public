import { createReadStream } from "node:fs";
import type { Parser } from "tar";
import { VMError } from "../runtime/errors.js";
import { abortIfRequested } from "./tools.js";

/** Own the reader and parser together; validation errors and cancellation stop decompression. */
export async function readTarFile(archive: string, parser: Parser, signal?: AbortSignal): Promise<void> {
  abortIfRequested(signal);
  await new Promise<void>((resolve, reject) => {
    const reader = createReadStream(archive, { highWaterMark: 256 * 1024 });
    let finished = false;
    function finish(error?: Error): void {
      if (finished) return;
      finished = true; signal?.removeEventListener("abort", abort); reader.destroy();
      if (error === undefined) resolve(); else reject(error);
    }
    const abort = () => parser.abort(new VMError("ABORTED", "source archive reading was cancelled"));
    parser.on("error", (error: Error) => finish(error));
    parser.once("close", () => finish());
    reader.once("error", (error: Error) => { parser.abort(error); finish(error); });
    // tar's parser is not a Node Writable. Own backpressure and cancellation without pipe's destroy contract.
    reader.on("data", (bytes: unknown) => {
      if (finished) return;
      if (!(bytes instanceof Uint8Array)) { parser.abort(new VMError("PROTOCOL_ERROR", "source reader returned invalid bytes")); return; }
      try { if (!parser.write(bytes)) reader.pause(); }
      catch (error) { const failure = error instanceof Error ? error : new Error("source parser failed"); parser.abort(failure); finish(failure); }
    });
    parser.on("drain", () => { if (!finished) reader.resume(); });
    reader.once("end", () => { if (!finished) parser.end(); });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
  });
}
