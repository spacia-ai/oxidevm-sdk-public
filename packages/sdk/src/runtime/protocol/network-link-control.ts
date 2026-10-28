// Control operations of the full-system network link (ADR 0015): the main thread hands the
// control worker its end of the frame bridge, and tells it when the network worker failed.
import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { validateFrameBridgeBuffer } from "../frame-bridge.js";
import { decodeUndefined } from "./decoders.js";
import { PROTOCOL_VERSION } from "./common.js";

export interface NetworkLinkControlOperations {
  readonly "network-link-connect": {
    readonly request: { readonly bridge: SharedArrayBuffer | "message"; readonly doorbell: MessagePort };
    readonly response: undefined;
  };
  readonly "network-link-failed": { readonly request: undefined; readonly response: undefined };
}

type Base = { readonly id: number; readonly version: typeof PROTOCOL_VERSION };

export type NetworkLinkControlRequest =
  | (Base & { readonly type: "network-link-connect"; readonly bridge: SharedArrayBuffer | "message"; readonly doorbell: MessagePort })
  | (Base & { readonly type: "network-link-failed" });

export const networkLinkResponseDecoders = {
  "network-link-connect": decodeUndefined,
  "network-link-failed": decodeUndefined,
};

export function isNetworkLinkControl(type: string): type is keyof NetworkLinkControlOperations {
  return type === "network-link-connect" || type === "network-link-failed";
}

export function decodeNetworkLinkControl(value: unknown): NetworkLinkControlRequest {
  const input = record(value, "network link control request");
  const id = integer(input["id"], "request id", 1);
  integer(input["version"], "protocol version", PROTOCOL_VERSION, PROTOCOL_VERSION);
  const base: Base = { id, version: PROTOCOL_VERSION };
  const type = string(input["type"], "network link control operation");
  switch (type) {
    case "network-link-connect": {
      exactKeys(input, ["id", "version", "type", "bridge", "doorbell"]);
      const doorbell = input["doorbell"];
      if (!(doorbell instanceof MessagePort)) throw new VMError("PROTOCOL_ERROR", "the network link doorbell must be a MessagePort");
      return { ...base, type, bridge: input["bridge"] === "message" ? "message" : validateFrameBridgeBuffer(input["bridge"]), doorbell };
    }
    case "network-link-failed":
      exactKeys(input, ["id", "version", "type"]);
      return { ...base, type };
    default:
      throw new VMError("PROTOCOL_ERROR", "unknown network link control operation");
  }
}
