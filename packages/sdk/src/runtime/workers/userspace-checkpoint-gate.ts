import { VMError } from "../errors.js";

/** Native capture can hold callbacks across storage awaits without moving Linux policy to JS. */
export class UserspaceCheckpointGate {
  #state: "open" | "draining" | "quiescing" | "frozen" | "closed" = "open";
  #active = 0;
  #released: PromiseWithResolvers<undefined> | undefined;
  #idle: PromiseWithResolvers<undefined> | undefined;

  get open(): boolean { return this.#state === "open"; }
  get executionAllowed(): boolean { return this.#state === "open" || this.#state === "draining"; }
  get closed(): boolean { return this.#state === "closed"; }

  async operation<T>(run: () => Promise<T>): Promise<T> {
    while (!this.open) await this.wait();
    this.#active++;
    try { return await run(); }
    finally {
      this.#active--;
      if (this.#active === 0) { this.#idle?.resolve(undefined); this.#idle = undefined; }
    }
  }

  async wait(): Promise<void> {
    while (this.#state !== "open") {
      if (this.#state === "closed") throw new VMError("ABORTED", "Native runtime was retired");
      const waiting = this.#released ??= Promise.withResolvers<undefined>();
      await waiting.promise;
    }
  }

  async deliver(run: () => void): Promise<void> {
    while (this.#state === "frozen") await this.wait();
    if (this.#state !== "closed") run();
  }

  async freeze(flush: () => Promise<void>): Promise<void> {
    if (this.#state !== "open") throw new VMError("PROTOCOL_ERROR", "Native checkpoint freeze is already active");
    this.#state = "draining";
    try {
      if (this.#active !== 0) { this.#idle ??= Promise.withResolvers<undefined>(); await this.#idle.promise; }
      this.#requireLive();
      this.#state = "quiescing";
      await flush();
      this.#requireLive();
      this.#state = "frozen";
    } catch (error) { this.resume(); throw error; }
  }

  #requireLive():void {
    if(this.closed)throw new VMError("ABORTED", "Native runtime was retired during capture");
  }

  resume(): void {
    if (this.#state !== "closed") this.#state = "open";
    this.#released?.resolve(undefined); this.#released = undefined;
  }
  close(): void { this.#state = "closed"; this.resume(); }
}
