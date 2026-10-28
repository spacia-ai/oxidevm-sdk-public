import { exactKeys, integer, record, string } from "../decode.js";
import { decodeSerializedError, VMError, type SerializedError } from "../errors.js";
import { decodeAssistanceBinding, type AssistanceBinding } from "./assistance.js";
import { validateAssistanceCredit, type AssistanceCredit } from "./assistance-credit.js";
import { PROTOCOL_VERSION } from "./common.js";

export const WORKSPACE_PUBLICATION_BYTES = 8 * 1024 * 1024;
export interface WorkspaceTransferDescriptor {
  readonly version: typeof PROTOCOL_VERSION;
  readonly binding: AssistanceBinding;
  readonly transfer: number;
  readonly bytes: number;
  readonly stream: ReadableStream<unknown>;
  readonly retirementPort: MessagePort;
}
export interface WorkspaceSnapshotReuse { readonly reuse: number }
export interface WorkspacePublication {
  readonly workspaceBaseSha256: string;
  readonly credit: AssistanceCredit;
  readonly snapshot: WorkspaceTransferDescriptor | WorkspaceSnapshotReuse;
  readonly delta: WorkspaceTransferDescriptor;
  readonly dependencies?: { readonly inputsSha256: string; readonly tree: WorkspaceTransferDescriptor };
}
export function workspacePublicationTransfers(input: WorkspacePublication): readonly WorkspaceTransferDescriptor[] {
  return [...("reuse" in input.snapshot ? [] : [input.snapshot]), input.delta,
    ...(input.dependencies === undefined ? [] : [input.dependencies.tree])];
}
export type WorkspacePublicationResult = {
  readonly outcome: { readonly kind: "committed"; readonly generation: number; readonly dependencyGeneration?: string }
    | { readonly kind: "failed"; readonly error: SerializedError };
} & ({ readonly retired: true; readonly credit: AssistanceCredit } | { readonly retired: false });

export function decodeWorkspaceTransfer(value: unknown): WorkspaceTransferDescriptor {
  const input = record(value, "workspace transfer");
  exactKeys(input, ["version", "binding", "transfer", "bytes", "stream", "retirementPort"]);
  if (input["version"] !== PROTOCOL_VERSION || !(input["stream"] instanceof ReadableStream)
    || !(input["retirementPort"] instanceof MessagePort)) return invalid();
  const stream: ReadableStream<unknown> = input["stream"];
  return { version: PROTOCOL_VERSION, binding: decodeAssistanceBinding(input["binding"]),
    transfer: integer(input["transfer"], "workspace transfer", 1, 0xffff_ffff),
    bytes: integer(input["bytes"], "workspace stream bytes", 0, 1024 ** 4), stream,
    retirementPort: input["retirementPort"] };
}
export function decodeWorkspacePublication(value: unknown): WorkspacePublication {
  const input = record(value, "workspace publication");
  exactKeys(input, ["workspaceBaseSha256", "credit", "snapshot", "delta"], ["dependencies"]);
  const credit = publicationCredit(input["credit"], "grant");
  const transfers: WorkspaceTransferDescriptor[] = [];
  const transfer = (value: unknown): WorkspaceTransferDescriptor => {
    const result = decodeWorkspaceTransfer(value);
    if (result.binding.session !== credit.session || result.binding.generation !== credit.generation
      || transfers.some(prior => prior.transfer === result.transfer || prior.stream === result.stream || prior.retirementPort === result.retirementPort)) return invalid();
    transfers.push(result);
    return result;
  };
  const candidate = record(input["snapshot"], "workspace snapshot");
  let snapshot: WorkspacePublication["snapshot"];
  if (Object.hasOwn(candidate, "reuse")) {
    exactKeys(candidate, ["reuse"]);
    snapshot = { reuse: integer(candidate["reuse"], "workspace snapshot generation", 1) };
  } else snapshot = transfer(candidate);
  const delta = transfer(input["delta"]);
  let dependencies: WorkspacePublication["dependencies"];
  if (input["dependencies"] !== undefined) {
    const dep = record(input["dependencies"], "dependency publication");
    exactKeys(dep, ["inputsSha256", "tree"]);
    dependencies = { inputsSha256: hash(dep["inputsSha256"]), tree: transfer(dep["tree"]) };
  }
  return { workspaceBaseSha256: hash(input["workspaceBaseSha256"]), credit, snapshot, delta,
    ...(dependencies === undefined ? {} : { dependencies }) };
}
export function decodeWorkspacePublicationResult(value: unknown): WorkspacePublicationResult {
  const input = record(value, "workspace publication result");
  const retired = input["retired"];
  if (retired !== true && retired !== false) return invalid();
  exactKeys(input, retired ? ["retired", "credit", "outcome"] : ["retired", "outcome"]);
  const result = record(input["outcome"], "workspace publication outcome");
  let outcome: WorkspacePublicationResult["outcome"];
  if (result["kind"] === "committed" && retired) {
    exactKeys(result, ["kind", "generation"], ["dependencyGeneration"]);
    outcome = { kind: "committed", generation: integer(result["generation"], "workspace generation", 1),
      ...(result["dependencyGeneration"] === undefined ? {} : { dependencyGeneration: hash(result["dependencyGeneration"]) }) };
  } else if (result["kind"] === "failed") {
    exactKeys(result, ["kind", "error"]);
    outcome = { kind: "failed", error: decodeSerializedError(result["error"]) };
  } else return invalid();
  return retired ? { retired, credit: publicationCredit(input["credit"], "return"), outcome } : { retired, outcome };
}
export function publicationCredit(value: unknown, kind: "grant" | "return"): AssistanceCredit {
  const credit = validateAssistanceCredit(value, 6);
  if (credit.kind !== kind || credit.producer !== "storage" || credit.pool !== "data"
    || credit.bytes !== WORKSPACE_PUBLICATION_BYTES || credit.entries !== 1) return invalid();
  return credit;
}
function hash(value: unknown): string {
  const result = string(value, "workspace SHA-256");
  if (!/^[0-9a-f]{64}$/u.test(result)) return invalid();
  return result;
}
function invalid(): never { throw new VMError("PROTOCOL_ERROR", "Invalid workspace publication transfer"); }
