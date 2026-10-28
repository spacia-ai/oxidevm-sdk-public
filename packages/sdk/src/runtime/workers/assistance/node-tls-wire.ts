import { Buffer } from "buffer";
import { exactKeys, integer, record, string } from "../../decode.js";
import { VMError } from "../../errors.js";
import { decodeAssistanceSocketAddress } from "../../protocol/assistance.js";
import type { Readable } from "./node-streams.js";
import { encodeNativeFrame, readNativeFrame } from "./native-frames.js";

export type TlsAddressInfo = {
  readonly localAddress: string; readonly localPort: number; readonly localFamily: "IPv4" | "IPv6";
  readonly remoteAddress: string; readonly remotePort: number; readonly remoteFamily: "IPv4" | "IPv6";
};
export type TlsSecureInfo = TlsAddressInfo & {
  readonly kind: "secure"; readonly authorized: boolean; readonly authorizationError: string | null;
  readonly servername: string | false | null; readonly alpnProtocol: string | false;
  readonly protocol: string; readonly cipher: { name: string; standardName: string; version: string };
};
export type TlsFrame = TlsSecureInfo | ({ readonly kind: "connect" } & TlsAddressInfo) | { readonly kind: "data"; readonly bytes: Buffer }
  | { readonly kind: "written"; readonly count: number } | { readonly kind: "finished" | "end" | "timeout" }
  | { readonly kind: "error"; readonly code: string; readonly message: string } | { readonly kind: "close"; readonly hadError: boolean };
export type TlsControl = { readonly kind: "end" | "destroy" }
  | { readonly kind: "no-delay"; readonly enabled: boolean }
  | { readonly kind: "keep-alive"; readonly enabled: boolean; readonly delay: number }
  | { readonly kind: "timeout"; readonly duration: number };

export function tlsControl(value: TlsControl): Buffer { return encodeNativeFrame(1, Buffer.from(JSON.stringify(value))); }
export function tlsData(bytes: Uint8Array): Buffer { return encodeNativeFrame(0, bytes); }
/** The existing child Readable owns buffering and transport credit. Read only
 * one bounded frame at a time, so a paused TLS consumer also pauses Linux. */
export async function readTlsFrame(stream: Readable): Promise<TlsFrame | null> {
  const frame = await readNativeFrame(stream); if (frame === null) return null;
  const { tag, bytes } = frame;
  if (tag === 0) return { kind: "data", bytes };
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  return decodeEvent(value);
}
function decodeEvent(value: unknown): Exclude<TlsFrame, { kind: "data" }> {
  const input = record(value, "TLS helper event"); const kind = input["kind"];
  if (kind === "finished" || kind === "end" || kind === "timeout") { exactKeys(input, ["kind"]); return { kind }; }
  if (kind === "written") { exactKeys(input, ["kind", "count"]); return { kind, count: integer(input["count"], "TLS write size", 1, 65536) }; }
  if (kind === "close") { exactKeys(input, ["kind", "hadError"]); return { kind, hadError: boolean(input["hadError"]) }; }
  if (kind === "error") {
    exactKeys(input, ["kind", "code", "message"]);
    return { kind, code: text(input["code"], 128), message: text(input["message"], 8192) };
  }
  if (kind === "connect") {
    exactKeys(input, ["kind", "localAddress", "localPort", "localFamily", "remoteAddress", "remotePort", "remoteFamily"]);
    return { kind, ...addresses(input) };
  }
  if (kind !== "secure") throw invalid();
  exactKeys(input, ["kind", "authorized", "authorizationError", "servername", "alpnProtocol", "protocol", "cipher", "localAddress", "localPort", "localFamily", "remoteAddress", "remotePort", "remoteFamily"]);
  const authorized = boolean(input["authorized"]);
  const authorizationError = input["authorizationError"] === null ? null : text(input["authorizationError"], 8192);
  if (authorized !== (authorizationError === null)) throw invalid();
  const protocol = input["protocol"];
  if (protocol !== "TLSv1" && protocol !== "TLSv1.1" && protocol !== "TLSv1.2" && protocol !== "TLSv1.3") throw invalid();
  const cipher = record(input["cipher"], "TLS cipher"); exactKeys(cipher, ["name", "standardName", "version"]);
  return { kind, authorized, authorizationError,
    servername: input["servername"] === null || input["servername"] === false ? input["servername"] : text(input["servername"], 4096),
    alpnProtocol: input["alpnProtocol"] === false ? false : text(input["alpnProtocol"], 255), protocol,
    cipher: { name: text(cipher["name"], 128), standardName: text(cipher["standardName"], 128), version: text(cipher["version"], 32) },
    ...addresses(input) };
}
function addresses(input: Record<string, unknown>): TlsAddressInfo {
  const local = address(input["localAddress"], input["localPort"], input["localFamily"]);
  const remote = address(input["remoteAddress"], input["remotePort"], input["remoteFamily"]);
  return { localAddress: local.address, localPort: local.port, localFamily: local.family, remoteAddress: remote.address, remotePort: remote.port, remoteFamily: remote.family };
}
function address(value: unknown, port: unknown, family: unknown): { address: string; port: number; family: "IPv4" | "IPv6" } {
  const address = decodeAssistanceSocketAddress({ address: value, port });
  if (family !== "IPv4" && family !== "IPv6") throw invalid();
  if (address.address.includes(":") !== (family === "IPv6")) throw invalid();
  return { ...address, family };
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw invalid(); return value; }
function text(value: unknown, maximum: number): string { const result = string(value, "TLS text"); if (Buffer.byteLength(result) > maximum || result.includes("\0")) throw invalid(); return result; }
function invalid(): VMError { return new VMError("PROTOCOL_ERROR", "Invalid native TLS frame"); }
