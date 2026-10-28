// System preview routing (ADR 0015, RC10): a port an assisted task holds keeps its assisted
// transport; any other port goes through the network link's router; when the router finds no
// listener and assistance is configured, the assisted transport waits for one. Sessions see one
// handle namespace whatever transport carries them.
import type { PreviewRuntimePort } from "./preview-http.js";
import type { PreviewRuntimeCompletion, PreviewRuntimeOperation, PreviewTarget } from "./preview-runtime-channel.js";
import type { RouterPreviewRuntime } from "./router-preview-runtime.js";

/** The process every routed handle belongs to. */
export const ROUTING_PROCESS = 1;
/** Open handles per routing; one more open is closed again and answered `staging`. */
export const MAX_ROUTED_HANDLES = 128;

/** The router's preview transport, and whether a link is up. */
export type RouterTransport = Pick<RouterPreviewRuntime, "available" | "request">;

/** The assisted preview transport, which also knows which assisted task holds a port. */
export interface AssistedPreview extends PreviewRuntimePort {
  holder(port: number): number | undefined;
}

interface Handle extends PreviewTarget {
  readonly transport: PreviewRuntimePort;
  readonly process: number;
  readonly connection: number;
}

export class SystemPreviewRouting implements PreviewRuntimePort {
  readonly #router: RouterTransport;
  readonly #assisted: () => AssistedPreview | undefined;
  readonly #handles = new Map<number, Handle>();
  #nextHandle = 1;

  constructor(router: RouterTransport, assisted: () => AssistedPreview | undefined) {
    this.#router = router;
    this.#assisted = assisted;
  }

  async request(operation: PreviewRuntimeOperation, signal?: AbortSignal): Promise<PreviewRuntimeCompletion> {
    if (operation.kind === "open") return this.#open(operation.port, signal);
    const handle = operation.process === ROUTING_PROCESS ? this.#handles.get(operation.connection) : undefined;
    if (handle === undefined || handle.generation !== operation.generation) return { kind: "error", code: "process" };
    if (operation.kind === "close") this.#handles.delete(operation.connection);
    return handle.transport.request({ ...operation, generation: handle.generation, process: handle.process, connection: handle.connection }, signal);
  }

  async #open(port: number, signal: AbortSignal | undefined): Promise<PreviewRuntimeCompletion> {
    const assisted = this.#assisted();
    if (!this.#router.available) {
      if (assisted === undefined) return { kind: "error", code: "channel" };
      return this.#opened(assisted, await assisted.request({ kind: "open", port, process: null }, signal), signal);
    }
    const holder = assisted?.holder(port);
    if (assisted !== undefined && holder !== undefined) {
      return this.#opened(assisted, await assisted.request({ kind: "open", port, process: holder }, signal), signal);
    }
    const routed = await this.#router.request({ kind: "open", port, process: null }, signal);
    if (routed.kind === "error" && routed.code === "listener" && assisted !== undefined) {
      return this.#opened(assisted, await assisted.request({ kind: "open", port, process: null }, signal), signal);
    }
    return this.#opened(this.#router, routed, signal);
  }

  /** Gives an opened connection a handle of this routing. */
  async #opened(transport: PreviewRuntimePort, completion: PreviewRuntimeCompletion, signal: AbortSignal | undefined): Promise<PreviewRuntimeCompletion> {
    if (completion.kind !== "opened") return completion;
    if (this.#handles.size >= MAX_ROUTED_HANDLES) {
      await transport.request({ kind: "close", generation: completion.generation, process: completion.process, connection: completion.connection }, signal);
      return { kind: "error", code: "staging" };
    }
    const handle = this.#nextHandle++;
    this.#handles.set(handle, { transport, generation: completion.generation, process: completion.process, connection: completion.connection });
    return { kind: "opened", generation: completion.generation, process: ROUTING_PROCESS, connection: handle };
  }
}
