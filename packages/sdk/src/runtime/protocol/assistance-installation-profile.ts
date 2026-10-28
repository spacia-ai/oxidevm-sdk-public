import { boolean, exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import type { InstallationRequest } from "./assistance-installation.js";
import type { RegistryNetworkProfile } from "./registry.js";

/** Closed phase set recorded by the installation owner. Overlapping captures
 * and the whole durable publication are single phases in this slice. */
export const INSTALLATION_PHASES = ["connect", "connect:credits", "connect:registry", "connect:streams", "connect:start", "check-current",
  "policy", "spawn", "install", "blocked-builds", "validate-inputs",
  "retire-writers", "materialize", "capture", "publish", "activate", "finish"] as const;
export type InstallationPhaseName = (typeof INSTALLATION_PHASES)[number];
export type InstallationExchangeKind = InstallationRequest["operation"]["kind"];
type ExchangeKind = InstallationExchangeKind;
export const INSTALLATION_EXCHANGE_KINDS = ["start", "stop", "validate-inputs", "blocked-builds", "check-current", "retire", "materialize", "capture",
  "capture-read", "capture-retire", "workspace-capture", "workspace-capture-read", "workspace-capture-retire", "read",
  "write", "acknowledge", "set-build-policy", "activate-materialized", "execute", "stdin", "close-stdin", "signal", "output-ack",
] as const satisfies readonly ExchangeKind[];
type MissingExchangeKind = Exclude<ExchangeKind, (typeof INSTALLATION_EXCHANGE_KINDS)[number]>;
const exhaustiveExchangeKinds: MissingExchangeKind extends never ? true : never = true;
void exhaustiveExchangeKinds;
export const INSTALLATION_PROFILE_REQUEST_LIMIT = 512;

export interface InstallationPhase { readonly name: InstallationPhaseName; readonly startedMs: number; readonly endedMs: number | null }
/** The step of an exchange that threw: the request itself or the SDK's
 * follow-up acknowledgement of its reply. */
export type InstallationExchangeFailure = "request" | "acknowledge";
export interface InstallationExchange {
  readonly kind: ExchangeKind; readonly count: number; readonly bytes: number;
  readonly requestMs: number; readonly maxRequestMs: number; readonly acknowledgeMs: number; readonly maxAcknowledgeMs: number;
  /** Exchanges of this kind whose request or acknowledgement threw; they are
   * counted above as well, so a refused step never hides behind a missing row. */
  readonly failures: number; readonly lastFailure: InstallationExchangeFailure | null;
}
export interface InstallationRegistryRequest {
  readonly request: number; readonly startedMs: number; readonly headersMs: number | null; readonly reads: number; readonly bytes: number;
  readonly networkWaitMs: number; readonly maxNetworkWaitMs: number; readonly gapMs: number; readonly maxGapMs: number; readonly done: boolean;
}
export type InstallationNetworkProfile = RegistryNetworkProfile;
/** Why a frozen install's registry gateway serves every document verbatim. */
export const INSTALLATION_GATEWAY_VERBATIM_REASONS = ["not-frozen", "no-reader", "outside-workspace", "unreadable", "invalid-utf8", "invalid-lockfile", "no-packages"] as const;
export type InstallationGatewayVerbatimReason = (typeof INSTALLATION_GATEWAY_VERBATIM_REASONS)[number];
/** The gateway's metadata configuration: the lockfile whose registry versions
 * prune a frozen install's packuments, or the reason every document stays
 * verbatim (`detail` carries the bounded read or parse failure text). */
export type InstallationGatewayLockfile =
  | { readonly kind: "frozen"; readonly path: string; readonly packages: number }
  | { readonly kind: "verbatim"; readonly reason: InstallationGatewayVerbatimReason; readonly detail: string | null };
export interface InstallationProfile {
  readonly installation: number;
  readonly phases: readonly InstallationPhase[];
  readonly exchanges: readonly InstallationExchange[];
  readonly registry: { readonly requests: readonly InstallationRegistryRequest[]; readonly dropped: number; readonly network: InstallationNetworkProfile | null };
  /** Null until the installation configured its gateway. */
  readonly gateway: InstallationGatewayLockfile | null;
}
export interface InstallationExchangeObservation {
  readonly kind: ExchangeKind; readonly bytes: number; readonly requestMs: number; readonly acknowledgeMs: number;
  readonly failed: InstallationExchangeFailure | null;
}

function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Invalid installation profile"); }
function milliseconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid();
  return value;
}
function count(value: unknown): number { return integer(value, "installation profile count", 0, Number.MAX_SAFE_INTEGER); }
function phaseName(value: unknown): InstallationPhaseName {
  const name = string(value, "installation phase");
  const known = INSTALLATION_PHASES.find(candidate => candidate === name);
  if (known === undefined) invalid();
  return known;
}
function exchangeKind(value: unknown): ExchangeKind {
  const kind = string(value, "installation exchange");
  const known = INSTALLATION_EXCHANGE_KINDS.find(candidate => candidate === kind);
  if (known === undefined) invalid();
  return known;
}

