import { boolean, exactKeys, integer, record, string } from "../decode.js";
import { VMError, decodeSerializedError, type SerializedError } from "../errors.js";
import { decodeAssistanceBinding, type AssistanceBinding } from "./assistance.js";
import { validateAssistanceCredit, type AssistanceCredit } from "./assistance-credit.js";

// Embedded v6 gateways retain dialect 31 (full metadata only).
export const REGISTRY_PROTOCOL_VERSION = 32;
export type RegistryProtocolVersion = 31 | typeof REGISTRY_PROTOCOL_VERSION;
export type RegistryRepresentation = "full" | "install";
export { REGISTRY_CONCURRENCY } from "./registry-limits.js";

export interface RegistryBinding extends AssistanceBinding { readonly installation: number }
interface Envelope extends RegistryBinding { readonly version: RegistryProtocolVersion; readonly sequence: number }
export type RegistryRequest = Envelope & (
  | { readonly kind: "start"; readonly url: string; readonly representation?: RegistryRepresentation }
  | { readonly kind: "read" | "cancel"; readonly request: number }
  | { readonly kind: "acknowledge"; readonly request: number; readonly reservation: number }
  | { readonly kind: "acknowledge-control"; readonly correlation: number; readonly reservation: number }
  | { readonly kind: "retire" }
);
export type RegistryReply = Envelope & { readonly correlation: number } & (
  | { readonly kind: "started" | "cancelled"; readonly request: number; readonly reservation: number }
  | { readonly kind: "headers"; readonly request: number; readonly reservation: number; readonly status: number; readonly headers: ReadonlyArray<readonly [string, string]> }
  | { readonly kind: "data"; readonly request: number; readonly reservation: number; readonly bytes: Uint8Array<ArrayBuffer>; readonly done: boolean }
  | { readonly kind: "failure"; readonly reservation: number; readonly error: SerializedError }
  | { readonly kind: "retired"; readonly credits: readonly AssistanceCredit[]; readonly profile?: RegistryNetworkProfile }
);
/** Network-owner attribution returned with retirement: time spent waiting for
 * issued credit versus time spent in upstream fetch/read calls. Dialect 32 only. */
export interface RegistryNetworkProfile { readonly requests: number; readonly bytes: number; readonly creditWaitMs: number; readonly upstreamMs: number }

const COMMON = ["version", "session", "generation", "installation", "sequence", "kind"];
function id(value: unknown): number { return integer(value, "registry identity", 1, 0xffff_ffff); }
function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Invalid registry transport envelope"); }

function envelope(input: Readonly<Record<string, unknown>>): Envelope {
  const version = input["version"];
  if (version !== 31 && version !== REGISTRY_PROTOCOL_VERSION) invalid();
  return { version, ...decodeAssistanceBinding({ session: input["session"], generation: input["generation"] }),
    installation: id(input["installation"]), sequence: id(input["sequence"]) };
}

/** Installation-scoped worker protocol contract; admission requires an installation lease. */
export function decodeRegistryRequest(value: unknown): RegistryRequest {
  const input = record(value, "registry request");
  const common = envelope(input);
  const kind = input["kind"];
  if (kind === "start") {
    exactKeys(input, [...COMMON, "url"], common.version === 31 ? [] : ["representation"]);
    const url = string(input["url"], "registry URL");
    if (url.length === 0 || url.length > 4096) invalid();
    const representation = input["representation"];
    if (representation !== undefined && representation !== "full" && representation !== "install") invalid();
    return { ...common, kind, url, ...(representation === undefined ? {} : { representation }) };
  }
  if (kind === "read" || kind === "cancel") {
    exactKeys(input, [...COMMON, "request"]);
    return { ...common, kind, request: id(input["request"]) };
  }
  if (kind === "acknowledge") {
    exactKeys(input, [...COMMON, "request", "reservation"]);
    return { ...common, kind, request: id(input["request"]), reservation: id(input["reservation"]) };
  }
  if (kind === "acknowledge-control") {
    exactKeys(input, [...COMMON, "correlation", "reservation"]);
    return { ...common, kind, correlation: id(input["correlation"]), reservation: id(input["reservation"]) };
  }
  if (kind === "retire") { exactKeys(input, COMMON); return { ...common, kind }; }
  return invalid();
}

