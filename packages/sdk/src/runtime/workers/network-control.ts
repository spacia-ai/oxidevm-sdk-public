import { exactKeys, integer, record } from "../decode.js";
import { serializeUnknownError, VMError } from "../errors.js";
import { PROTOCOL_VERSION } from "../protocol/common.js";
import { decodeRelayOptions } from "../protocol/network.js";
import type { RelayConnectionOwner } from "./network-connection.js";

/** Uses the SDK's existing request/response envelope; credentials stay in this worker. */
export function serveNetworkControl(port: MessagePort, owner: RelayConnectionOwner, pageUrl: string): void {
  const active = new Map<number, AbortController>();
  port.onmessage = (event: MessageEvent<unknown>) => {
    let id: number | undefined;
    let ownsRequest = false;
    try {
      const input = record(event.data, "network control request");
      if (input["version"] !== PROTOCOL_VERSION) throw new VMError("PROTOCOL_ERROR", "Network control version mismatch");
      if (input["type"] === "cancel") {
        exactKeys(input, ["version", "type", "requestId"]);
        active.get(integer(input["requestId"], "cancelled request", 1))?.abort();
        return;
      }
      id = integer(input["id"], "network request", 1);
      if (active.has(id)) {
        // A duplicate must never masquerade as a response to the original.
        for (const controller of active.values()) controller.abort();
        port.close();
        void owner.disconnect().catch(() => {});
        throw new VMError("PROTOCOL_ERROR", "Duplicate network request identity");
      }
      if (active.size >= 64) throw new VMError("QUOTA_EXCEEDED", "Too many network control requests");
      const controller = new AbortController(); active.set(id, controller); ownsRequest = true;
      let operation: Promise<unknown>;
      switch (input["type"]) {
        case "network-connect":
          exactKeys(input, ["version", "type", "id", "options"]);
          operation = owner.connect(decodeRelayOptions(input["options"], pageUrl), controller.signal).then(() => owner.view);
          break;
        case "network-disconnect":
          exactKeys(input, ["version", "type", "id"]);
          operation = owner.disconnect().then(() => owner.view);
          break;
        case "network-state":
          exactKeys(input, ["version", "type", "id"]);
          operation = Promise.resolve(owner.view);
          break;
        case "network-watch":
          exactKeys(input, ["version", "type", "id", "afterRevision"]);
          operation = owner.wait(integer(input["afterRevision"], "network revision", 0), controller.signal);
          break;
        default: throw new VMError("PROTOCOL_ERROR", "Unknown network control operation");
      }
      const requestId = id;
      void operation.then(
        value => port.postMessage({version: PROTOCOL_VERSION, id: requestId, ok: true, value}),
        (error: unknown) => port.postMessage({version: PROTOCOL_VERSION, id: requestId, ok: false, error: serializeUnknownError(error)}),
      ).finally(() => { active.delete(requestId); });
    } catch (error: unknown) {
      if (id === undefined) throw error;
      if (!ownsRequest && active.has(id)) return;
      if (ownsRequest) active.delete(id);
      port.postMessage({version: PROTOCOL_VERSION, id, ok: false, error: serializeUnknownError(error)});
    }
  };
  port.onmessageerror = () => { for (const controller of active.values()) controller.abort(); void owner.disconnect(); };
  port.start();
}
