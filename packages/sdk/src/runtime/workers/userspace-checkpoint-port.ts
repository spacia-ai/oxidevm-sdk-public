import { decodeNativeCheckpointRequest, type NativeCheckpointRequest } from "../protocol/userspace-checkpoints.js";
import { decodeRequestId, PROTOCOL_VERSION } from "../protocol/common.js";
import { serializeUnknownError, VMError } from "../errors.js";

/** Cancellation settles the original request after its transaction determines the outcome. */
export class UserspaceCheckpointPort {
  readonly #port: MessagePort;
  readonly #pending = new Map<number, AbortController>();
  readonly #handle: (request: NativeCheckpointRequest, signal: AbortSignal) => Promise<unknown>;
  constructor(port: MessagePort, handle: (request: NativeCheckpointRequest, signal: AbortSignal) => Promise<unknown>) {
    this.#port = port; this.#handle = handle;
    port.addEventListener("message", (event: MessageEvent<unknown>) => { void this.#receive(event.data); });
    port.start();
  }
  close(): void { for (const pending of this.#pending.values()) pending.abort(); this.#port.close(); }
  async #receive(value: unknown): Promise<void> {
    let id = decodeRequestId(value);
    try {
      const request = decodeNativeCheckpointRequest(value);
      if (request.type === "cancel") { this.#pending.get(request.requestId)?.abort(); return; }
      id = request.id;
      if (this.#pending.has(id)) throw new VMError("PROTOCOL_ERROR", "Duplicate native checkpoint request");
      const controller = new AbortController(); this.#pending.set(id, controller);
      try {
        const result = await this.#handle(request, controller.signal);
        this.#port.postMessage({ version: PROTOCOL_VERSION, id, ok: true, value: result });
      } finally { this.#pending.delete(id); }
    } catch (error) {
      if (id !== undefined) this.#port.postMessage({ version: PROTOCOL_VERSION, id, ok: false, error: serializeUnknownError(error) });
    }
  }
}
