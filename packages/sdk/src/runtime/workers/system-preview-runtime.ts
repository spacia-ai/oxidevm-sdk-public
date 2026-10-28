import { VMError } from "../errors.js";
import type { PreviewRuntimeCompletion, PreviewRuntimeOperation, PreviewRuntimeClient } from "./preview-runtime-channel.js";
import type { SystemListeners } from "./system-listeners.js";
import type { AssistedPreview } from "./system-preview-routing.js";

/** How long a preview request waits for the guest listener to appear. */
const LISTENER_WAIT_MS = 60_000;

/** System-mode preview transport: the network owner resolves which assisted
 * task holds the listener, then control drives that task's own Linux socket.
 * Completions, never exceptions, tell the proxy what failed. */
export class SystemPreviewRuntime implements AssistedPreview {
  readonly #listeners: SystemListeners;
  readonly #client: PreviewRuntimeClient;
  readonly #lifetime: AbortSignal;

  constructor(listeners: SystemListeners, client: PreviewRuntimeClient, lifetime: AbortSignal) {
    this.#listeners = listeners; this.#client = client; this.#lifetime = lifetime;
  }

  /** The assisted task listening on `port` now, if any. */
  holder(port: number): number | undefined {
    return this.#listeners.resolve(port);
  }

  async request(operation: PreviewRuntimeOperation, signal?: AbortSignal): Promise<PreviewRuntimeCompletion> {
    if (this.#lifetime.aborted) return { kind: "error", code: "channel" };
    if (operation.kind !== "open" || operation.process !== null) return this.#forward(operation, signal);
    const wait = AbortSignal.any([this.#lifetime, AbortSignal.timeout(LISTENER_WAIT_MS), ...(signal === undefined ? [] : [signal])]);
    let process: number;
    try { process = await this.#listeners.waitFor(operation.port, wait); }
    catch (error) {
      if (error instanceof VMError && (error.code === "ABORTED" || error.code === "QUOTA_EXCEEDED")) return { kind: "error", code: "listener" };
      throw error;
    }
    return this.#forward({ ...operation, process }, signal);
  }

  async #forward(operation: PreviewRuntimeOperation, signal?: AbortSignal): Promise<PreviewRuntimeCompletion> {
    try { return await this.#client.request(operation, signal); }
    catch (error) {
      if (error instanceof VMError && error.code === "ABORTED") return { kind: "error", code: "channel" };
      throw error;
    }
  }
}
