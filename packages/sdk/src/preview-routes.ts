import type { PreviewHandle, PreviewOptions } from "./contracts.js";
import type { RuntimeVM, PreviewHandle as RuntimePreviewHandle } from "./runtime/vm-types.js";
import { VMError } from "./runtime/errors.js";

interface Route {
  readonly port: number;
  readonly controller: AbortController;
  readonly opening: Promise<RuntimePreviewHandle>;
  references: number;
}

/** Browser route leases over the existing guest listener and transport owners. */
export class PreviewRoutes {
  readonly #routes = new Map<number, Route>();
  readonly #lifetime = new AbortController();
  #disposal: Promise<void> | undefined;
  constructor(readonly runtime: Pick<RuntimeVM, "listeningPorts" | "watchListeningPorts" | "exposePort">, readonly isolation: PreviewOptions["isolation"]) {}

  async expose(port: number, signal?: AbortSignal): Promise<PreviewHandle> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new VMError("INVALID_ARGUMENT", "preview port must be an integer from 1 through 65535");
    if (this.#lifetime.signal.aborted) throw this.#disposed();
    if (signal?.aborted === true) throw new VMError("ABORTED", "preview admission was cancelled");
    let route = this.#routes.get(port);
    if (route === undefined) {
      const controller = new AbortController();
      const opening = this.#open(port, AbortSignal.any([controller.signal, this.#lifetime.signal]));
      route = { port, controller, opening, references: 0 }; this.#routes.set(port, route);
      const owned = route;
      void opening.catch(() => { if (this.#routes.get(port) === owned) this.#routes.delete(port); });
    }
    const owned = route; owned.references++;
    let handle: RuntimePreviewHandle;
    try { handle = await admission(owned.opening, signal); }
    catch (error) { await this.#release(owned); if (this.#isDisposed()) throw this.#disposed(); throw error; }
    let closed = false;
    return { port, url: handle.url, isolation: this.isolation, close: async () => {
      if (closed) return; closed = true; await this.#release(owned);
    } };
  }

  async #open(port: number, signal: AbortSignal): Promise<RuntimePreviewHandle> {
    const stop = new AbortController(); let found = false;
    const ready = () => found;
    await this.runtime.watchListeningPorts(ports => {
      if (ports.some(listener => listener.port === port && listener.previewable)) { found = true; stop.abort(); }
    }, { signal: AbortSignal.any([signal, stop.signal]) });
    if (this.#lifetime.signal.aborted) throw this.#disposed();
    if (!ready() || signal.aborted) throw new VMError("ABORTED", "preview admission was cancelled");
    return this.runtime.exposePort(port, { signal });
  }

  async #release(route: Route): Promise<void> {
    if (route.references === 0) return;
    route.references--;
    if (route.references !== 0) return;
    if (this.#routes.get(route.port) === route) this.#routes.delete(route.port);
    route.controller.abort();
    await route.opening.then(handle => handle.close(), () => undefined);
  }

  dispose(): Promise<void> {
    this.#lifetime.abort();
    this.#disposal ??= this.#closeAll(); return this.#disposal;
  }
  async #closeAll(): Promise<void> {
    const routes = [...this.#routes.values()]; this.#routes.clear();
    for (const route of routes) { route.references = 0; route.controller.abort(); }
    const results = await Promise.allSettled(routes.map(route => route.opening.then(handle => handle.close(), () => undefined)));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason instanceof Error ? failed.reason : new VMError("PROTOCOL_ERROR", "preview cleanup failed");
  }
  #disposed(): VMError { return new VMError("PROTOCOL_ERROR", "VM has been disposed"); }
  #isDisposed(): boolean { return this.#lifetime.signal.aborted; }
}

function admission<T>(opening: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return opening;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new VMError("ABORTED", "preview admission was cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void opening.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, (error: unknown) => { signal.removeEventListener("abort", abort); reject(error instanceof Error ? error : new VMError("PROTOCOL_ERROR", "preview opening failed")); });
  });
}
