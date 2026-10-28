import type { LinuxSignal, ProcessExit, ProcessHandle, TerminalHandle } from "../../contracts.js";
import { VMError, deserializeError } from "../../runtime/errors.js";
import { decodeProcessId } from "../../values.js";
import { MAX_PROCESS_CHUNK, PROCESS_STREAM_CREDIT, decodeProcessFrameMessage, exitFromWire } from "../protocol/process-io.js";
import type { ProcessControl, ProcessStreamName } from "../protocol/process-io.js";

// A guest process in the runtime frame, as the page sees it: streams fed by the process port with
// credit returned as the page's reader consumes, stdin sent against the frame's credit, and kill,
// resize and interrupt as calls with one reply each.

interface Stream {
  readonly readable: ReadableStream<Uint8Array>;
  /** Settles when the stream ended, failed or was cancelled. */
  readonly done: Promise<void>;
  deliver(bytes: Uint8Array): void;
  end(): void;
  fail(error: Error): void;
}

export function frameProcess(port: MessagePort, pid: number, kind: "process",snapshotKey?:string): ProcessHandle;
export function frameProcess(port: MessagePort, pid: number, kind: "terminal",snapshotKey?:string): TerminalHandle;
export function frameProcess(port: MessagePort, pid: number, kind: "process" | "terminal",snapshotKey?:string): ProcessHandle | TerminalHandle;
export function frameProcess(port: MessagePort, pid: number, kind: "process" | "terminal",snapshotKey?:string): ProcessHandle | TerminalHandle {
  const post = (message: Readonly<Record<string, unknown>>, transfer: readonly Transferable[] = []) => {
    try { port.postMessage(message, [...transfer]); } catch (error: unknown) { broken(error); }
  };
  const streams = new Map<ProcessStreamName, Stream>(
    (kind === "terminal" ? ["output"] as const : ["stdout", "stderr"] as const).map(name => [name, outputStream(name, post)]),
  );
  const exit = Promise.withResolvers<ProcessExit>();
  const controls = new Map<number, PromiseWithResolvers<undefined>>();
  let nextControl = 1;
  let stdinCredit = 0;
  let stdinWaiter: PromiseWithResolvers<undefined> | undefined;
  let failure: Error | undefined;
  let finished = false;

  const broken = (error: unknown) => {
    if (failure !== undefined) return;
    failure = error instanceof VMError ? error : new VMError("PROTOCOL_ERROR", "the runtime frame lost the process", { cause: error instanceof Error ? error.message : String(error) });
    for (const stream of streams.values()) stream.fail(failure);
    for (const control of controls.values()) control.reject(failure);
    controls.clear();
    stdinWaiter?.reject(failure);
    exit.reject(failure);
    port.close();
  };

  port.addEventListener("message", (event: MessageEvent) => {
    let message;
    try { message = decodeProcessFrameMessage(event.data); } catch (error: unknown) { broken(error); return; }
    switch (message.type) {
      case "data": streams.get(message.stream)?.deliver(message.bytes); break;
      case "end": streams.get(message.stream)?.end(); break;
      case "error": streams.get(message.stream)?.fail(deserializeError(message.error)); break;
      case "stdin-credit": stdinCredit += message.bytes; stdinWaiter?.resolve(undefined); stdinWaiter = undefined; break;
      case "stdin-error": stdinWaiter?.reject(deserializeError(message.error)); stdinWaiter = undefined; failure ??= deserializeError(message.error); break;
      case "control-reply": {
        const control = controls.get(message.id);
        controls.delete(message.id);
        if (message.error === null) control?.resolve(undefined); else control?.reject(deserializeError(message.error));
        break;
      }
      case "exit": exit.resolve(exitFromWire(message.exit)); break;
      case "exit-error": exit.reject(deserializeError(message.error)); break;
    }
  });
  port.addEventListener("messageerror", () => broken(new VMError("PROTOCOL_ERROR", "a process message could not be read")));
  port.start();
  // Once the process exited and every output stream finished, the port has nothing left to carry.
  void Promise.allSettled([exit.promise, ...[...streams.values()].map(stream => stream.done)]).then(() => {
    if (failure !== undefined || controls.size > 0) return;
    finished = true;
    port.close();
  });
  // A caller that never awaits exit must not see an unhandled rejection; awaiting still rejects.
  void exit.promise.catch(() => {});

  const control = (call: ProcessControl): Promise<void> => {
    // After the process exited and its output ended, there is nothing left to signal or resize.
    if (finished) return Promise.resolve();
    if (failure !== undefined) return Promise.reject(failure);
    const id = nextControl++;
    const pending = Promise.withResolvers<undefined>();
    controls.set(id, pending);
    post({ type: "control", id, ...call });
    return pending.promise.then(() => undefined);
  };

  const stdin = new WritableStream<Uint8Array>({
    write: async chunk => {
      if (!(chunk instanceof Uint8Array)) throw new VMError("INVALID_ARGUMENT", "stdin accepts bytes");
      for (let offset = 0; offset < chunk.byteLength; offset += MAX_PROCESS_CHUNK) {
        while (stdinCredit <= 0) {
          if (failure !== undefined) throw failure;
          stdinWaiter ??= Promise.withResolvers<undefined>();
          await stdinWaiter.promise;
        }
        if (failure !== undefined) throw failure;
        const piece = chunk.slice(offset, offset + MAX_PROCESS_CHUNK);
        stdinCredit -= piece.byteLength;
        post({ type: "stdin", bytes: piece }, [piece.buffer]);
      }
    },
    close: () => { post({ type: "stdin-close" }); },
    abort: () => { post({ type: "stdin-abort" }); },
  });

  const common = {
    ...(snapshotKey===undefined?{}:{snapshotKey}),
    pid: decodeProcessId(pid),
    stdin,
    exit: exit.promise,
    kill: (signal: LinuxSignal = "SIGTERM", options?: { readonly scope?: "process" | "process-group" }) => control({ op: "kill", signal, scope: options?.scope ?? "process" }),
  };
  const read = (name: ProcessStreamName) => {
    const stream = streams.get(name);
    if (stream === undefined) throw new VMError("PROTOCOL_ERROR", `process has no ${name} stream`);
    return stream.readable;
  };
  if (kind === "process") return { ...common, kind: "process", stdout: read("stdout"), stderr: read("stderr") };
  return {
    ...common, kind: "terminal", output: read("output"),
    resize: size => control({ op: "resize", columns: size.columns, rows: size.rows }),
    interrupt: () => control({ op: "interrupt" }),
  };
}

