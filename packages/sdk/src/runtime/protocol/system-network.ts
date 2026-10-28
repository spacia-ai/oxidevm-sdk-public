import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeAssistanceBinding, decodeAssistanceSocketAddress, type AssistanceSocketAddress, type AssistanceBinding } from "./assistance.js";
import { validateAssistanceCredit, type AssistanceCredit } from "./assistance-credit.js";
import { PROTOCOL_VERSION } from "./common.js";

export interface RegistryFetchPolicy { readonly origin: string; readonly maximumBytes: number; readonly gatewayOrigin?: string }

/** The gateway policy control hands the network worker: the public fetch
 * policy plus, for a frozen install, the lockfile's registry versions per
 * package. Listed packages are served pruned to what pnpm's frozen
 * supply-chain checks read; unlisted packages and non-frozen installs stay
 * verbatim. Never accepted from the public SDK boundary. */
export interface RegistryGatewayPolicy extends RegistryFetchPolicy {
  readonly frozenVersions?: Readonly<Record<string, readonly string[]>>;
}

const FROZEN_PACKAGES = 65_536;
const FROZEN_VERSIONS_PER_PACKAGE = 64;
const PACKAGE_NAME = /^(?:@[A-Za-z0-9._-]{1,214}\/)?[A-Za-z0-9._-]{1,214}$/u;
const PACKAGE_VERSION = /^[0-9A-Za-z.+-]{1,256}$/u;

export function decodeRegistryGatewayPolicy(value: unknown): RegistryGatewayPolicy {
  const policy = record(value, "registry policy");
  if (!Object.hasOwn(policy, "frozenVersions")) return decodeRegistryFetchPolicy(policy);
  const { frozenVersions: raw, ...fetchPolicy } = policy;
  const base = decodeRegistryFetchPolicy(fetchPolicy);
  const table = record(raw, "frozen versions");
  const entries = Object.entries(table);
  if (entries.length > FROZEN_PACKAGES) throw new VMError("PROTOCOL_ERROR", "Frozen versions exceed their bound");
  const frozenVersions = Object.fromEntries(entries.map(([name, versions]) => {
    if (name.length > 214 || !PACKAGE_NAME.test(name)) throw new VMError("PROTOCOL_ERROR", "Invalid frozen package name");
    if (!Array.isArray(versions) || versions.length === 0 || versions.length > FROZEN_VERSIONS_PER_PACKAGE) {
      throw new VMError("PROTOCOL_ERROR", "Invalid frozen package versions");
    }
    const list = versions.map((version: unknown) => {
      if (typeof version !== "string" || !PACKAGE_VERSION.test(version)) throw new VMError("PROTOCOL_ERROR", "Invalid frozen package version");
      return version;
    });
    return [name, list] as const;
  }));
  return { ...base, frozenVersions };
}

export function decodeRegistryFetchPolicy(value: unknown): RegistryFetchPolicy {
  const policy = record(value, "registry policy");
  exactKeys(policy, ["origin", "maximumBytes", ...(Object.hasOwn(policy, "gatewayOrigin") ? ["gatewayOrigin"] : [])]);
  const origin = string(policy["origin"], "registry origin");
  if (origin.length > 512) throw new VMError("PROTOCOL_ERROR", "Invalid registry origin");
  let url: URL;
  try { url = new URL(origin); } catch { throw new VMError("PROTOCOL_ERROR", "Invalid registry origin"); }
  if (url.protocol !== "https:" || url.origin !== origin) throw new VMError("PROTOCOL_ERROR", "Invalid registry origin");
  const gatewayOrigin = Object.hasOwn(policy, "gatewayOrigin") ? string(policy["gatewayOrigin"], "registry gateway origin") : undefined;
  if (gatewayOrigin !== undefined) {
    let gateway: URL;
    try { gateway = new URL(gatewayOrigin); } catch { throw new VMError("PROTOCOL_ERROR", "Invalid registry gateway origin"); }
    if (gatewayOrigin.length > 64 || gateway.protocol !== "http:" || gateway.hostname !== "127.0.0.1" || gateway.origin !== gatewayOrigin) {
      throw new VMError("PROTOCOL_ERROR", "Invalid registry gateway origin");
    }
  }
  return { origin, maximumBytes: integer(policy["maximumBytes"], "registry size", 0, Number.MAX_SAFE_INTEGER),
    ...(gatewayOrigin === undefined ? {} : { gatewayOrigin }) };
}

type Envelope = AssistanceBinding & { readonly version: typeof PROTOCOL_VERSION; readonly sequence: number };
export type SystemListenerOperation =
  | { readonly kind: "task-open" | "task-close"; readonly process: number }
  | { readonly kind: "listener-open"; readonly process: number; readonly fd: number; readonly address: AssistanceSocketAddress }
  | { readonly kind: "listener-close"; readonly process: number; readonly fd: number };

