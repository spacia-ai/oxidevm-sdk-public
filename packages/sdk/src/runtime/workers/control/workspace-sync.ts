import { deserializeError, serializeUnknownError, VMError } from "../../errors.js";
import type { AssistanceBinding } from "../../protocol/assistance.js";
import type { SnapshotStorageClient } from "../snapshot-channel.js";
import type { AssistanceTraffic } from "./assistance-traffic.js";
import type { GuestAgent } from "./guest-agent.js";
import { publishWorkspaceCaptures } from "../workspace-publication-client.js";
import type { WorkspaceStreamInput } from "../workspace-stream.js";
import { emptyCaptureCounts, type CaptureCounts } from "../../protocol/workspace-capture.js";

/** The waits a synchronization performs: opening each guest capture,
 * publishing through storage, and retiring the captures. Each is bounded and
 * names itself, so a stalled flush reports its owner instead of hanging. */
export type SynchronizationStep = "capture-open" | "publish" | "capture-retire" | "filesystem-sync";
export const SYNCHRONIZATION_STEP_MS = 45_000;

type SynchronizationProgress = { readonly frames: number;
  readonly captures?: { readonly snapshot: CaptureCounts; readonly delta: CaptureCounts } };

function copyProgress(progress: SynchronizationProgress): SynchronizationProgress {
  return { frames: progress.frames, ...(progress.captures === undefined ? {} : {
    captures: { snapshot: { ...progress.captures.snapshot }, delta: { ...progress.captures.delta } },
  }) };
}

/** Actual completed native entries and stream frames keep a capture alive.
 * Repeated counts do not renew the silence bound. */
export function boundedByProgress<T>(work: Promise<T>, step: SynchronizationStep, ms: number,
  progress: SynchronizationProgress): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let seen = JSON.stringify(copyProgress(progress));
    const timer = setInterval(() => {
      const current = copyProgress(progress), identity = JSON.stringify(current);
      if (identity !== seen) { seen = identity; return; }
      clearInterval(timer);
      reject(new VMError("STORAGE_ERROR", "Workspace synchronization stalled", { step, afterMs: ms, ...current }));
    }, ms);
    work.then(value => { clearInterval(timer); resolve(value); }, (error: unknown) => { clearInterval(timer); reject(deserializeError(serializeUnknownError(error))); });
  });
}

/** Counts every frame a capture yields so the publication bound sees progress. */
function withProgress(input: WorkspaceStreamInput, progress: { frames: number }): WorkspaceStreamInput {
  return { bytes: input.bytes, source(signal) {
    const source = input.source(signal);
    return { retire: () => source.retire(), frames: (async function* () {
      for await (const frame of source.frames) { progress.frames += 1; yield frame; }
    })() };
  } };
}

/** Called after idle admission or task retirement. Capture and storage publication
 * retain their owners, bounds, receipts and dependency generation. */
export async function synchronizeWorkspace(agent: Pick<GuestAgent, "supportsStreamedRestore" | "captureWorkspace" | "syncFilesystems">,
  storage: SnapshotStorageClient, traffic: AssistanceTraffic,
  options: { readonly binding: AssistanceBinding; readonly base: string; readonly requestId: number; readonly signal: AbortSignal; readonly stepMs?: number },
): Promise<boolean> {
  if (!agent.supportsStreamedRestore) return false;
  const stepMs = options.stepMs ?? SYNCHRONIZATION_STEP_MS;
  const progress = { frames: 0, captures: { snapshot: emptyCaptureCounts(), delta: emptyCaptureCounts() } };
  const cancellation = new AbortController();
  const abort = () => { cancellation.abort(); };
  if (options.signal.aborted) abort();
  else options.signal.addEventListener("abort", abort, { once: true });
  // The native agent plans the two formats serially; both waits observe the same work.
  const openings = (["snapshot", "delta"] as const).map(format => Promise.resolve().then(() =>
    agent.captureWorkspace(options.requestId, format, cancellation.signal, event => {
        if (event === undefined) progress.frames += 1;
        else progress.captures[format][event.phase] = event.entries;
    })));
  let failure: { readonly error: unknown } | undefined;
  try {
    const [snapshot, delta] = await Promise.all(openings.map(work => boundedByProgress(work, "capture-open", stepMs, progress)));
    if (snapshot === undefined || delta === undefined) throw new VMError("PROTOCOL_ERROR", "Workspace captures are missing");
    if (options.signal.aborted) throw new VMError("ABORTED", "Workspace synchronization cancelled");
    const result = await boundedByProgress(publishWorkspaceCaptures((publication, signal) => storage.publishWorkspace(publication, signal), { binding: options.binding,
      workspaceBaseSha256: options.base, snapshot: withProgress(snapshot, progress), delta: withProgress(delta, progress) },
    traffic, cancellation.signal), "publish", stepMs, progress);
    if (result.outcome.kind === "failed") throw deserializeError(result.outcome.error);
  } catch (error) { failure = { error }; }
  if (failure !== undefined) abort();
  // Even an opening that finishes after its bound still has to retire.
  const retired = await Promise.allSettled(openings.map(opening => boundedByProgress(opening.then(capture => capture.retire(), (error: unknown) => {
    if (error instanceof VMError && error.detail?.["cleanupFailed"] === true) throw error;
  }), "capture-retire", stepMs, { frames: 0 })));
  options.signal.removeEventListener("abort", abort);
  if (retired.some(result => result.status === "rejected")) {
    throw new VMError("STORAGE_ERROR", "Workspace capture retirement requires recovery", { cleanupFailed: true });
  }
  if (failure !== undefined) throw failure.error;
  // Capturing workspace bytes alone leaves unrelated dirty ext4 inodes and its
  // journal in guest RAM. The cold disk must retain those after CPU retirement.
  await boundedByProgress(agent.syncFilesystems(options.requestId), "filesystem-sync", stepMs, progress);
  return true;
}
