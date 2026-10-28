// The full-system preview transport over the network link (ADR 0015): a preview session's TCP
// connections to the guest are the router's connections, which reach servers bound to every
// address, to 192.0.2.2 and, on images with route_localnet, to 127.0.0.1.
import type { NetstackConnections, RouterConnection, RouterOpenResult, RouterRead } from "./netstack/connections.js";
import type { PreviewRuntimePort } from "./preview-http.js";
import type { PreviewRuntimeCompletion, PreviewRuntimeOperation, PreviewTarget } from "./preview-runtime-channel.js";

/** The minimum retry delay for a refused or busy TCP connection. */
export const ROUTER_OPEN_RETRY_MS = 25;
/** The process every router connection belongs to: the guest as a whole. */
export const ROUTER_PROCESS = 1;

export type RouterLink = Pick<NetstackConnections, "open">;

interface Entry {
  readonly generation: bigint;
  /** The link the connection was opened on; a replaced link ends it. */
  readonly link: RouterLink;
  readonly connection: RouterConnection;
  reset: boolean;
}

export class RouterPreviewRuntime implements PreviewRuntimePort {
  readonly #link: () => RouterLink | undefined;
  readonly #connections = new Map<number, Entry>();
  #generation = 0n;

  constructor(link: () => RouterLink | undefined) {
    this.#link = link;
  }

  get available(): boolean {
    return this.#link() !== undefined;
  }

  async request(operation: PreviewRuntimeOperation, signal?: AbortSignal): Promise<PreviewRuntimeCompletion> {
    switch (operation.kind) {
      case "open":
        return this.#open(operation.port, signal);
      case "write":
        return this.#write(operation, operation.bytes);
      case "read":
        return this.#read(operation, operation.maxBytes, signal);
      case "wait": {
        const entry = this.#entry(operation);
        if (entry === undefined) return { kind: "error", code: "process" };
        try { await entry.connection.wait(operation.interest, signal); return { kind: "ready" }; }
        catch { return { kind: "error", code: signal?.aborted === true ? "channel" : operation.interest }; }
      }
      case "close": {
        const entry = this.#entry(operation);
        if (entry === undefined) return { kind: "error", code: "process" };
        this.#connections.delete(operation.connection);
        entry.connection.close();
        return { kind: "closed" };
      }
    }
  }

  #write(target: PreviewTarget, bytes: Uint8Array): PreviewRuntimeCompletion {
    const entry = this.#entry(target);
    if (entry === undefined) return { kind: "error", code: "process" };
    if (entry.reset) return { kind: "error", code: "write" };
    try {
      const accepted = entry.connection.write(bytes);
      return accepted > 0 ? { kind: "written", bytes: accepted } : { kind: "blocked" };
    } catch {
      entry.reset = true;
      return { kind: "error", code: "write" };
    }
  }

  async #read(target: PreviewTarget, maxBytes: number, signal: AbortSignal | undefined): Promise<PreviewRuntimeCompletion> {
    const entry = this.#entry(target);
    if (entry === undefined) return { kind: "error", code: "process" };
    if (entry.reset) return { kind: "error", code: "read" };
    let read: RouterRead;
    try {
      read = await entry.connection.read(maxBytes, 0, signal);
    } catch {
      if (signal?.aborted === true) return { kind: "error", code: "channel" };
      entry.reset = true;
      return { kind: "error", code: "read" };
    }
    switch (read.kind) {
      case "data":
        return { kind: "read", bytes: read.bytes };
      case "eof":
      case "blocked":
        return { kind: read.kind };
      case "reset":
        entry.reset = true;
        return { kind: "error", code: "read" };
    }
  }

  async #open(port: number, signal: AbortSignal | undefined): Promise<PreviewRuntimeCompletion> {
    const link = this.#link();
    if (link === undefined || aborted(signal)) return { kind: "error", code: "channel" };
    const floor = floorTimer(ROUTER_OPEN_RETRY_MS, signal);
    let result: RouterOpenResult;
    try {
      result = await link.open(port, signal);
    } catch {
      floor.cancel();
      return { kind: "error", code: "channel" };
    }
    if (result.kind === "connected") {
      floor.cancel();
      if (aborted(signal) || this.#link() !== link) {
        result.connection.close();
        return { kind: "error", code: "channel" };
      }
      if (this.#generation === 0xffff_ffff_ffff_ffffn) { result.connection.close(); return { kind: "error", code: "capacity" }; }
      const generation = ++this.#generation;
      this.#connections.set(result.connection.id, { link, generation, connection: result.connection, reset: false });
      return { kind: "opened", generation, process: ROUTER_PROCESS, connection: result.connection.id };
    }
    if (result.kind === "timed-out") floor.cancel();
    else if (!await floor.reached) return { kind: "error", code: "channel" };
    return { kind: "error", code: result.kind === "busy" ? "staging" : "listener" };
  }

  /** The open connection `id` of `process`; a connection of a replaced link ends here. */
  #entry({ generation, process, connection }: PreviewTarget): Entry | undefined {
    if (process !== ROUTER_PROCESS) return undefined;
    const entry = this.#connections.get(connection);
    if (entry === undefined || entry.generation !== generation) return undefined;
    if (entry.link !== this.#link()) {
      this.#connections.delete(connection);
      entry.connection.close();
      return undefined;
    }
    return entry;
  }
}

/** Read through a call: a signal can abort while an open is under way. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Resolves true after `ms`, or false at once when `signal` aborts or the timer is cancelled. */
function floorTimer(ms: number, signal: AbortSignal | undefined): { readonly reached: Promise<boolean>; cancel(): void } {
  let cancel = (): void => {};
  const reached = new Promise<boolean>((resolve) => {
    const stop = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
    cancel = stop;
  });
  return { reached, cancel: () => { cancel(); } };
}
