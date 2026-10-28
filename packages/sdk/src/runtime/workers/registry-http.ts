import { VMError } from "../errors.js";
import type { RegistryClient } from "./registry-client.js";
import type { RegistryRepresentation } from "../protocol/registry.js";

/** Adapt registry deliveries to the native HTTP gateway without transferring
 * callbacks across workers. The client still owns all wire identities/credits. */
export async function openRegistryHttp(client: Pick<RegistryClient, "start" | "read" | "cancel">,
  url: string, signal: AbortSignal, representation: RegistryRepresentation = "full") {
  signal.throwIfAborted();
  const opening = client.start(url, signal, representation);
  const interrupted = Promise.withResolvers<never>();
  void interrupted.promise.catch(() => {});
  let retirement: Promise<void> | undefined;
  const cancel = (): Promise<void> => {
    if (retirement !== undefined) return retirement;
    interrupted.reject(new VMError("ABORTED", "Registry HTTP request cancelled"));
    retirement = opening.identity.then(request => client.cancel(request))
      .finally(() => signal.removeEventListener("abort", abort));
    return retirement;
  };
  const abort = (): void => {
    interrupted.reject(signal.reason);
    void cancel().catch(() => {});
  };
  const active = (): void => {
    signal.throwIfAborted();
    if (retirement !== undefined) throw new VMError("ABORTED", "Registry HTTP request is retiring");
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const headers = await Promise.race([opening.response, interrupted.promise]);
    active();
    return {
      status: headers.value.status, headers: headers.value.headers,
      acknowledgeHeaders() { active(); headers.acknowledge(); },
      async read() {
        active();
        const delivery = await Promise.race([client.read(headers.value.request), interrupted.promise]);
        active();
        return { bytes: delivery.value.bytes, done: delivery.value.done,
          acknowledge() { active(); delivery.acknowledge(); } };
      },
      cancel,
    };
  } catch (error) {
    // Failure of retirement takes precedence: an aborted caller cannot turn an
    // uncertain producer into a successfully cleaned-up acquisition.
    await cancel();
    throw error;
  }
}
