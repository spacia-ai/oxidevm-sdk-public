import {requestWorkspaceHandoff as localHandoff} from "../../runtime/workspace-handoff.js";
import type {WorkspaceHandoffOptions,WorkspaceHandoffResult} from "../../contracts.js";
import type { BootProgress, PreviewHandle, ResumedTerminal, VM, WorkspaceWatch } from "../../contracts.js";
import { VMError } from "../../runtime/errors.js";
import { integer, record } from "../../runtime/decode.js";
import { frameEvent, frameFailure, frameResult } from "../protocol/replies.js";
import { decodeFrameMessage } from "../protocol/requests.js";
import type { FrameRequest } from "../protocol/requests.js";
import { encodeStart } from "../protocol/values.js";
import type { VMDescription } from "../protocol/values.js";
import { dispatch, dispatchErase, rememberTerminals } from "./dispatch.js";
import { frameKeeperHost } from "./keeper-host.js";
import type { PreviewKeeperHost } from "../../runtime/preview-keeper.js";

// The runtime frame's side of a connected page: it creates one VM when the page asks, runs each
// request against it with an abort signal of its own, and answers on the same port. It holds no
// browser or DOM state, so it runs over any MessagePort (tests use an in-memory channel).

export interface FrameServerOptions {
  requestWorkspaceHandoff?(workspaceId:string,options:WorkspaceHandoffOptions):Promise<WorkspaceHandoffResult>;
  /** The origin of the page this frame serves; its preview keepers answer to it. */
  readonly embedderOrigin: string;
  /**
   * Creates the VM from the page's wire options; progress goes to the page as events, and preview
   * keepers open in the page through `previewKeeperHost`.
   */
  create(options: unknown, signal: AbortSignal, onProgress: (progress: BootProgress) => void, previewKeeperHost: PreviewKeeperHost): Promise<VM>;
  /** Erases this origin's OxideVM storage, as `eraseLocalData` does for a self-hosted page. */
  eraseLocalData(signal: AbortSignal): Promise<void>;
  /** Runs after the VM is disposed (by the page, or because the VM suspended). */
  onDisposed?(): void;
}

export function serveFrame(port: MessagePort, server: FrameServerOptions): void {
  const requests = new Map<number, AbortController>();
  const previews = new Map<number, PreviewHandle>();
  const terminals = new Map<string, ResumedTerminal>();
  const watches = new Map<number, WorkspaceWatch>();
  let previewIds = 1;
  let vm: VM | undefined;
  let creating = false;
  let disposed = false;
  const keepers = frameKeeperHost(server.embedderOrigin, (message, transfer) => { if (!disposed) port.postMessage(message, [...transfer]); });

  const reply = (message: Readonly<Record<string, unknown>>) => { if (!disposed || message["type"] === "result") port.postMessage(message); };

  const run = async (request: FrameRequest, signal: AbortSignal): Promise<unknown> => {
    if(request.type==="workspace-handoff") {
      if(creating||vm!==undefined) throw new VMError("PROTOCOL_ERROR","handoff requests use a fresh runtime frame");
      return (server.requestWorkspaceHandoff??localHandoff)(request.workspaceId,{signal,...(request.timeoutMs===undefined?{}:{timeoutMs:request.timeoutMs})});
    }
    if (request.type === "create") {
      if (creating || vm !== undefined) throw new VMError("PROTOCOL_ERROR", "this frame already created its VM");
      creating = true;
      const created = await server.create(request.options, signal, progress => reply(frameEvent(request.id, progress)), keepers);
      vm = created;
      rememberTerminals({ terminals }, created.start.kind === "resumed" ? created.start.terminals : []);
      return describe(created);
    }
    if (request.type === "erase-local-data") {
      if (creating && vm === undefined) throw new VMError("PROTOCOL_ERROR", "this frame is still creating its VM");
      // The connection ends with the erasure: nothing it held survives it.
      const created = vm;
      disposed = true;
      try { await dispatchErase(created, erasing => server.eraseLocalData(erasing), signal); return undefined; }
      finally { server.onDisposed?.(); }
    }
    const current = vm;
    if (current === undefined) throw new VMError("PROTOCOL_ERROR", "the page has not created a VM in this frame");
    if (request.type === "dispose") {
      disposed = true;
      await current.dispose();
      server.onDisposed?.();
      return undefined;
    }
    const value = await dispatch(request, {
      vm: current, signal, previews, terminals, watches,
      event: event => reply(frameEvent(request.id, event)),
      nextPreview: () => previewIds++,
    });
    if (request.type === "suspend") { disposed = true; server.onDisposed?.(); }
    return value;
  };

  port.addEventListener("message", (event: MessageEvent) => {
    let message;
    try { message = decodeFrameMessage(event.data); }
    catch (error: unknown) {
      const id = requestId(event.data);
      if (id !== undefined) reply(frameFailure(id, error));
      return;
    }
    if (message.type === "cancel") { requests.get(message.id)?.abort(new VMError("ABORTED", "operation was aborted")); return; }
    if (message.type === "keeper.message") { keepers.deliver(message.id, message.origin, message.data); return; }
    if (requests.has(message.id)) { reply(frameFailure(message.id, new VMError("PROTOCOL_ERROR", "request id is already in use"))); return; }
    if (disposed) { reply(frameFailure(message.id, new VMError("PROTOCOL_ERROR", "VM has been disposed"))); return; }
    const controller = new AbortController();
    requests.set(message.id, controller);
    void run(message, controller.signal).then(
      value => reply(frameResult(message.id, value)),
      (error: unknown) => reply(frameFailure(message.id, error)),
    ).finally(() => requests.delete(message.id));
  });
  port.start();
}

function describe(vm: VM): VMDescription {
  return {
    mode: vm.mode, image: { ...vm.image }, workspace: { id: vm.workspace.id, persistence: vm.workspace.persistence },
    capabilities: vm.capabilities, network: vm.network.state, license: vm.license,
    start: encodeStart(vm.start),
  };
}

/** The id of a request that could not be decoded, so the page's call fails instead of hanging. */
function requestId(value: unknown): number | undefined {
  try { return integer(record(value, "frame request")["id"], "frame request id", 1, 0x7fff_ffff); }
  catch { return undefined; }
}
