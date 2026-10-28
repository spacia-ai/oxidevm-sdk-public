import type { UserspaceHostRequest } from "../userspace-abi.js";

interface Ports {
  take(mask: 1 | 2 | 4 | 8): UserspaceHostRequest | undefined;
  service(request: UserspaceHostRequest, signal: AbortSignal): Promise<void>;
  active(): boolean;
  settled(): void;
  failed(error: unknown): void;
}

/** Independently bounded host operations; an indefinite network receive cannot
 * occupy rootfs or durability slots. The runtime lifecycle owns admission. */
export class UserspaceHostService {
  readonly #ports: Ports;
  readonly #requests = new Map<string, { kind: UserspaceHostRequest["kind"]; controller: AbortController; completion: Promise<void> }>();
  constructor(ports: Ports) { this.#ports = ports; }

  pump(): void {
    if (!this.#ports.active()) return;
    for (const [kind, mask, limit] of [["storage", 1, 4], ["network", 2, 128], ["durability", 4, 128], ["command", 8, 4]] as const) {
      let count = [...this.#requests.values()].filter(request => request.kind === kind).length;
      while (count < limit) {
        const request = this.#ports.take(mask); if (request === undefined) break;
        const key = `${request.kind}:${request.generation.toString()}:${request.id.toString()}`;
        const controller = new AbortController(); count++;
        const finish = () => {
          this.#requests.delete(key);
          if (this.#ports.active()) { this.#ports.settled(); this.pump(); }
        };
        const completion = this.#ports.service(request, controller.signal).then(finish, (error: unknown) => {
          this.#ports.failed(error); finish();
        });
        this.#requests.set(key, { kind, controller, completion });
      }
    }
  }

  async drainDurability(): Promise<void> {
    await Promise.allSettled([...this.#requests.values()].filter(request => request.kind === "durability").map(request => request.completion));
  }
  async drainStorage(): Promise<boolean> {
    this.pump();
    const pending = [...this.#requests.values()].filter(request => request.kind === "storage");
    await Promise.allSettled(pending.map(request => request.completion));
    return pending.length !== 0;
  }
  cancelNetwork(): void {
    for (const [key, request] of this.#requests) if (request.kind === "network") {
      request.controller.abort(); this.#requests.delete(key);
    }
  }
  cancel(): void {
    for (const request of this.#requests.values()) request.controller.abort();
    this.#requests.clear();
  }
}
