import { VMError } from "../errors.js";
import type { WorkspaceStreamInput, WorkspaceStreamProducer } from "./workspace-stream.js";
import type { WorkspaceReadSelection } from "../protocol/workspace-read.js";
export type { WorkspaceReadSelection } from "../protocol/workspace-read.js";
export interface WorkspaceReadSource {
  readonly bytes: number;
  readonly read: (signal: AbortSignal) => AsyncGenerator<Uint8Array<ArrayBuffer>, void, unknown>;
}
export type WorkspaceReadLease = WorkspaceReadSelection<WorkspaceStreamInput> & { readonly retire: () => Promise<void> };

/** WorkspaceStore owns the common generation pin. This leaf retires all read
 * producers before returning that pin; unopened streams need no read handles. */
export function retainWorkspaceRead(selection: WorkspaceReadSelection<WorkspaceReadSource>, signal: AbortSignal,
  release: () => void, failed: (error: VMError) => void): WorkspaceReadLease {
  if (signal.aborted) throw new VMError("ABORTED", "Workspace read cancelled");
  const producers: WorkspaceStreamProducer[] = [];
  let closed = false;
  let retirement: Promise<void> | undefined;
  const open = (selected: WorkspaceReadSource): WorkspaceStreamInput => {
    let opened = false;
    return { bytes: selected.bytes, source: signal => {
      if (closed || opened) throw new VMError("ABORTED", "Workspace read source is retired or already consumed");
      opened = true;
      const cancellation = new AbortController();
      const abort = (): void => cancellation.abort();
      let uncertain: VMError | undefined;
      const frames = (async function* () {
        try { yield* selected.read(cancellation.signal); }
        catch (error) {
          if (error instanceof VMError && error.detail?.["cleanupFailed"] === true) {
            uncertain = error;
            failed(error);
          }
          throw error;
        }
      })();
      let retirement: Promise<void> | undefined;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const producer: WorkspaceStreamProducer = { frames, retire: () => retirement ??= (async () => {
        cancellation.abort();
        try {
          await frames.return(undefined);
          if (uncertain !== undefined) throw uncertain;
        }
        finally { signal.removeEventListener("abort", abort); }
      })() };
      producers.push(producer);
      return producer;
    } };
  };
  const retire = (): Promise<void> => {
    closed = true;
    return retirement ??= (async () => {
      signal.removeEventListener("abort", abort);
      const results = await Promise.allSettled(producers.map(producer => producer.retire()));
      if (results.some(result => result.status === "rejected")) {
        const error = new VMError("STORAGE_ERROR", "Workspace read retirement failed; reopen the VM", {
          reason: "workspace-read-retirement-failed", cleanupFailed: true,
        });
        failed(error);
        throw error;
      }
      release();
    })();
  };
  const abort = (): void => { void retire().catch(() => {}); };
  const lease = { generation: selection.generation,
    ...(selection.workspaceBaseSha256===undefined?{}:{workspaceBaseSha256:selection.workspaceBaseSha256}),
    ...(selection.snapshot === undefined ? {} : { snapshot: open(selection.snapshot) }),
    ...(selection.delta === undefined ? {} : { delta: open(selection.delta) }),
    ...(selection.dependencies === undefined ? {} : { dependencies: {
      generation: selection.dependencies.generation, inputsSha256: selection.dependencies.inputsSha256,
      tree: open(selection.dependencies.tree),
    } }), retire };
  signal.addEventListener("abort", abort, { once: true });
  return lease;
}