/**
 * Output with credit: the page grants a window up front, then returns each chunk's bytes once the
 * reader has taken it out of the queue (pull runs when the queue drops below the window).
 */
function outputStream(name: ProcessStreamName, post: (message: Readonly<Record<string, unknown>>) => void): Stream {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let consumed = 0;
  let open = true;
  const done = Promise.withResolvers<undefined>();
  const stop = () => { open = false; done.resolve(undefined); };
  const readable = new ReadableStream<Uint8Array>({
    start: started => { controller = started; post({ type: "credit", stream: name, bytes: PROCESS_STREAM_CREDIT }); },
    pull: started => {
      const queued = PROCESS_STREAM_CREDIT - (started.desiredSize ?? 0);
      const returned = consumed - Math.max(queued, 0);
      if (returned > 0) { consumed -= returned; post({ type: "credit", stream: name, bytes: returned }); }
    },
    cancel: () => { stop(); post({ type: "cancel", stream: name }); },
  }, { highWaterMark: PROCESS_STREAM_CREDIT, size: chunk => chunk.byteLength });
  return {
    readable,
    done: done.promise.then(() => undefined),
    deliver: bytes => { if (open) { consumed += bytes.byteLength; controller?.enqueue(bytes); } },
    end: () => { if (open) { stop(); controller?.close(); } },
    fail: error => { if (open) { stop(); controller?.error(error); } },
  };
}
