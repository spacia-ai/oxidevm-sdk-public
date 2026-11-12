import type { PreviewHandle, PreviewOptions, PreviewSiteAccess } from "./contracts.js";
import type { RuntimeVM, PreviewHandle as RuntimePreviewHandle } from "./runtime/vm-types.js";
import { exactKeys, record } from "./runtime/decode.js";
import { VMError } from "./runtime/errors.js";
import { requireUsableHandle, watchHandleBlockedSites, type PreviewHandleEnds } from "./preview-blocked-sites.js";
import { decodePreviewSiteAccess } from "./preview-site-access.js";

interface Route {
  readonly port: number;
  readonly controller: AbortController;
  readonly opening: Promise<RuntimePreviewHandle>;
  references: number;
}

/** `exposePort`'s options as the public layer decoded them; a site access is canonical. */
export interface ExposeOptions {
  readonly signal?: AbortSignal;
  readonly siteAccess?: PreviewSiteAccess;
}

/** Browser route leases over the existing guest listener and transport owners. */
export class PreviewRoutes {
  readonly #routes = new Map<number, Route>();
  readonly #lifetime = new AbortController();
  #disposal: Promise<void> | undefined;
  constructor(readonly runtime: Pick<RuntimeVM, "listeningPorts" | "watchListeningPorts" | "exposePort">, readonly isolation: PreviewOptions["isolation"]) {}

  async expose(port: number, options: ExposeOptions = {}): Promise<PreviewHandle> {
    const { signal, siteAccess } = options;
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
    try {
      handle = await admission(owned.opening, signal);
      // Exposures of one port share its session and so its site access: one that names an access applies it to
      // the session, where the last change wins, and resolves once it applied. The session opens without one, so
      // a change that fails or is cancelled fails only the exposure that asked for it.
      if (siteAccess !== undefined) await handle.setSiteAccess(siteAccess, signal === undefined ? {} : { signal });
    } catch (error) { await this.#release(owned); if (this.#isDisposed()) throw this.#disposed(); throw error; }
    const session = handle;
    return previewHandle({
      port, url: session.url, isolation: this.isolation, lifetime: this.#lifetime.signal,
      setSiteAccess: (access, change) => session.setSiteAccess(access, change === undefined ? {} : { signal: change }),
      close: () => this.#release(owned),
    });
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

/** What a public preview handle stands on: its exposure, the VM's lifetime, and the owner of its session. */
export interface PreviewHandleOwner {
  readonly port: number;
  readonly url: URL;
  readonly isolation: PreviewOptions["isolation"];
  /** Aborts when the VM's disposal begins. */
  readonly lifetime: AbortSignal;
  /** Applies a canonical site access to the session the exposure shares. */
  setSiteAccess(access: PreviewSiteAccess, signal: AbortSignal | undefined): Promise<void>;
  /** Releases the exposure; called at most once. */
  close(): Promise<void>;
}

/**
 * One exposure's public handle, for a local VM's routes and for a hosted frame's previews alike. It decodes what
 * the application passes before anything is sent, refuses changes once closed (ABORTED) or once the VM's
 * disposal began (PROTOCOL_ERROR), and watches the blocked sites the preview's pages report to this document.
 */
export function previewHandle(owner: PreviewHandleOwner): PreviewHandle {
  const closed = new AbortController();
  const ends: PreviewHandleEnds = { closed: closed.signal, lifetime: owner.lifetime };
  return {
    port: owner.port, url: owner.url, isolation: owner.isolation,
    setSiteAccess: async (access, options) => {
      const signal = signalOption(publicOptions(options, "setSiteAccess", ["signal"]), "setSiteAccess");
      const canonical = decodePreviewSiteAccess(access, "INVALID_ARGUMENT");
      requireUsableHandle(ends);
      await owner.setSiteAccess(canonical, signal);
    },
    watchBlockedSites: (listener, options) => watchHandleBlockedSites(owner.url.origin, ends, listener, options),
    close: async () => {
      if (closed.signal.aborted) return;
      closed.abort();
      await owner.close();
    },
  };
}

/** The public `exposePort` options: at most an AbortSignal and a valid site access. */
export function decodeExposeOptions(options: unknown): ExposeOptions {
  const fields = publicOptions(options, "exposePort", ["signal", "siteAccess"]);
  const signal = signalOption(fields, "exposePort");
  const access = fields["siteAccess"];
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(access === undefined ? {} : { siteAccess: decodePreviewSiteAccess(access, "INVALID_ARGUMENT") }),
  };
}

/** An optional options object with at most `keys`; INVALID_ARGUMENT for anything else. */
function publicOptions(options: unknown, method: string, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (options === undefined) return {};
  try {
    const fields = record(options, `${method} options`);
    exactKeys(fields, [], keys);
    return fields;
  } catch (error) {
    throw error instanceof VMError ? new VMError("INVALID_ARGUMENT", error.message) : error;
  }
}

function signalOption(fields: Readonly<Record<string, unknown>>, method: string): AbortSignal | undefined {
  const signal = fields["signal"];
  if (signal === undefined || signal instanceof AbortSignal) return signal;
  throw new VMError("INVALID_ARGUMENT", `${method} needs its signal to be an AbortSignal`);
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
