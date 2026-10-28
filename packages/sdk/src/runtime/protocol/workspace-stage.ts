import { exactKeys, record } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeWorkspacePublicationResult, type WorkspacePublicationResult } from "./workspace-publication.js";
import { decodeWorkspaceReadSelection, type WorkspaceReadSelection } from "./workspace-read.js";

/** A staged receipt retains the original storage grant. Only a finished
 * publication with confirmed retirement can return that reservation. */
export type WorkspaceStageResult =
  | { readonly kind: "staged"; readonly selection: WorkspaceReadSelection<number> }
  | { readonly kind: "finished"; readonly result: WorkspacePublicationResult };

export function decodeWorkspaceStageResult(value: unknown): WorkspaceStageResult {
  const input = record(value, "workspace staging result");
  if (input["kind"] === "staged") {
    exactKeys(input, ["kind", "selection"]);
    const selection = decodeWorkspaceReadSelection(input["selection"]);
    if (selection === undefined) throw new VMError("PROTOCOL_ERROR", "Missing staged workspace selection");
    return { kind: "staged", selection };
  }
  if (input["kind"] === "finished") {
    exactKeys(input, ["kind", "result"]);
    const result = decodeWorkspacePublicationResult(input["result"]);
    if (result.outcome.kind !== "failed") throw new VMError("PROTOCOL_ERROR", "Staging cannot commit a workspace");
    return { kind: "finished", result };
  }
  throw new VMError("PROTOCOL_ERROR", "Invalid workspace staging result");
}
