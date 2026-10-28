import { VMError } from "../errors.js";
import { decodeRegistryReply, decodeRegistryRequest, type RegistryBinding } from "../protocol/registry.js";
import { registryReplyPipe } from "./registry-pipe.js";
import type { RegistryBudget } from "./registry-transport.js";
import type { AssistanceCredit } from "../protocol/assistance-credit.js";
import type { InstallationProfileRecorder } from "./control/installation-profile.js";

export type RegistryTimelineObserver = Pick<InstallationProfileRecorder, "registryRequest" | "registryReply">;

/** Control-owned handoff to the authenticated guest byte transport. Credit
 * returns come from the network supervisor, never from gateway messages. */
export class SystemRegistryEndpoint {
  readonly #completion = Promise.withResolvers<undefined>();
  readonly done = this.#completion.promise;
  #closing: Promise<undefined> | undefined;
  #failed = false;
  #pipe: ReturnType<typeof registryReplyPipe> | undefined;

  constructor(readonly port: MessagePort, readonly credits: readonly AssistanceCredit[],
    private readonly retire: () => Promise<void>, private readonly binding: RegistryBinding,
    private readonly traffic: RegistryBudget, private readonly failed: (error: unknown) => void) {
    void this.done.catch(() => {});
  }

  /** The observer only records decoded traffic for attribution; it never gates or reorders it. */
  forward(input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>, observe?: RegistryTimelineObserver): void {
    if (this.#failed || this.#pipe !== undefined || this.#closing !== undefined) throw new VMError("PROTOCOL_ERROR", "Registry endpoint already consumed");
    const pipe = registryReplyPipe(input, output, this.traffic);
    this.#pipe = pipe;
    void pipe.done.catch((error: unknown) => { if (this.#closing === undefined) this.failed(error); });
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      try { const reply = decodeRegistryReply(event.data); this.#checkBinding(reply); observe?.registryReply(reply); pipe.send(reply); }
      catch (error) { this.failed(error); }
    };
    this.port.onmessageerror = () => this.failed(new VMError("PROTOCOL_ERROR", "Guest registry reply transfer failed"));
    this.port.start();
    pipe.start(value => {
      try { const request = decodeRegistryRequest(value); this.#checkBinding(request); observe?.registryRequest(request); this.port.postMessage(request); }
      catch (error) { this.failed(error); }
    }, this.failed);
  }

  #checkBinding(value: RegistryBinding): void {
    if (value.session !== this.binding.session || value.generation !== this.binding.generation || value.installation !== this.binding.installation) {
      throw new VMError("PROTOCOL_ERROR", "Wrong guest registry endpoint identity");
    }
  }

  close(): Promise<undefined> {
    if (this.#failed) return this.done;
    this.#closing ??= (async () => {
      this.#detach();
      this.#pipe?.close();
      try {
        const results = await Promise.allSettled([this.#pipe?.done, this.retire()]);
        for (const result of results) if (result.status === "rejected") throw result.reason;
        this.#completion.resolve(undefined);
      }
      catch (error) { this.#completion.reject(error); }
      return this.done;
    })();
    return this.#closing;
  }

  fail(error: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#detach();
    this.#pipe?.close();
    this.#completion.reject(error);
  }

  #detach(): void {
    this.port.onmessage = null; this.port.onmessageerror = null; this.port.close();
  }
}