export type SystemNetworkMessage = Envelope & (
  | SystemListenerOperation
  | { readonly kind: "bind"; readonly credits: readonly AssistanceCredit[]; readonly preview: MessagePort }
  | { readonly kind: "retired"; readonly credits: readonly AssistanceCredit[] }
  | { readonly kind: "registry" | "registry-attach"; readonly installation: number; readonly port: MessagePort; readonly credits: readonly AssistanceCredit[]; readonly policy: RegistryGatewayPolicy }
  | { readonly kind: "registry-retire"; readonly installation: number }
  | { readonly kind: "registry-retired"; readonly installation: number; readonly credits: readonly AssistanceCredit[] }
  | { readonly kind: "ping" | "pong" | "retire" }
);

export function decodeSystemNetworkMessage(value: unknown): SystemNetworkMessage {
  const input = record(value, "system network message");
  const kind = input["kind"];
  if (kind !== "task-open" && kind !== "task-close" && kind !== "listener-open" && kind !== "listener-close" && kind !== "registry" && kind !== "registry-attach" && kind !== "registry-retire" && kind !== "registry-retired" && kind !== "bind" && kind !== "retired" && kind !== "ping" && kind !== "pong" && kind !== "retire") {
    throw new VMError("PROTOCOL_ERROR", "Unknown system network message");
  }
  exactKeys(input, ["version", "kind", "session", "generation", "sequence", ...(kind === "task-open" || kind === "task-close" ? ["process"] : kind === "listener-open" ? ["process", "fd", "address"] : kind === "listener-close" ? ["process", "fd"] : kind === "registry" || kind === "registry-attach" ? ["credits", "installation", "port", "policy"] : kind === "registry-retire" ? ["installation"] : kind === "registry-retired" ? ["installation", "credits"] : kind === "bind" ? ["credits", "preview"] : kind === "retired" ? ["credits"] : [])]);
  integer(input["version"], "network protocol", PROTOCOL_VERSION, PROTOCOL_VERSION);
  const binding = decodeAssistanceBinding({ session: input["session"], generation: input["generation"] });
  const envelope: Envelope = { version: PROTOCOL_VERSION, ...binding, sequence: integer(input["sequence"], "network sequence", 1, 0xffff_ffff) };
  if (kind === "task-open" || kind === "task-close" || kind === "listener-open" || kind === "listener-close") {
    const process = integer(input["process"], "network process", 1, 0xffff_ffff);
    if (kind === "task-open" || kind === "task-close") return { ...envelope, kind, process };
    const fd = integer(input["fd"], "network descriptor", 1, 0xffff_ffff);
    if (kind === "listener-close") return { ...envelope, kind, process, fd };
    return { ...envelope, kind, process, fd, address: decodeAssistanceSocketAddress(input["address"]) };
  }
  if (kind === "ping" || kind === "pong" || kind === "retire") return { ...envelope, kind };
  if (kind === "registry-retire") return { ...envelope, kind, installation: integer(input["installation"], "installation", 1, 0xffff_ffff) };
  const values = input["credits"];
  if (!Array.isArray(values) || values.length !== 2) throw new VMError("PROTOCOL_ERROR", "Missing network grants");
  const credits = values.map((value: unknown) => validateAssistanceCredit(value, 6));
  if (credits.some(credit => credit.session !== binding.session || credit.generation !== binding.generation
    || credit.process !== null || credit.producer !== "network" || credit.kind !== (kind === "retired" || kind === "registry-retired" ? "return" : "grant"))
    || credits[0]?.pool === credits[1]?.pool || credits[0]?.reservation === credits[1]?.reservation
    || credits[0]?.sequence === credits[1]?.sequence) throw new VMError("PROTOCOL_ERROR", "Wrong network grant identity");
  if (kind === "registry-retired") return { ...envelope, kind, credits, installation: integer(input["installation"], "installation", 1, 0xffff_ffff) };
  if (kind === "registry" || kind === "registry-attach") {
    const port = input["port"];
    if (!(port instanceof MessagePort)) throw new VMError("PROTOCOL_ERROR", "Missing registry port");
    return { ...envelope, kind, credits, port, installation: integer(input["installation"], "installation", 1, 0xffff_ffff),
      policy: decodeRegistryGatewayPolicy(input["policy"]) };
  }
  if (kind === "bind") {
    const preview = input["preview"];
    if (!(preview instanceof MessagePort)) throw new VMError("PROTOCOL_ERROR", "Missing preview runtime port");
    return { ...envelope, kind, credits, preview };
  }
  return { ...envelope, kind, credits };
}
