import { boolean, exactKeys, integer, record } from "./decode.js";
import {
  VMError,
  decodeSerializedError,
  deserializeError,
} from "./errors.js";
import { attentionAttachment, postCounted, type AttentionCounter } from "./host-attention.js";
import {
  type OperationDecoders,
  type OperationRequest,
  type OperationResponse,
  PROTOCOL_VERSION,
} from "./protocol.js";

interface WorkerTransport {
  postMessage(message: unknown, transfer: readonly Transferable[]): void;
  terminate(): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: Event) => void): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: Event) => void): void;
}

interface PendingRequest {
  decode(value: unknown): unknown;
  resolve(value: unknown): void;
  reject(reason: Error): void;
  cleanup(): void;
}

type OperationName<Operations> = Extract<keyof Operations, string>;

export class WorkerClient<Operations> {
  readonly #worker: WorkerTransport;
  readonly #decoders: OperationDecoders<Operations>;
  readonly #cancellation: "immediate" | "settled";
  readonly #attention: AttentionCounter | null;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #canceled = new Set<number>();
  readonly #lifetime = new AbortController();
  #nextId = 1;
  #disposed = false;
  #failure: VMError | undefined;

  /** With `attention`, the client's first message attaches it and every later post is counted on it,
   * so an execution worker ends its guest slice early to receive the client's requests. */
  constructor(
    worker: WorkerTransport,
    decoders: OperationDecoders<Operations>,
    cancellation: "immediate" | "settled" = "immediate",
    attention: AttentionCounter | null = null,
  ) {
    this.#worker = worker;
    this.#decoders = decoders;
    this.#cancellation = cancellation;
    this.#attention = attention;
    worker.addEventListener("message", this.#onMessage);
    worker.addEventListener("error", this.#onWorkerError);
    worker.addEventListener("messageerror", this.#onWorkerError);
    if (attention !== null) worker.postMessage(attentionAttachment(attention), []);
  }

  #post(message: unknown, transfer: readonly Transferable[]): void {
    postCounted(this.#attention, () => { this.#worker.postMessage(message, transfer); });
  }

  get lifetime(): AbortSignal { return this.#lifetime.signal; }

  request<Name extends OperationName<Operations>>(
    operation: Name,
    payload: OperationRequest<Operations, Name>,
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly transfer?: readonly Transferable[] | undefined;
      /** Lifecycle publication must wait for the owner to establish its outcome. */
      readonly cancellation?: "immediate" | "settled";
    } = {},
  ): Promise<OperationResponse<Operations, Name>> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    if (this.#disposed) {
      return Promise.reject(
        new VMError("PROTOCOL_ERROR", "worker client has been disposed"),
      );
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new VMError("ABORTED", "operation was aborted"));
    }

    const id = this.#nextId++;
    const decoder = this.#decoders[operation];
    return new Promise<OperationResponse<Operations, Name>>((resolve, reject) => {
      const abort = () => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        pending.cleanup();
        try {
          this.#post({ version: PROTOCOL_VERSION, type: "cancel", requestId: id }, []);
        } catch (error) { this.#fail(protocolFailure(error)); return; }
        // A storage operation may already have committed. Only its owner can
        // establish the outcome and confirm producer retirement.
        if ((options.cancellation ?? this.#cancellation) === "settled") return;
        this.#pending.delete(id);
        this.#canceled.add(id);
        reject(new VMError("ABORTED", "operation was aborted"));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      const pending: PendingRequest = {
        decode: decoder,
        resolve: (value) => {
          try {
            resolve(decoder(value));
          } catch (error) {
            reject(protocolFailure(error));
          }
        },
        reject,
        cleanup: () => options.signal?.removeEventListener("abort", abort),
      };
      this.#pending.set(id, pending);

      const message: Record<string, unknown> = {
        id,
        version: PROTOCOL_VERSION,
        type: operation,
      };
      if (payload !== undefined) {
        if (
          typeof payload !== "object" ||
          payload === null ||
          Array.isArray(payload)
        ) {
          this.#pending.delete(id);
          pending.cleanup();
          reject(
            new VMError(
              "PROTOCOL_ERROR",
              `payload for ${operation} must be an object`,
            ),
          );
          return;
        }
        Object.assign(message, payload);
      }
      try {
        this.#post(message, options.transfer ?? []);
      } catch (error) {
        this.#pending.delete(id);
        pending.cleanup();
        reject(protocolFailure(error));
      }
    });
  }

  terminate(reason?: VMError): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#failure = reason;
    this.#detach();
    this.#worker.terminate();
    const error = reason ?? new VMError("ABORTED", "worker was disposed");
    this.#lifetime.abort(error);
    this.#rejectAll(error);
    this.#canceled.clear();
  }

  readonly #onMessage = (event: Event) => {
    if (!(event instanceof MessageEvent)) {
      this.#fail(new VMError("PROTOCOL_ERROR", "worker message event is invalid"));
      return;
    }
    let response: ReturnType<typeof decodeResponse>;
    try {
      response = decodeResponse(event.data);
    } catch (error) {
      this.#fail(protocolFailure(error));
      return;
    }

    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      if (this.#canceled.delete(response.id)) return;
      this.#fail(
        new VMError(
          "PROTOCOL_ERROR",
          `worker returned unknown or duplicate response ${response.id}`,
        ),
      );
      return;
    }
    this.#pending.delete(response.id);
    pending.cleanup();

    if (response.ok) {
      pending.resolve(response.value);
      return;
    }
    try {
      pending.reject(deserializeError(decodeSerializedError(response.error)));
    } catch (error) {
      const failure = protocolFailure(error);
      pending.reject(failure);
      this.#fail(failure);
    }
  };

  readonly #onWorkerError = (event: Event) => {
    this.#fail(
      new VMError(
        "PROTOCOL_ERROR",
        workerErrorMessage(event),
      ),
    );
  };

  #fail(error: VMError): void {
    if (this.#failure !== undefined) return;
    this.#failure = error;
    this.#disposed = true;
    this.#lifetime.abort(error);
    this.#detach();
    this.#worker.terminate();
    this.#rejectAll(error);
    this.#canceled.clear();
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #detach(): void {
    this.#worker.removeEventListener("message", this.#onMessage);
    this.#worker.removeEventListener("error", this.#onWorkerError);
    this.#worker.removeEventListener("messageerror", this.#onWorkerError);
  }
}

