import { VMError } from "../errors.js";
import { ASSISTANCE_LIMITS, type AssistanceSocketAddress } from "../protocol/assistance.js";
import type { GrantedTraffic } from "./assistance/traffic.js";

const MAX_WAITERS = 64;

interface Waiter { readonly port: number; readonly resolve: (process: number) => void; readonly reject: (error: VMError) => void; readonly detach: () => void }

/** Network-owned logical listeners. Linux has already bound each address; this
 * owner never predicts bind collisions or keeps a second socket implementation. */
export class SystemListeners {
  readonly #traffic: GrantedTraffic;
  readonly #tasks = new Map<number, Map<number, AssistanceSocketAddress>>();
  readonly #reservation: number;
  readonly #waiters = new Set<Waiter>();
  readonly #closedListeners = new Set<(process: number) => void>();
  #lastProcess = 0;

  constructor(traffic: GrantedTraffic) {
    this.#traffic = traffic;
    // Existing network window: at most four tasks and 128 logical listeners
    // across the VM, including bounded addresses and ownership metadata.
    this.#reservation = traffic.reserve("data", 64 * 1024);
  }

  openTask(process: number): void {
    if (process <= this.#lastProcess || this.#tasks.size >= ASSISTANCE_LIMITS.processes) {
      throw new VMError("PROTOCOL_ERROR", "Stale or excessive network task admission");
    }
    this.#tasks.set(process, new Map());
    this.#lastProcess = process;
  }

  closeTask(process: number): void {
    this.#task(process);
    this.#tasks.delete(process);
    for (const listener of this.#closedListeners) listener(process);
  }

  /** The task whose listener a loopback connection to `port` reaches: one bound
   * to the port on an unspecified or loopback address. Linux already accepted
   * the bind; this only chooses the task that issues the connect. */
  resolve(port: number): number | undefined {
    for (const [process, listeners] of this.#tasks) {
      for (const address of listeners.values()) {
        if (address.port === port && reachableOnLoopback(address.address)) return process;
      }
    }
    return undefined;
  }

  /** Resolve `port` now or when a matching listener opens. Cancellation and
   * generation retirement reject; the waiter set is bounded. */
  waitFor(port: number, signal: AbortSignal): Promise<number> {
    const process = this.resolve(port);
    if (process !== undefined) return Promise.resolve(process);
    if (signal.aborted) return Promise.reject(new VMError("ABORTED", "Preview listener wait cancelled"));
    if (this.#waiters.size >= MAX_WAITERS) return Promise.reject(new VMError("QUOTA_EXCEEDED", "Preview listener wait capacity exhausted"));
    return new Promise<number>((resolve, reject) => {
      const waiter: Waiter = { port, resolve, reject, detach: () => { signal.removeEventListener("abort", abort); this.#waiters.delete(waiter); } };
      const abort = () => { waiter.detach(); reject(new VMError("ABORTED", "Preview listener wait cancelled")); };
      signal.addEventListener("abort", abort, { once: true });
      this.#waiters.add(waiter);
    });
  }

  /** Preview owners end the proxied connections of a task that retired. */
  onTaskClosed(listener: (process: number) => void): () => void {
    this.#closedListeners.add(listener);
    return () => { this.#closedListeners.delete(listener); };
  }

  open(process: number, fd: number, address: AssistanceSocketAddress): void {
    const task = this.#task(process);
    if (task.has(fd)) throw new VMError("PROTOCOL_ERROR", "Duplicate network listener");
    const count = [...this.#tasks.values()].reduce((sum, listeners) => sum + listeners.size, 0);
    if (count >= ASSISTANCE_LIMITS.descriptors) throw new VMError("QUOTA_EXCEEDED", "Network listener capacity exhausted");
    task.set(fd, address);
    if (!reachableOnLoopback(address.address)) return;
    for (const waiter of [...this.#waiters]) {
      if (waiter.port === address.port) { waiter.detach(); waiter.resolve(process); }
    }
  }

  close(process: number, fd: number): void {
    // Accepted/connected stream descriptors do not own a logical listener.
    this.#task(process).delete(fd);
  }

  retire(): void {
    // Generation loss removes routing authority even when individual task
    // receipts were lost. Native descendants remain the control owner's duty.
    this.#traffic.release(this.#reservation);
    this.#tasks.clear();
    for (const waiter of [...this.#waiters]) { waiter.detach(); waiter.reject(new VMError("ABORTED", "Network generation retired")); }
    this.#closedListeners.clear();
  }

  assertIdle(): void {
    if (this.#tasks.size !== 0) throw new VMError("PROTOCOL_ERROR", "Network tasks have not retired");
  }

  #task(process: number) {
    const task = this.#tasks.get(process);
    if (task === undefined) throw new VMError("PROTOCOL_ERROR", "Unknown or retired network task");
    return task;
  }
}

/** A guest-loopback client reaches listeners bound to loopback or to every address. */
function reachableOnLoopback(address: string): boolean {
  return address === "0.0.0.0" || address === "::" || address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
