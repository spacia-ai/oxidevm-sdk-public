import { deserializeError, VMError } from "./errors.js";
import { type ControlOperations, decodeSnapshotEventMessage } from "./protocol.js";
import type { SnapshotEvent } from "./snapshot-types.js";
import type { WorkerClient } from "./worker-client.js";

type SnapshotListener = (event: SnapshotEvent) => void;

/**
 * The page side of a VM's restore point events: one port the control worker sends them through,
 * opened for the first listener and shared by every listener after it. Each listener is called in
 * its own microtask, so one that throws cannot keep the others from an event. A malformed event
 * stops the VM, as a malformed worker response does.
 */
export class SnapshotObserver {
  readonly #control: WorkerClient<ControlOperations>;
  readonly #listeners = new Set<SnapshotListener>();
  #port: MessagePort | undefined;
  #opened: Promise<void> | undefined;

  constructor(control: WorkerClient<ControlOperations>) {
    this.#control = control;
    control.lifetime.addEventListener("abort", () => { this.#close(); }, { once: true });
  }

  /**
   * Calls `listener` with each event until `signal` aborts. Resolves once the control worker
   * sends events to this page; throws at once when the VM has stopped.
   */
  listen(listener: SnapshotListener, signal: AbortSignal): Promise<void> {
    const lifetime = this.#control.lifetime;
    if (lifetime.aborted) {
      const reason: unknown = lifetime.reason;
      throw reason instanceof VMError ? reason : new VMError("ABORTED", "the VM has stopped");
    }
    if (signal.aborted) return Promise.resolve();
    this.#listeners.add(listener);
    signal.addEventListener("abort", () => { this.#listeners.delete(listener); }, { once: true });
    this.#opened ??= this.#open();
    return this.#opened;
  }

  async #open(): Promise<void> {
    const { port1, port2 } = new MessageChannel();
    port1.addEventListener("message", (event: MessageEvent<unknown>) => { this.#deliver(event.data); });
    port1.addEventListener("messageerror", () => {
      this.#control.terminate(new VMError("PROTOCOL_ERROR", "a restore point event could not be read"));
    });
    port1.start();
    this.#port = port1;
    try {
      await this.#control.request("snapshot-events", { port: port2 }, { transfer: [port2] });
    } catch (error) {
      // A later listener tries again; a stopped VM refuses it first.
      port1.close();
      this.#port = undefined;
      this.#opened = undefined;
      throw error;
    }
  }

  #deliver(data: unknown): void {
    let event: SnapshotEvent;
    try {
      const record = decodeSnapshotEventMessage(data);
      event = (record.type === "save-failed" || record.type === "image-preparation-failed") ? { ...record, error: deserializeError(record.error) } : record;
    } catch (error) {
      this.#control.terminate(
        error instanceof VMError ? error : new VMError("PROTOCOL_ERROR", "a restore point event is malformed"),
      );
      return;
    }
    for (const listener of this.#listeners) {
      queueMicrotask(() => {
        if (this.#listeners.has(listener)) listener(event);
      });
    }
  }

  #close(): void {
    this.#port?.close();
    this.#port = undefined;
    this.#listeners.clear();
  }
}
