import { decodeBuildScriptDecisions, type BuildScriptDecision } from "./build-script-approval.js";
import { validateAssistanceCredit, type AssistanceCredit } from "./assistance-credit.js";
import { boolean, exactKeys, integer, record, string } from "../decode.js";
import { normalizeWorkspacePath } from "../workspace-path.js";
import { VMError } from "../errors.js";
import { ASSISTANCE_LIMITS, decodeAssistanceBinding, decodeAssistanceOperation, type AssistanceBinding } from "./assistance.js";
import { decodeAgentPath, decodeAgentSpawnResult, type AgentSpawnResult } from "./agent.js";
import { decodeUndefined } from "./decoders.js";
import { PROTOCOL_VERSION } from "./common.js";
import { decodeAssistanceArtifacts, type AssistanceArtifacts } from "../assistance-artifacts.js";
import { decodeInstallationProfile, type InstallationProfile } from "./assistance-installation-profile.js";

export { decodeAssistanceBinding, type AssistanceBinding } from "./assistance.js";
export interface AssistanceSpawnInput {
  readonly workspaceBaseSha256?: string;
  readonly entry: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly port: MessagePort;
}
export interface AssistancePreparation extends AssistanceBinding { readonly credits?: readonly AssistanceCredit[] }
export function decodeAssistancePreparation(value: unknown): AssistancePreparation {
  const input = record(value, "assistance preparation");
  exactKeys(input, ["session", "generation"], ["credits"]);
  const binding = decodeAssistanceBinding({ session: input["session"], generation: input["generation"] });
  const values: unknown = input["credits"];
  if (values === undefined) return binding;
  if (!Array.isArray(values) || values.length !== 2) throw new VMError("PROTOCOL_ERROR", "Invalid bootstrap credits");
  const credits = values.map((value: unknown) => validateAssistanceCredit(value));
  if (credits.some(credit => credit.kind !== "grant" || credit.producer !== "bootstrap" || credit.pool !== "data"
    || credit.session !== binding.session || credit.generation !== binding.generation)
    || credits[0]?.reservation === credits[1]?.reservation || credits[0]?.sequence === credits[1]?.sequence) {
    throw new VMError("PROTOCOL_ERROR", "Invalid preparation credit binding");
  }
  return { ...binding, credits };
}
export interface AssistanceControlOperations {
  readonly "assistance-build-policy": { readonly request: { readonly workspaceBaseSha256: string; readonly decisions: readonly BuildScriptDecision[] }; readonly response: undefined };
  readonly "assistance-install": { readonly request: { readonly cwd: string; readonly frozenLockfile: boolean; readonly workspaceBaseSha256: string; readonly port: MessagePort }; readonly response: undefined };
  readonly "assistance-network-attach": { readonly request: { readonly port: MessagePort }; readonly response: undefined };
  readonly "assistance-network-failed": { readonly request: undefined; readonly response: undefined };
  readonly "assistance-status": { readonly request: undefined; readonly response: AssistanceBinding };
  readonly "assistance-prepare": { readonly request: undefined; readonly response: AssistancePreparation };
  readonly "assistance-attach": { readonly request: AssistanceBinding & { readonly port: MessagePort; readonly artifacts: AssistanceArtifacts; readonly receipt?: AssistanceCredit }; readonly response: undefined };
  readonly "assistance-bootstrap-release": { readonly request: AssistanceBinding & { readonly reservation: number }; readonly response: undefined };
  readonly "assistance-spawn": { readonly request: AssistanceSpawnInput; readonly response: AgentSpawnResult };
  readonly "assistance-input": { readonly request: { readonly process: number; readonly bytes: Uint8Array<ArrayBuffer> | null }; readonly response: undefined };
  readonly "assistance-stop": { readonly request: { readonly process: number; readonly signal: "TERM" | "KILL" | "INT" | "HUP" }; readonly response: undefined };
  readonly "assistance-dispose": { readonly request: undefined; readonly response: undefined };
  readonly "assistance-installation-profile": { readonly request: undefined; readonly response: InstallationProfile | undefined };
}
type Base = { readonly id: number; readonly version: typeof PROTOCOL_VERSION };
export type AssistanceControlRequest = {
  [K in keyof AssistanceControlOperations]: Base & { readonly type: K } &
    (AssistanceControlOperations[K]["request"] extends undefined ? object : AssistanceControlOperations[K]["request"])
}[keyof AssistanceControlOperations];

export const assistanceResponseDecoders = {
  "assistance-build-policy": decodeUndefined,
  "assistance-install": decodeUndefined,
  "assistance-network-attach": decodeUndefined,
  "assistance-network-failed": decodeUndefined,
  "assistance-status": decodeAssistanceBinding,
  "assistance-prepare": decodeAssistancePreparation,
  "assistance-bootstrap-release": decodeUndefined,
  "assistance-attach": decodeUndefined,
  "assistance-spawn": decodeAgentSpawnResult,
  "assistance-stop": decodeUndefined,
  "assistance-input": decodeUndefined,
  "assistance-dispose": decodeUndefined,
  "assistance-installation-profile": (value: unknown): InstallationProfile | undefined => value === undefined ? undefined : decodeInstallationProfile(value),
};

