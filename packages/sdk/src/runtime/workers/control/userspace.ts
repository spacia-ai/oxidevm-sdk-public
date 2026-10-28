import { VMError, serializeUnknownError } from "../../errors.js";
import { attentionAttachment, createAttentionCounter, postCounted } from "../../host-attention.js";
import { decodeUserspaceRequest } from "../../userspace-protocol.js";
import { decodeRequestId, PROTOCOL_VERSION } from "../../protocol/common.js";
import type { SnapshotEventRecord } from "../../protocol/snapshots.js";
import { UserspaceSnapshotControl } from "./userspace-snapshots.js";

interface Execution {
  readonly worker: Worker;
  readonly port: MessagePort;
  readonly requests: Set<number>;
  failure: VMError | undefined;
  readonly checkpoints?: UserspaceSnapshotControl;
}
let execution: Execution | undefined;

export function attachUserspaceExecution(nextPort: MessagePort, snapshotPort?: MessagePort, notify: (event: SnapshotEventRecord) => void = () => {}): void {
  closeUserspaceExecution();
  const nextWorker = new Worker(new URL("../userspace.worker.js", import.meta.url), {
    name: "oxidevm-userspace",
    type: "module",
  });
  // Every later message is counted, so the execution worker's guest slices end early to receive it.
  const attention = createAttentionCounter();
  if (attention !== null) nextWorker.postMessage(attentionAttachment(attention));
  const post = (message: unknown, transfer: Transferable[]): void => {
    postCounted(attention, () => { nextWorker.postMessage(message, transfer); });
  };
  const owner: Execution = { worker: nextWorker, port: nextPort, requests: new Set(), failure: undefined,
    ...(snapshotPort === undefined ? {} : { checkpoints: new UserspaceSnapshotControl({ postMessage: post }, snapshotPort, notify) }) };
  execution = owner;
  nextPort.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (execution !== owner) return;
    try {
      const request = decodeUserspaceRequest(event.data);
      if (owner.failure !== undefined) {
        if (request.type !== "cancel") respondError(nextPort, request.id, owner.failure);
        return;
      }
      if (request.type !== "cancel") owner.requests.add(request.id);
      const transfer: Transferable[] = request.type === "attach-process" ? [request.port] : request.type === "spawn"
        ? [request.elf.buffer, request.rootfs.buffer, request.port]
        : request.type === "spawn-managed" || request.type === "spawn-js"
          ? [request.rootfs.buffer, request.port]
        : request.type === "initialize"
          ? [request.storagePort, request.networkPort, request.nativeExecutionPort].filter(
              (port): port is MessagePort => port !== undefined,
            )
        : request.type === "stdin"
          ? [request.data.buffer]
          : [];
      post(request, transfer);
    } catch (error) {
      const id = decodeRequestId(event.data);
      if (id !== undefined) { owner.requests.delete(id); respondError(nextPort, id, error); }
    }
  });
  nextWorker.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (execution !== owner || owner.failure !== undefined) return;
    const id = decodeRequestId(event.data);
    if (id !== undefined) owner.requests.delete(id);
    try { nextPort.postMessage(event.data, replyTransfer(event.data)); }
    catch (error) {
      // A reply the page cannot receive fails its request instead of the relay.
      if (id !== undefined) respondError(nextPort, id, new VMError("PROTOCOL_ERROR", "Userspace reply cannot reach the page", { reason: "reply-clone-failed", error: error instanceof Error ? error.name : "unknown" }));
    }
  });
  const fail = (event: Event) => {
    if (execution !== owner || owner.failure !== undefined) return;
    const error = new VMError(
      "PROTOCOL_ERROR",
      "Userspace execution worker failed",
      { reason: event.type === "messageerror" ? "message-clone-failed" : "worker-failed" },
    );
    owner.failure = error;
    for (const id of owner.requests) respondError(nextPort, id, error);
    owner.requests.clear();
    owner.checkpoints?.close(error);
    nextWorker.terminate();
  };
  nextWorker.addEventListener("error", fail);
  nextWorker.addEventListener("messageerror", fail);
  nextPort.start();
}

export function closeUserspaceExecution(): void {
  const owner = execution;
  if (owner === undefined) return;
  execution = undefined;
  const error = new VMError("ABORTED", "Userspace execution was disposed");
  for (const id of owner.requests) respondError(owner.port, id, error);
  owner.requests.clear();
  owner.checkpoints?.close(error);
  owner.port.close();
  if (owner.failure === undefined) owner.worker.terminate();
}

export function userspaceCheckpoints(): UserspaceSnapshotControl | undefined { return execution?.checkpoints; }

export function requireUserspaceCheckpoints(): UserspaceSnapshotControl {
  const checkpoints = userspaceCheckpoints();
  if (checkpoints === undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "Native checkpoint execution is unavailable");
  return checkpoints;
}

/** A reply that answers with a port (an acceleration-notices subscription) moves it to the page. */
function replyTransfer(reply: unknown): Transferable[] {
  return typeof reply === "object" && reply !== null && "value" in reply && reply.value instanceof MessagePort ? [reply.value] : [];
}

function respondError(target: MessagePort, id: number, error: unknown): void {
  target.postMessage({
    id,
    version: PROTOCOL_VERSION,
    ok: false,
    error: serializeUnknownError(error),
  });
}
