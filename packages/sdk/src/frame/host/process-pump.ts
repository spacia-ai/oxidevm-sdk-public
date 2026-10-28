import type { ProcessHandle, TerminalHandle } from "../../contracts.js";
import { VMError } from "../../runtime/errors.js";
import { MAX_PROCESS_CHUNK, PROCESS_STREAM_CREDIT, decodeProcessPageMessage, encodeExit, processError } from "../protocol/process-io.js";
import type { ProcessControl, ProcessStreamName } from "../protocol/process-io.js";

// The frame's side of one guest process: each output stream is read only while the page has
// granted credit, so a page that stops reading stops the guest's output at its own pipe; stdin
// is granted to the page as the guest takes it.

interface StreamPump {
  credit: number;
  wake: PromiseWithResolvers<undefined> | undefined;
  cancelled: boolean;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
}

export function pumpProcess(handle: ProcessHandle | TerminalHandle, port: MessagePort): void {
  const post = (message: Readonly<Record<string, unknown>>, transfer: readonly Transferable[] = []) => { port.postMessage(message, [...transfer]); };
  const sources: readonly (readonly [ProcessStreamName, ReadableStream<Uint8Array>])[] = handle.kind === "terminal"
    ? [["output", handle.output]]
    : [["stdout", handle.stdout], ["stderr", handle.stderr]];
  const pumps = new Map<ProcessStreamName, StreamPump>(sources.map(([name, stream]) => [name, { credit: 0, wake: undefined, cancelled: false, reader: stream.getReader() }]));
  const stdin = handle.stdin.getWriter();
  let stdinQueue = Promise.resolve();

  const control = async (call: ProcessControl): Promise<void> => {
    switch (call.op) {
      case "kill": return handle.kill(call.signal, { scope: call.scope });
      case "resize": if (handle.kind !== "terminal") throw notTerminal(); return handle.resize({ columns: call.columns, rows: call.rows });
      case "interrupt": if (handle.kind !== "terminal") throw notTerminal(); return handle.interrupt();
    }
  };

  port.addEventListener("message", (event: MessageEvent) => {
    let message;
    try { message = decodeProcessPageMessage(event.data); }
    catch { void handle.kill("SIGKILL", { scope: "process-group" }).catch(() => {}); port.close(); return; }
    switch (message.type) {
      case "credit": {
        const pump = pumps.get(message.stream);
        if (pump === undefined) return;
        pump.credit += message.bytes;
        pump.wake?.resolve(undefined); pump.wake = undefined;
        return;
      }
      case "cancel": {
        const pump = pumps.get(message.stream);
        if (pump === undefined) return;
        pump.cancelled = true;
        pump.wake?.resolve(undefined); pump.wake = undefined;
        void pump.reader.cancel().catch(() => {});
        return;
      }
      case "stdin": {
        const bytes = message.bytes;
        stdinQueue = stdinQueue.then(() => stdin.write(bytes)).then(
          () => post({ type: "stdin-credit", bytes: bytes.byteLength }),
          (error: unknown) => { post({ type: "stdin-error", error: processError(error) }); },
        );
        return;
      }
      case "stdin-close":
        stdinQueue = stdinQueue.then(() => stdin.close()).catch(() => {});
        return;
      case "stdin-abort":
        stdinQueue = stdinQueue.then(() => stdin.abort()).catch(() => {});
        return;
      case "control": {
        const { id } = message;
        control(message).then(
          () => post({ type: "control-reply", id, error: null }),
          (error: unknown) => post({ type: "control-reply", id, error: processError(error) }),
        );
        return;
      }
    }
  });
  port.start();
  post({ type: "stdin-credit", bytes: PROCESS_STREAM_CREDIT });
  for (const [name, pump] of pumps) void forward(name, pump, post);
  handle.exit.then(
    exit => post({ type: "exit", exit: encodeExit(exit) }),
    (error: unknown) => post({ type: "exit-error", error: processError(error) }),
  );
}

/** Waits until the page granted credit; false once the page cancelled the stream. */
async function credited(pump: StreamPump): Promise<boolean> {
  while (pump.credit <= 0 && !pump.cancelled) {
    pump.wake = Promise.withResolvers<undefined>();
    await pump.wake.promise;
  }
  return !pump.cancelled;
}

async function forward(name: ProcessStreamName, pump: StreamPump, post: (message: Readonly<Record<string, unknown>>, transfer?: readonly Transferable[]) => void): Promise<void> {
  try {
    for (;;) {
      if (!await credited(pump)) return;
      const next = await pump.reader.read();
      if (next.done) { post({ type: "end", stream: name }); return; }
      // Send no chunk larger than the window left or than one message may carry.
      for (let offset = 0; offset < next.value.byteLength;) {
        if (!await credited(pump)) return;
        const size = Math.min(pump.credit, MAX_PROCESS_CHUNK, next.value.byteLength - offset);
        const piece = next.value.slice(offset, offset + size);
        offset += size;
        pump.credit -= size;
        post({ type: "data", stream: name, bytes: piece }, [piece.buffer]);
      }
    }
  } catch (error: unknown) {
    if (!pump.cancelled) post({ type: "error", stream: name, error: processError(error) });
  }
}

function notTerminal(): VMError {
  return new VMError("INVALID_ARGUMENT", "only a terminal process can be resized or interrupted");
}