export function isAssistanceControl(type: string): type is keyof AssistanceControlOperations {
  return type === "assistance-build-policy" || type === "assistance-install" || type === "assistance-network-attach" || type === "assistance-network-failed" || type === "assistance-status" || type === "assistance-bootstrap-release" || type === "assistance-prepare" || type === "assistance-attach" || type === "assistance-spawn"
    || type === "assistance-stop" || type === "assistance-input" || type === "assistance-dispose" || type === "assistance-installation-profile";
}
export function decodeAssistanceControl(value: unknown): AssistanceControlRequest {
  const input = record(value, "assistance control request");
  const id = integer(input["id"], "request id", 1);
  integer(input["version"], "protocol version", PROTOCOL_VERSION, PROTOCOL_VERSION);
  const base: Base = { id, version: PROTOCOL_VERSION };
  const type = string(input["type"], "assistance control operation");
  switch (type) {
    case "assistance-status": case "assistance-prepare": case "assistance-dispose": case "assistance-network-failed": case "assistance-installation-profile":
      exactKeys(input, ["id", "version", "type"]);
      return { ...base, type };
    case "assistance-network-attach":
      exactKeys(input, ["id", "version", "type", "port"]);
      return { ...base, type, port: port(input["port"]) };
    case "assistance-bootstrap-release": {
      exactKeys(input, ["id", "version", "type", "session", "generation", "reservation"]);
      return { ...base, type, ...decodeAssistanceBinding({ session: input["session"], generation: input["generation"] }),
        reservation: integer(input["reservation"], "bootstrap reservation", 1, 0xffff_ffff) };
    }
    case "assistance-attach": {
      exactKeys(input, ["id", "version", "type", "session", "generation", "port", "artifacts"], ["receipt"]);
      return { ...base, type, ...decodeAssistanceBinding({ session: input["session"], generation: input["generation"] }), port: port(input["port"]), artifacts: decodeAssistanceArtifacts(input["artifacts"]),
        ...(input["receipt"] === undefined ? {} : { receipt: validateAssistanceCredit(input["receipt"]) }) };
    }
    case "assistance-build-policy": {
      exactKeys(input, ["id", "version", "type", "workspaceBaseSha256", "decisions"]);
      const workspaceBaseSha256 = string(input["workspaceBaseSha256"], "workspace base identity");
      if (!/^[a-f0-9]{64}$/u.test(workspaceBaseSha256)) throw new VMError("PROTOCOL_ERROR", "Invalid workspace base identity");
      return { ...base, type, workspaceBaseSha256, decisions: decodeBuildScriptDecisions(input["decisions"]) };
    }
    case "assistance-install": {
      exactKeys(input, ["id", "version", "type", "cwd", "frozenLockfile", "workspaceBaseSha256", "port"]);
      const baseHash = string(input["workspaceBaseSha256"], "workspace base identity");
      if (!/^[a-f0-9]{64}$/u.test(baseHash)) throw new VMError("PROTOCOL_ERROR", "Invalid workspace base identity");
      return { ...base, type, cwd: `/${normalizeWorkspacePath(decodeAgentPath(input["cwd"])).join("/")}`,
        frozenLockfile: boolean(input["frozenLockfile"], "frozen installation"), workspaceBaseSha256: baseHash, port: port(input["port"]) };
    }
    case "assistance-spawn": {
      exactKeys(input, ["id", "version", "type", "entry", "cwd", "args", "env", "port"], ["workspaceBaseSha256"]);
      const workspaceBaseSha256 = input["workspaceBaseSha256"];
      if (workspaceBaseSha256 !== undefined && (typeof workspaceBaseSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(workspaceBaseSha256))) throw new VMError("PROTOCOL_ERROR", "Invalid workspace base identity");
      const startup = decodeAssistanceOperation({ kind: "spawn", command: input["entry"],
        cwd: `/${normalizeWorkspacePath(decodeAgentPath(input["cwd"])).join("/")}`, args: input["args"], env: input["env"] });
      if (startup.kind !== "spawn" || startup.command.startsWith("-")) throw new VMError("PROTOCOL_ERROR", "Invalid assisted script entrypoint");
      return { ...base, type, entry: startup.command, cwd: startup.cwd, args: startup.args, env: startup.env, port: port(input["port"]),
        ...(workspaceBaseSha256 === undefined ? {} : { workspaceBaseSha256 }) };
    }
    case "assistance-input": {
      exactKeys(input, ["id", "version", "type", "process", "bytes"]);
      const bytes = input["bytes"];
      if (bytes !== null && (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.length > ASSISTANCE_LIMITS.chunk)) {
        throw new VMError("PROTOCOL_ERROR", "Invalid assisted stdin bytes");
      }
      return { ...base, type, process: integer(input["process"], "assisted process", 1, 0xffff_ffff), bytes: bytes === null ? null : bytes.slice() };
    }
    case "assistance-stop": {
      exactKeys(input, ["id", "version", "type", "process", "signal"]);
      const signal = input["signal"];
      if (signal !== "TERM" && signal !== "KILL" && signal !== "INT" && signal !== "HUP") throw new VMError("PROTOCOL_ERROR", "Invalid assistance signal");
      return { ...base, type, process: integer(input["process"], "assisted process", 1, 0xffff_ffff), signal };
    }
    default: throw new VMError("PROTOCOL_ERROR", "Unknown assistance control operation");
  }
}
function port(value: unknown): MessagePort {
  if (!(value instanceof MessagePort)) throw new VMError("PROTOCOL_ERROR", "Invalid assistance port");
  return value;
}
