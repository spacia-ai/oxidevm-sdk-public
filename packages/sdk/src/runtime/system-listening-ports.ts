// The page side of a full-system VM's listening ports (ADR 0015, capability 64): one port the
// control worker sends lists through, opened for the first watcher, shared by every watcher after
// it and closed after the last one stops. Each watcher hears a list only when it changes.
//
// Control holds one page port, and an unwatch ends whichever port it holds, so the watch and
// unwatch requests go out one after another: an unwatch never reaches control after the watch
// that followed it. A watcher that stops while another starts in the same turn (an effect that
// runs again, as the panel's Try again does) keeps the port.
import { deserializeError, VMError } from "./errors.js";
import { samePorts } from "./listening-ports.js";
import type { ControlOperations } from "./protocol.js";
import { decodeListeningPortsMessage } from "./protocol/listening-ports.js";
import type { ListeningPort } from "./vm-types.js";
import type { WorkerClient } from "./worker-client.js";

interface Watcher {
  readonly onChange: (ports: readonly ListeningPort[]) => void;
  readonly settle: (error?: VMError) => void;
  last: readonly ListeningPort[] | undefined;
}

export class SystemListeningPorts {
  readonly #control: WorkerClient<ControlOperations>;
  readonly #watchers = new Set<Watcher>();
  #port: MessagePort | undefined;
  #latest: readonly ListeningPort[] | undefined;
  /** The last watch or unwatch request; the next one waits for it. */
  #requests: Promise<unknown> = Promise.resolve();
  /** A release waiting a turn for a watcher that may still arrive. */
  #release: ReturnType<typeof setTimeout> | undefined;

  constructor(control: WorkerClient<ControlOperations>) {
    this.#control = control;
    control.lifetime.addEventListener("abort", () => { this.#fail(this.#stopped()); }, { once: true });
  }

  list(signal?: AbortSignal): Promise<readonly ListeningPort[]> {
    return this.#control.request("agent-listeners-list", undefined, signal === undefined ? {} : { signal });
  }

  /** Calls `onChange` with the first list, then whenever it changes; resolves when `signal` aborts. */
  watch(onChange: (ports: readonly ListeningPort[]) => void, signal: AbortSignal): Promise<void> {
    if (this.#control.lifetime.aborted) return Promise.reject(this.#stopped());
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const watcher: Watcher = {
        onChange,
        settle: (error) => {
          if (!this.#watchers.delete(watcher)) return;
          if (error === undefined) resolve();
          else reject(error);
        },
        last: undefined,
      };
      this.#watchers.add(watcher);
      clearTimeout(this.#release);
      this.#release = undefined;
      signal.addEventListener("abort", () => {
        watcher.settle();
        this.#releaseWhenUnwatched();
      }, { once: true });
      const latest = this.#latest;
      if (latest !== undefined) this.#tell(watcher, latest);
      if (this.#port === undefined) this.#open();
    });
  }

  #open(): void {
    const { port1, port2 } = new MessageChannel();
    port1.addEventListener("message", (event: MessageEvent<unknown>) => { this.#deliver(event.data); });
    port1.addEventListener("messageerror", () => {
      this.#control.terminate(new VMError("PROTOCOL_ERROR", "a listening-port list could not be read"));
    });
    port1.start();
    this.#port = port1;
    this.#send(() => this.#control.request("agent-listeners-watch", { port: port2 }, { transfer: [port2] })).catch((error: unknown) => {
      if (this.#port === port1) this.#fail(error instanceof VMError ? error : new VMError("PROTOCOL_ERROR", "watching listening ports failed"));
    });
  }

  /** Sends `request` once the previous watch or unwatch request has settled. */
  #send(request: () => Promise<unknown>): Promise<unknown> {
    const sent = this.#requests.then(request);
    this.#requests = sent.catch(() => undefined);
    return sent;
  }

  #deliver(data: unknown): void {
    let message: ReturnType<typeof decodeListeningPortsMessage>;
    try {
      message = decodeListeningPortsMessage(data);
    } catch (error) {
      this.#control.terminate(error instanceof VMError ? error : new VMError("PROTOCOL_ERROR", "a listening-port list is malformed"));
      return;
    }
    if (message.type === "failed") {
      this.#fail(deserializeError(message.error));
      return;
    }
    this.#latest = message.ports;
    for (const watcher of this.#watchers) this.#tell(watcher, message.ports);
  }

  /** Calls the watcher in its own microtask when `ports` differ from what it last heard. */
  #tell(watcher: Watcher, ports: readonly ListeningPort[]): void {
    if (watcher.last !== undefined && samePorts(watcher.last, ports)) return;
    watcher.last = ports;
    queueMicrotask(() => {
      if (this.#watchers.has(watcher)) watcher.onChange(ports);
    });
  }

  /** Closes the port and tells control to stop a turn after the last watcher left, unless a
   * watcher arrived meanwhile. */
  #releaseWhenUnwatched(): void {
    if (this.#watchers.size !== 0 || this.#port === undefined || this.#release !== undefined) return;
    this.#release = setTimeout(() => {
      this.#release = undefined;
      if (this.#watchers.size !== 0 || this.#port === undefined) return;
      this.#close();
      // After the watch it ends; a stopped VM needs no unwatch.
      this.#send(() => this.#control.request("agent-listeners-unwatch", undefined)).catch(() => undefined);
    }, 0);
  }

  #fail(error: VMError): void {
    this.#close();
    for (const watcher of [...this.#watchers]) watcher.settle(error);
  }

  #close(): void {
    this.#port?.close();
    this.#port = undefined;
    this.#latest = undefined;
  }

  #stopped(): VMError {
    const reason: unknown = this.#control.lifetime.reason;
    return reason instanceof VMError ? reason : new VMError("ABORTED", "the VM has stopped");
  }
}
