import type { UserspaceStorageClient } from "./userspace-storage-channel.js";
import { VMError } from "../errors.js";
import type { WorkspaceReadRequest, WorkspaceReadSelection } from "../protocol/workspace-read.js";
import type { UserspaceReconcile, ReconcileHost, ReconcileSource, NativeWorkspaceReconciled } from "./userspace-checkpoint.js";
import { active } from "./userspace-checkpoint/stream.js";
import { workspaceBytesInput } from "./workspace-stream.js";
import type { WorkspaceStreamInput } from "./workspace-stream.js";

type Selection = NonNullable<WorkspaceReadRequest["selection"]>;
interface Read { readonly selection: WorkspaceReadSelection<WorkspaceStreamInput> | undefined; retire(): Promise<void> }
type Open = (selection: Selection, base?:string) => Promise<Read>;
type Transfer = Pick<UserspaceReconcile, "source" | "feed" | "sourceComplete" | "plan" | "host" | "apply" | "replay" | "replayFeed" | "replayComplete" | "hostFeed" | "hostComplete" | "finish">;
export type NativeWorkspaceSelection = { readonly retainedId: string; readonly workspaceBaseSha256: string } & (
  | { readonly kind: "restore"; readonly snapshotId: string }
  | { readonly kind: "cold" }
);

/** The storage worker retains both selected generations for the surrounding restore
 * transaction. Each pass acquires its own immutable read lease and returns its credit. */
export function nativeReconcileReads(storage: Pick<UserspaceStorageClient, "workspaceTransfers">, base: string, signal: AbortSignal): Open {
  return (selection, requestedBase = base) => {
    active(signal);
    return storage.workspaceTransfers.read(requestedBase, signal, selection);
  };
}