export function workerClientForPort<Operations>(
  port: MessagePort,
  decoders: OperationDecoders<Operations>,
  cancellation: "immediate" | "settled" = "immediate",
): WorkerClient<Operations> {
  return new WorkerClient(new MessagePortTransport(port), decoders, cancellation);
}

class MessagePortTransport implements WorkerTransport {
  readonly #port: MessagePort;

  constructor(port: MessagePort) {
    this.#port = port;
    port.start();
  }

  postMessage(message: unknown, transfer: readonly Transferable[]): void {
    this.#port.postMessage(message, Array.from(transfer));
  }

  terminate(): void {
    this.#port.close();
  }

  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (event: Event) => void,
  ): void {
    if (type !== "error") this.#port.addEventListener(type, listener);
  }

  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener: (event: Event) => void,
  ): void {
    if (type !== "error") this.#port.removeEventListener(type, listener);
  }
}

function workerErrorMessage(event: Event): string {
  if ("message" in event && typeof event.message === "string" && event.message.length !== 0) {
    return event.message;
  }
  return `worker ${event.type} event`;
}

function decodeResponse(value: unknown):
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: unknown } {
  const response = record(value, "worker response");
  const ok = boolean(response["ok"], "response ok");
  if (ok) {
    exactKeys(response, ["id", "version", "ok", "value"]);
  } else {
    exactKeys(response, ["id", "version", "ok", "error"]);
  }
  const version = integer(
    response["version"],
    "protocol version",
    PROTOCOL_VERSION,
    PROTOCOL_VERSION,
  );
  if (version !== PROTOCOL_VERSION) {
    throw new VMError("PROTOCOL_ERROR", "worker protocol version mismatch");
  }
  const id = integer(response["id"], "response id", 1);
  return ok
    ? { id, ok, value: response["value"] }
    : { id, ok, error: response["error"] };
}

function protocolFailure(error: unknown): VMError {
  return error instanceof VMError
    ? error
    : new VMError(
        "PROTOCOL_ERROR",
        error instanceof Error ? error.message : String(error),
      );
}
