import { VMError } from "../errors.js";
import type { RegistryRequest } from "../protocol/registry.js";
import type { GrantedTraffic } from "./assistance/traffic.js";
import type { AssistanceTraffic } from "./control/assistance-traffic.js";

export type RegistryBudget = Pick<GrantedTraffic, "reserve" | "acquire" | "release">;

/** The control-side adapter spends VM reservations. A native producer instead
 * supplies GrantedTraffic directly and cannot create or return VM grants. */
export function registryVmBudget(traffic: AssistanceTraffic): RegistryBudget {
  return {
    reserve: (pool, bytes) => traffic.reserve(null, pool, bytes),
    acquire: (bytes, signal) => traffic.acquire(null, bytes, signal),
    release: reservation => traffic.release(null, reservation),
  };
}

/** Browser ports and the installation's private byte pipe share one registry
 * client. Transport shutdown is owned by the enclosing installation lease. */
export interface RegistryTransport {
  start(receive: (value: unknown) => void, failed: (error: unknown) => void): void;
  send(request: RegistryRequest): void;
  close(): void;
}

export function registryMessagePort(port: MessagePort): RegistryTransport {
  return {
    start(receive, failed) {
      port.onmessage = (event: MessageEvent<unknown>) => receive(event.data);
      port.onmessageerror = () => failed(new VMError("PROTOCOL_ERROR", "Registry reply transfer failed"));
      port.start();
    },
    send(request) { port.postMessage(request); },
    close() { port.onmessage = null; port.onmessageerror = null; port.close(); },
  };
}
