import { VMError } from "../errors.js";
import { encodeAssistanceCredit, type AssistanceCredit } from "../protocol/assistance-credit.js";
import { decodeWorkspaceReadRequest, decodeWorkspaceReadSelection, type WorkspaceReadIdentity, type WorkspaceReadKind, type WorkspaceReadRequest, type WorkspaceReadSelection } from "../protocol/workspace-read.js";
import { publicationCredit } from "../protocol/workspace-publication.js";
import type { WorkspaceStorageRequest } from "./snapshot-channel.js";
import { retainWorkspaceRead, type WorkspaceReadLease, type WorkspaceReadSource } from "./workspace-read.js";
import type { WorkspaceStreamInput } from "./workspace-stream.js";

/** Data EOF and per-source retirement precede native commit. The shared storage
 * grant returns only after the selected generation's final retirement receipt. */
export interface WorkspaceReadClient {
  request(request: WorkspaceStorageRequest, transfer?: Transferable[], signal?: AbortSignal): Promise<unknown>;
}

export async function openWorkspaceRead(client: WorkspaceReadClient, input: WorkspaceReadRequest, signal: AbortSignal): Promise<{
  readonly selection: WorkspaceReadSelection<WorkspaceStreamInput> | undefined;
  retire(): Promise<AssistanceCredit>;
}> {
  input = decodeWorkspaceReadRequest(input);
  const identity = { session: input.credit.session, generation: input.credit.generation, transfer: input.credit.reservation };
  let lease: WorkspaceReadLease | undefined;
  let retirement: Promise<AssistanceCredit> | undefined;
  const retire = (): Promise<AssistanceCredit> => retirement ??= (async () => {
    signal.removeEventListener("abort", abort);
    await lease?.retire();
    const returned = publicationCredit(await client.request({ type: "retire-workspace-read", identity }), "return");
    const expected = encodeAssistanceCredit({ ...input.credit, kind: "return" }, 7);
    const actual = encodeAssistanceCredit(returned, 7);
    if (expected.length !== actual.length || expected.some((byte, offset) => byte !== actual[offset])) {
      throw new VMError("PROTOCOL_ERROR", "Workspace read returned another reservation", { cleanupFailed: true });
    }
    return returned;
  })();
  const abort = (): void => { void retire().catch(() => {}); };
  try {
    const selected = decodeWorkspaceReadSelection(await client.request({ type: "open-workspace-read", input }, [], signal));
    if (selected !== undefined) lease = receiveWorkspaceRead(client, identity, selected, signal);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return { selection: lease, retire };
  } catch (error) {
    try { await retire(); }
    catch { throw new VMError("STORAGE_ERROR", "Workspace read admission retirement failed", { cleanupFailed: true }); }
    // The caller still owns the reservation. A confirmed return accompanies
    // this failure so admission errors cannot silently leak VM capacity.
    throw new VMError(error instanceof VMError ? error.code : "STORAGE_ERROR",
      error instanceof Error ? error.message : "Workspace read failed", { ...(error instanceof VMError ? error.detail : {}), readRetired: true });
  }
}

/** Both committed reopen and staged activation use the same byte and source
 * retirement protocol. The caller owns the distinct final grant receipt. */
export function receiveWorkspaceRead(client: WorkspaceReadClient, identity: WorkspaceReadIdentity,
  selected: WorkspaceReadSelection<number>, signal: AbortSignal): WorkspaceReadLease {
  const source = (kind: WorkspaceReadKind, bytes: number): WorkspaceReadSource => ({ bytes, read: async function* (signal) {
    let offset = 0;
    try {
      for (;;) {
        const value = await client.request({ type: "read-workspace-frame", identity, source: kind, offset }, [], signal);
        if (value === undefined) {
          if (offset !== bytes) throw new VMError("STORAGE_ERROR", "Workspace read ended before its declared length");
          return;
        }
        if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer) || value.byteOffset !== 0
          || value.byteLength !== value.buffer.byteLength || value.length < 1 || value.length > 65536 || value.length > bytes - offset) {
          throw new VMError("PROTOCOL_ERROR", "Invalid workspace read response");
        }
        offset += value.length;
        yield new Uint8Array(value.buffer);
      }
    } finally {
      await client.request({ type: "retire-workspace-source", identity, source: kind }).then(value => {
        if (value !== undefined) throw new VMError("PROTOCOL_ERROR", "Invalid workspace source retirement receipt");
      }).catch(() => {
        throw new VMError("STORAGE_ERROR", "Workspace read source retirement failed", { cleanupFailed: true });
      });
    }
  } });
  return retainWorkspaceRead({ generation: selected.generation,
      ...(selected.workspaceBaseSha256===undefined?{}:{workspaceBaseSha256:selected.workspaceBaseSha256}),
      ...(selected.snapshot === undefined ? {} : { snapshot: source("snapshot", selected.snapshot) }),
      ...(selected.delta === undefined ? {} : { delta: source("delta", selected.delta) }),
      ...(selected.dependencies === undefined ? {} : { dependencies: { ...selected.dependencies, tree: source("dependencies", selected.dependencies.tree) } }),
    }, signal, () => {}, () => {});
}