/** Exact decoder for profiles crossing the worker boundary as `unknown`. */
export function decodeInstallationProfile(value: unknown): InstallationProfile {
  const input = record(value, "installation profile");
  exactKeys(input, ["installation", "phases", "exchanges", "registry", "gateway"]);
  const registry = record(input["registry"], "installation profile registry");
  exactKeys(registry, ["requests", "dropped", "network"]);
  if (!Array.isArray(input["phases"]) || !Array.isArray(input["exchanges"]) || !Array.isArray(registry["requests"])) invalid();
  if (input["phases"].length > 4096 || input["exchanges"].length > INSTALLATION_EXCHANGE_KINDS.length || registry["requests"].length > INSTALLATION_PROFILE_REQUEST_LIMIT) invalid();
  const phases = input["phases"].map((entry: unknown): InstallationPhase => {
    const phase = record(entry, "installation phase");
    exactKeys(phase, ["name", "startedMs", "endedMs"]);
    return { name: phaseName(phase["name"]), startedMs: milliseconds(phase["startedMs"]),
      endedMs: phase["endedMs"] === null ? null : milliseconds(phase["endedMs"]) };
  });
  const exchanges = input["exchanges"].map((entry: unknown): InstallationExchange => {
    const exchange = record(entry, "installation exchange");
    exactKeys(exchange, ["kind", "count", "bytes", "requestMs", "maxRequestMs", "acknowledgeMs", "maxAcknowledgeMs", "failures", "lastFailure"]);
    const total = count(exchange["count"]);
    const failures = count(exchange["failures"]);
    const lastFailure = exchange["lastFailure"];
    if (failures > total || (lastFailure !== null && lastFailure !== "request" && lastFailure !== "acknowledge") || (failures === 0) !== (lastFailure === null)) invalid();
    return { kind: exchangeKind(exchange["kind"]), count: total, bytes: count(exchange["bytes"]),
      requestMs: milliseconds(exchange["requestMs"]), maxRequestMs: milliseconds(exchange["maxRequestMs"]),
      acknowledgeMs: milliseconds(exchange["acknowledgeMs"]), maxAcknowledgeMs: milliseconds(exchange["maxAcknowledgeMs"]), failures, lastFailure };
  });
  const requests = registry["requests"].map((entry: unknown): InstallationRegistryRequest => {
    const request = record(entry, "installation registry request");
    exactKeys(request, ["request", "startedMs", "headersMs", "reads", "bytes", "networkWaitMs", "maxNetworkWaitMs", "gapMs", "maxGapMs", "done"]);
    return { request: integer(request["request"], "installation registry request", 1, 0xffff_ffff), startedMs: milliseconds(request["startedMs"]),
      headersMs: request["headersMs"] === null ? null : milliseconds(request["headersMs"]), reads: count(request["reads"]), bytes: count(request["bytes"]),
      networkWaitMs: milliseconds(request["networkWaitMs"]), maxNetworkWaitMs: milliseconds(request["maxNetworkWaitMs"]),
      gapMs: milliseconds(request["gapMs"]), maxGapMs: milliseconds(request["maxGapMs"]), done: boolean(request["done"], "installation registry completion") };
  });
  let network: InstallationNetworkProfile | null = null;
  if (registry["network"] !== null) {
    const value = record(registry["network"], "installation network profile");
    exactKeys(value, ["creditWaitMs", "upstreamMs", "requests", "bytes"]);
    network = { creditWaitMs: milliseconds(value["creditWaitMs"]), upstreamMs: milliseconds(value["upstreamMs"]),
      requests: count(value["requests"]), bytes: count(value["bytes"]) };
  }
  return { installation: integer(input["installation"], "installation profile identity", 1, 0xffff_ffff), phases, exchanges,
    registry: { requests, dropped: count(registry["dropped"]), network }, gateway: gatewayLockfile(input["gateway"]) };
}

function gatewayLockfile(value: unknown): InstallationGatewayLockfile | null {
  if (value === null) return null;
  const lockfile = record(value, "installation gateway lockfile");
  if (lockfile["kind"] === "frozen") {
    exactKeys(lockfile, ["kind", "path", "packages"]);
    const path = string(lockfile["path"], "installation gateway lockfile path");
    if (path.length === 0 || path.length > 4096) invalid();
    return { kind: "frozen", path, packages: count(lockfile["packages"]) };
  }
  if (lockfile["kind"] !== "verbatim") invalid();
  exactKeys(lockfile, ["kind", "reason", "detail"]);
  const reason = string(lockfile["reason"], "installation gateway reason");
  if (!isVerbatimReason(reason)) return invalid();
  const detail = lockfile["detail"] === null ? null : string(lockfile["detail"], "installation gateway detail");
  if (detail !== null && detail.length > 256) invalid();
  return { kind: "verbatim", reason, detail };
}

function isVerbatimReason(value: string): value is InstallationGatewayVerbatimReason {
  return INSTALLATION_GATEWAY_VERBATIM_REASONS.some(known => known === value);
}