export async function reconcileWorkspaceStreams(transfer: Transfer, base: WorkspaceStreamInput, open: Open,
  selection: NativeWorkspaceSelection, signal: AbortSignal, inspectBase:(base:string)=>Promise<{readonly metadata:Uint8Array}|undefined>): Promise<NativeWorkspaceReconciled> {
  let currentBase=selection.workspaceBaseSha256;
  let foreignBase:WorkspaceStreamInput|undefined;
  await index(transfer, 0, base, signal);
  if (selection.kind === "restore") await using(open, { kind: "retained", id: selection.snapshotId }, async read => {
    if (read?.snapshot !== undefined) await index(transfer, 1, read.snapshot, signal);
    if (read?.delta !== undefined) await index(transfer, 2, read.delta, signal);
  });
  await using(open, { kind: "retained", id: selection.retainedId,allowDifferentBase:true }, async read => {
    if(read!==undefined&&read.workspaceBaseSha256===undefined)throw new VMError("PROTOCOL_ERROR","Retained workspace source omitted its base identity");
    currentBase=read?.workspaceBaseSha256??selection.workspaceBaseSha256;
    if(currentBase!==selection.workspaceBaseSha256) {
      const verified=await inspectBase(currentBase);
      if(verified===undefined) {
        const empty=new Uint8Array(12);empty.set([79,88,82,70,5,0]);await index(transfer,6,workspaceBytesInput(empty),signal);
      } else {foreignBase=workspaceBytesInput(verified.metadata);await index(transfer,5,foreignBase,signal);}
    }
    if (read?.snapshot !== undefined) await index(transfer, 3, read.snapshot, signal);
    if (read?.delta !== undefined) await index(transfer, 4, read.delta, signal);
  });
  active(signal); const required = transfer.plan();
  // Cached-file admission verifies its entire digest before granting a lease. Do this
  // for every required base file before the first native truncate or unlink.
  for (let index = 0; index < required.hosts; index++) {
    const host = transfer.host(index);
    await using(open, hostSelection(host,selection), read => { hostInput(read, host); },host.source===5?currentBase:undefined);
  }
  active(signal); transfer.apply();
  for (const source of required.sources) {
    const replay = async (input: WorkspaceStreamInput): Promise<void> => {
      active(signal); transfer.replay(source);
      await frames(input, bytes => { transfer.replayFeed(bytes); }, signal); transfer.replayComplete();
    };
    if (source === 0) await replay(base);
    else if(source===5) {if(foreignBase===undefined)throw new VMError("STORAGE_ERROR","Foreign base replay disappeared");await replay(foreignBase); }
    else await using(open, { kind: "retained", id: source < 3 ? ancestor(selection) : selection.retainedId }, async read => {
      const input = source === 1 || source === 3 ? read?.snapshot : read?.delta;
      if (input === undefined) throw new VMError("STORAGE_ERROR", "Retained workspace replay source disappeared");
      await replay(input);
    },source<3?undefined:currentBase);
  }
  for (let index = 0; index < required.hosts; index++) {
    const host = transfer.host(index);
    await using(open, hostSelection(host,selection), async read => {
      let offset = 0;
      await frames(hostInput(read, host), bytes => { transfer.hostFeed(host.identity, offset, bytes); offset += bytes.length; }, signal);
      transfer.hostComplete(host.identity);
    },host.source===5?currentBase:undefined);
  }
  active(signal); return transfer.finish();
}
async function index(transfer: Transfer, source: ReconcileSource, input: WorkspaceStreamInput, signal: AbortSignal): Promise<void> {
  active(signal); transfer.source(source, input.bytes);
  await frames(input, bytes => { transfer.feed(bytes); }, signal); transfer.sourceComplete();
}
function hostSelection(host: ReconcileHost, selection: NativeWorkspaceSelection): Selection { return host.source===5 ? {kind:"workspace-base-file",path:host.path,sha256:host.sha256,bytes:host.length} : { kind: "rootfs", path: host.path, sha256: host.sha256, bytes: host.length, ...(selection.kind === "restore" ? {snapshotId:selection.snapshotId} : {}) }; }
function ancestor(selection: NativeWorkspaceSelection): string { if (selection.kind !== "restore") throw new VMError("PROTOCOL_ERROR", "Cold reconciliation requested an ancestor checkpoint"); return selection.snapshotId; }
function hostInput(read: WorkspaceReadSelection<WorkspaceStreamInput> | undefined, host: ReconcileHost): WorkspaceStreamInput {
  const input = read?.snapshot;
  if (input === undefined || input.bytes !== host.length || read?.delta !== undefined) throw new VMError("STORAGE_ERROR", "Verified base-file read does not match native reconciliation");
  return input;
}
async function using(open: Open, selection: Selection, operation: (read: Read["selection"]) => void | Promise<void>,base?:string): Promise<void> {
  const read = await open(selection,base);
  let failure:{readonly error:unknown}|undefined;
  try {await operation(read.selection);}catch(error){failure={error};}
  try {await read.retire();}
  catch {throw new VMError("STORAGE_ERROR","Workspace reconciliation read retirement is uncertain",{cleanupFailed:true});}
  if(failure!==undefined)throw failure.error;
}
async function frames(input: WorkspaceStreamInput, consume: (bytes: Uint8Array) => void, signal: AbortSignal): Promise<void> {
  active(signal); const producer = input.source(signal); let received = 0;
  let failure:{readonly error:unknown}|undefined;
  try {
    for await (const frame of producer.frames) {
      active(signal);
      if (frame.length === 0 || frame.length > 65536 || frame.length > input.bytes - received) throw new VMError("PROTOCOL_ERROR", "Invalid workspace reconciliation frame");
      consume(frame); received += frame.length;
    }
    if (received !== input.bytes) throw new VMError("STORAGE_ERROR", "Workspace reconciliation source was truncated");
  }catch(error){failure={error};}
  try {await producer.retire();}
  catch {throw new VMError("STORAGE_ERROR","Workspace reconciliation producer did not retire",{cleanupFailed:true});}
  if(failure!==undefined)throw failure.error;
}
