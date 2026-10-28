import { VMError } from "../../errors.js";
import type { AssistanceSocketOperation } from "../../protocol/assistance.js";
import type { AssistanceReply } from "../../protocol/assistance-reply.js";
import { PreviewRuntimeServer, type PreviewRuntimeCompletion, type PreviewRuntimeErrorCode, type PreviewRuntimeOperation } from "../preview-runtime-channel.js";

const ECONNREFUSED = 111;
const READ_LIMIT = 65_536;

/** The narrow authority the preview bridge needs from the assistance owner:
 * one guest socket operation inside a named, running task. `undefined` means
 * that task is unknown or no longer running. */
export interface PreviewSockets {
  previewSocket(process: number, operation: AssistanceSocketOperation): Promise<AssistanceReply["result"] | undefined>;
}

/** Control-side preview servicer: browser requests become Linux loopback
 * connections made by the listener's own assisted task, so browser and guest
 * clients traverse the same accept queue. It never throws to its port; every
 * failure is a typed completion the proxy reports in its 502 phase. */
export class PreviewRuntimeServicer {
  readonly #port: MessagePort;
  readonly #sockets: PreviewSockets;
  #closed = false;
  readonly #server: PreviewRuntimeServer;

  constructor(port: MessagePort, sockets: PreviewSockets, readonly generation: bigint) {
    this.#port = port; this.#sockets = sockets;
    this.#server = new PreviewRuntimeServer(port, (operation, signal) => this.#complete(operation, signal));
    port.onmessage = (event: MessageEvent<unknown>) => {
      try { this.#server.receive(event.data); } catch { this.close(); }
    };
    port.onmessageerror = () => { this.close(); };
    port.start();
  }

  async #complete(operation: PreviewRuntimeOperation, signal: AbortSignal): Promise<PreviewRuntimeCompletion> {
    if (operation.kind !== "open" && operation.generation !== this.generation) return { kind: "error", code: "process" };
    const interrupt = (): void => {
      if (operation.kind === "open" || operation.kind === "close") return;
      void this.#sockets.previewSocket(operation.process, { kind: "socket-shutdown", fd: operation.connection, direction: "both" }).catch(() => undefined);
    };
    signal.addEventListener("abort", interrupt, { once: true });
    try {
      switch (operation.kind) {
        case "open": {
          if (operation.process === null) return { kind: "error", code: "listener" };
          const result = await this.#sockets.previewSocket(operation.process, { kind: "socket-connect-local", address: { address: "127.0.0.1", port: operation.port } });
          if (result === undefined) return { kind: "error", code: "process" };
          if (result.kind === "socket") {
            if (signal.aborted) {
              await this.#sockets.previewSocket(operation.process, { kind: "socket-close", fd: result.fd });
              return { kind: "error", code: "channel" };
            }
            return { kind: "opened", generation: this.generation, process: operation.process, connection: result.fd };
          }
          if (result.kind === "error" && result.errno === ECONNREFUSED) return { kind: "error", code: "listener" };
          return { kind: "error", code: "listener" };
        }
        case "write": {
          const result = await this.#sockets.previewSocket(operation.process, { kind: "socket-write", fd: operation.connection, bytes: owned(operation.bytes) });
          if (result === undefined) return { kind: "error", code: "process" };
          return result.kind === "written" ? { kind: "written", bytes: result.count } : { kind: "error", code: "write" };
        }
        case "read": {
          const result = await this.#sockets.previewSocket(operation.process, { kind: "socket-read", fd: operation.connection, length: Math.min(operation.maxBytes, READ_LIMIT) });
          if (result === undefined) return { kind: "error", code: "process" };
          if (result.kind !== "data") return { kind: "error", code: "read" };
          return result.bytes.byteLength === 0 ? { kind: "eof" } : { kind: "read", bytes: result.bytes };
        }
        case "close": {
          const result = await this.#sockets.previewSocket(operation.process, { kind: "socket-close", fd: operation.connection });
          if (result === undefined) return { kind: "error", code: "process" };
          return result.kind === "unit" ? { kind: "closed" } : { kind: "error", code: "close" };
        }
        // Full-system reads and writes already wait inside Linux; they never
        // return blocked and do not need a separate readiness request.
        case "wait": return { kind: "error", code: operation.interest };
      }
    } catch (error) {
      // A retired task or a lost transport is a preview failure, never an owner failure.
      if (error instanceof VMError) return { kind: "error", code: operationCode(operation) };
      throw error;
    } finally { signal.removeEventListener("abort", interrupt); }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#server.close();
    this.#port.onmessage = null; this.#port.onmessageerror = null;
    this.#port.close();
  }
}

function operationCode(operation: PreviewRuntimeOperation): PreviewRuntimeErrorCode {
  switch (operation.kind) {
    case "open": return "listener";
    case "write": return "write";
    case "read": return "read";
    case "close": return "close";
    case "wait": return operation.interest;
  }
}

function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? new Uint8Array(bytes.buffer) : new Uint8Array(bytes);
}
