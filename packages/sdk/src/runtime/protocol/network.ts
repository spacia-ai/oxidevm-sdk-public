import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import type { NetworkState, RelayConnectionOptions } from "../network-types.js";
import { decodeRelayFailure } from "../relay-errors.js";
import type { OperationDecoders } from "./operations.js";

export type RelayOptions =
  | { readonly kind: "personal"; readonly workspaceName?: string }
  | { readonly kind: "server"; readonly url: string; readonly sessionUrl?: string; readonly headers?: Readonly<Record<string, string>> };
export interface NetworkView { readonly revision: number; readonly state: NetworkState }
export interface NetworkOperations {
  "network-connect": { request: { readonly options: RelayOptions }; response: NetworkView };
  "network-disconnect": { request: undefined; response: NetworkView };
  "network-state": { request: undefined; response: NetworkView };
  "network-watch": { request: { readonly afterRevision: number }; response: NetworkView };
}
export const networkResponseDecoders: OperationDecoders<NetworkOperations> = {
  "network-connect": decodeNetworkView, "network-disconnect": decodeNetworkView, "network-watch": decodeNetworkView, "network-state": decodeNetworkView,
};
export function decodeRelayOptions(value: unknown, base: string): RelayOptions {
  const input = record(value, "relay options");
  if (input["kind"] === "personal") {
    exactKeys(input, ["kind"], ["workspaceName"]);
    const name = input["workspaceName"];
    if (name === undefined) return {kind:"personal"};
    return {kind:"personal", workspaceName: boundedText(name, "workspace name", 100)};
  }
  if (input["kind"] !== "server") throw new VMError("INVALID_ARGUMENT", "Choose personal or server relay");
  exactKeys(input, ["kind", "url"], ["sessionUrl", "headers"]);
  const url = httpUrl(input["url"], base, false);
  const sessionUrl = input["sessionUrl"] === undefined ? undefined : httpUrl(input["sessionUrl"], base, true);
  const headers = input["headers"] === undefined ? undefined : decodeHeaders(input["headers"]);
  return {kind:"server", url, ...(sessionUrl === undefined ? {} : {sessionUrl}), ...(headers === undefined ? {} : {headers})};
}
/** A caller's options for the wire. Malformed caller input is an invalid argument, not a protocol fault. */
export function serializeRelayOptions(options: RelayConnectionOptions, base: string): RelayOptions {
  try { return decodeRelayOptions(options, base); }
  catch (error: unknown) {
    if (error instanceof VMError && error.code === "PROTOCOL_ERROR") throw new VMError("INVALID_ARGUMENT", error.message);
    throw error;
  }
}
function httpUrl(value: unknown, base: string, relative: boolean): string {
  const text = value instanceof URL ? value.href : string(value, "relay URL");
  let url: URL;
  try { url = relative ? new URL(text, base) : new URL(text); }
  catch { throw new VMError("INVALID_ARGUMENT", "Relay URLs must be valid URLs"); }
  const local = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if ((url.protocol !== "https:" && !local) || url.username !== "" || url.password !== "" || url.hash !== "" || (!relative && url.search !== "") || url.href.length > 4096) throw new VMError("INVALID_ARGUMENT", "Relay URLs require HTTPS and cannot contain credentials");
  return url.href;
}
function decodeHeaders(value: unknown): Readonly<Record<string,string>> {
  const input = record(value, "relay authorization headers");
  if (Object.keys(input).length > 32) throw new VMError("INVALID_ARGUMENT", "Too many relay headers");
  let size = 0;
  const entries = Object.entries(input).map(([key, value]) => {
    const text = string(value, "relay header"); size += key.length + text.length;
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(key) || /^(host|origin|cookie|content-length|connection|upgrade|sec-.+|proxy-.+|x-oxidevm-issuer)$/i.test(key) || /[\r\n\0]/.test(text) || text.length > 4096 || size > 16384) throw new VMError("INVALID_ARGUMENT", "Invalid browser authorization header");
    return [key, text] satisfies readonly [string,string];
  });
  return Object.fromEntries(entries);
}
export function decodeNetworkState(value: unknown): NetworkState {
  const input = record(value, "internet state");
  switch (input["kind"]) {
    case "off": case "discovering": exactKeys(input,["kind"]); return {kind:input["kind"]};
    case "failed": exactKeys(input,["kind","reason"]); return {kind:"failed",reason:decodeRelayFailure(input["reason"])};
    case "connecting": case "connected": {
      const kind = input["kind"]; exactKeys(input, kind === "connected" ? ["kind","relay","expiresAt"] : ["kind","relay"]);
      const relay = input["relay"]; if (relay !== "personal" && relay !== "server") throw new VMError("PROTOCOL_ERROR", "Invalid relay kind");
      return kind === "connecting" ? {kind,relay} : {kind,relay,expiresAt:integer(input["expiresAt"],"session expiry",0)};
    }
    case "awaiting-approval":
      exactKeys(input,["kind","code","origin","workspaceId","workspaceName","expiresAt"]);
      if (typeof input["code"] !== "string" || !/^\d{6}$/.test(input["code"])) throw new VMError("PROTOCOL_ERROR", "Invalid pairing code");
      return {kind:"awaiting-approval",code:input["code"],origin:boundedText(input["origin"],"origin",4096),workspaceId:boundedText(input["workspaceId"],"workspace ID",256),workspaceName:boundedText(input["workspaceName"],"workspace name",100),expiresAt:integer(input["expiresAt"],"approval expiry",0)};
    default: throw new VMError("PROTOCOL_ERROR", "Invalid internet state");
  }
}
export function decodeNetworkView(value: unknown): NetworkView {
  const input = record(value,"network view"); exactKeys(input,["revision","state"]);
  return {revision:integer(input["revision"],"state revision",0),state:decodeNetworkState(input["state"])};
}
export function boundedText(value: unknown, label: string, limit: number): string {
  const text = string(value,label); if (text.length === 0 || text.length > limit || Array.from(text).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127)) throw new VMError("PROTOCOL_ERROR", `Invalid ${label}`); return text;
}