export function decodeRegistryReply(value: unknown): RegistryReply {
  const input = record(value, "registry reply");
  const common = { ...envelope(input), correlation: id(input["correlation"]) };
  const fields = [...COMMON, "correlation"];
  const kind = input["kind"];
  if (kind === "started" || kind === "cancelled") {
    exactKeys(input, [...fields, "request", "reservation"]);
    return { ...common, kind, request: id(input["request"]), reservation: id(input["reservation"]) };
  }
  if (kind === "headers") {
    exactKeys(input, [...fields, "request", "reservation", "status", "headers"]);
    if (!Array.isArray(input["headers"]) || input["headers"].length > 5) invalid();
    let length = 0;
    const names = new Set<string>();
    const headers = input["headers"].map((value: unknown): readonly [string, string] => {
      if (!Array.isArray(value) || value.length !== 2) invalid();
      const name = string(value[0], "registry header"); const content = string(value[1], "registry header value");
      if (!["content-type", "etag", "last-modified", "cache-control", "content-length"].includes(name)
        || names.has(name)) invalid();
      for (const character of content) {
        const code = character.charCodeAt(0);
        if ((code < 32 && code !== 9) || code === 127) invalid();
      }
      if (name === "content-length" && (!/^\d+$/u.test(content) || !Number.isSafeInteger(Number(content)))) invalid();
      names.add(name);
      length += name.length + content.length;
      if (length > 64 * 1024) invalid();
      return [name, content];
    });
    if (new TextEncoder().encode(JSON.stringify(headers)).length > 128 * 1024 - 1024) invalid();
    return { ...common, kind, request: id(input["request"]), reservation: id(input["reservation"]),
      status: integer(input["status"], "registry status", 200, 599), headers };
  }
  if (kind === "data") {
    exactKeys(input, [...fields, "request", "reservation", "bytes", "done"]);
    const bytes = input["bytes"];
    const done = boolean(input["done"], "registry EOF");
    if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)
      || bytes.byteOffset !== 0 || bytes.buffer.byteLength !== bytes.byteLength || bytes.byteLength > 64 * 1024) invalid();
    if (!done && bytes.byteLength === 0) invalid();
    return { ...common, kind, request: id(input["request"]), reservation: id(input["reservation"]),
      bytes: new Uint8Array(bytes.buffer), done };
  }
  if (kind === "failure") {
    exactKeys(input, [...fields, "error", "reservation"]);
    const error = decodeSerializedError(input["error"]);
    if (error.message.length > 512) invalid();
    if (error.detail !== undefined) {
      exactKeys(error.detail, [], ["phase", "cleanupFailed"]);
      const phase = error.detail["phase"];
      if (phase !== undefined && phase !== "headers" && phase !== "body" && phase !== "retirement") invalid();
      if (error.detail["cleanupFailed"] !== undefined && typeof error.detail["cleanupFailed"] !== "boolean") invalid();
    }
    return { ...common, kind, reservation: id(input["reservation"]), error };
  }
  if (kind === "retired") {
    exactKeys(input, [...fields, "credits"], common.version === 31 ? [] : ["profile"]);
    const profile = input["profile"] === undefined ? undefined : decodeRegistryNetworkProfile(input["profile"]);
    if (!Array.isArray(input["credits"]) || input["credits"].length !== 2) invalid();
    const credits = input["credits"].map((value: unknown) => validateAssistanceCredit(value, 6));
    for (const credit of credits) {
      if (credit.kind !== "return" || credit.producer !== "network"
        || credit.session !== common.session || credit.generation !== common.generation) invalid();
    }
    if (credits[0]?.pool === credits[1]?.pool || credits[0]?.reservation === credits[1]?.reservation || credits[0]?.sequence === credits[1]?.sequence) invalid();
    return { ...common, kind, credits, ...(profile === undefined ? {} : { profile }) };
  }
  return invalid();
}

export function decodeRegistryNetworkProfile(value: unknown): RegistryNetworkProfile {
  const input = record(value, "registry network profile");
  exactKeys(input, ["requests", "bytes", "creditWaitMs", "upstreamMs"]);
  const milliseconds = (field: "creditWaitMs" | "upstreamMs"): number => {
    const time = input[field];
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0) invalid();
    return time;
  };
  return { requests: integer(input["requests"], "registry profile requests", 0), bytes: integer(input["bytes"], "registry profile bytes", 0),
    creditWaitMs: milliseconds("creditWaitMs"), upstreamMs: milliseconds("upstreamMs") };
}
