import {VMError} from "../errors.js";
import type {WorkspaceReadRequest} from "../protocol/workspace-read.js";
import type {WorkspaceReadLease} from "./workspace-read.js";
import type {RootfsStore} from "./rootfs-store.js";
import type {WorkspaceSelections} from "./workspace-selections.js";
/** Both native storage ports resolve the same admitted source and immutable read lease. */
export function checkpointWorkspaceRead(rootfs:RootfsStore|undefined,selections:WorkspaceSelections|undefined,
 selection:NonNullable<WorkspaceReadRequest["selection"]>,base:string,signal:AbortSignal):Promise<WorkspaceReadLease|undefined> {
 switch(selection.kind) {
  case "workspace-base-file":if(rootfs===undefined)throw unavailable();return rootfs.openWorkspaceBaseFile(base,selection.path,selection.sha256,selection.bytes,signal);
  case "rootfs":if(rootfs===undefined)throw unavailable();return rootfs.openCachedFile(selection.path,selection.sha256,selection.bytes,signal,selection.snapshotId);
  case "retained":if(selections===undefined)throw unavailable();return selections.retainedWorkspace(selection.id,signal,selection.allowDifferentBase===true?undefined:base);
 }
}
function unavailable():VMError {return new VMError("FEATURE_NOT_AVAILABLE","Verified checkpoint workspace source is unavailable");}
