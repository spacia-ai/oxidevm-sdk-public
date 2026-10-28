import { readOwnedJSProcessTrace, watchOwnedAccelerationNotices } from "../../vm-adapter.js";
import { accelerationNoticeWire } from "../../runtime/js-process/late-failure.js";
import {encodeMovedAway} from "../protocol/handoff.js";
import type { PreviewHandle, ResumedTerminal, VM, WorkspaceWatch } from "../../contracts.js";
import { VMError } from "../../runtime/errors.js";
import type { FrameRequest } from "../protocol/requests.js";
import { encodeSnapshotEvent, encodeStart } from "../protocol/values.js";
import { pumpProcess } from "./process-pump.js";
import { remoteBackupDestination } from "./remote-destination.js";
import { dispatchWorkspace, isWorkspaceRequest } from "./workspace.js";
import type { WorkspaceRequest } from "./workspace.js";

// What each frame request does to the VM the frame created. Every call gets the request's own
// abort signal and may send events before its result; the returned value is the result.

export interface DispatchContext {
  readonly vm: VM;
  readonly signal: AbortSignal;
  event(value: unknown): void;
  readonly previews: Map<number, PreviewHandle>;
  /** Resumed processes the page may attach to, by key: from the start and from each restore. */
  readonly terminals: Map<string, ResumedTerminal>;
  /** Running workspace watches, by the id of the request that started each. */
  readonly watches: Map<number, WorkspaceWatch>;
  nextPreview(): number;
}

type VMRequest = Exclude<FrameRequest, { readonly type: "create" | "dispose" | "erase-local-data" | "workspace-handoff" }>;

/**
 * Erases the runtime origin's OxideVM storage for the page: the VM this frame created (if any) is
 * disposed first, because erasure needs every workspace on this origin released, then `erase`
 * (the origin's one erasure owner) runs in a fresh storage worker.
 */
export async function dispatchErase(vm: VM | undefined, erase: (signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
  await vm?.dispose();
  signal.throwIfAborted();
  await erase(signal);
}
type SnapshotRequest = Extract<VMRequest, { readonly type: `snapshots.${string}` | "suspend" }>;
type CommonRequest = Exclude<VMRequest, SnapshotRequest | WorkspaceRequest>;

function isSnapshotRequest(request: VMRequest): request is SnapshotRequest {
  return request.type === "suspend" || request.type.startsWith("snapshots.");
}

export async function dispatch(request: VMRequest, context: DispatchContext): Promise<unknown> {
  if (isSnapshotRequest(request)) return dispatchSnapshots(request, context.vm, context);
  if (isWorkspaceRequest(request)) return dispatchWorkspace(request, { workspace: context.vm.workspace, signal: context.signal, event: value => { context.event(value); }, watches: context.watches });
  return dispatchCommon(request, context);
}

async function dispatchCommon(request: CommonRequest, context: DispatchContext): Promise<unknown> {
  const { vm, signal } = context;
  switch (request.type) {
    case "js-trace": return readOwnedJSProcessTrace(vm, request.capacity);
    case "acceleration-notices": return watchOwnedAccelerationNotices(vm, notice => { context.event(accelerationNoticeWire(notice)); }, signal);
    case "prepareImage": return vm.prepareImage({ signal });
    case "checkForUpdate": return vm.checkForUpdate({ signal });
    case "handoff.allow":
      await vm.allowWorkspaceHandoff(moved=>context.event(encodeMovedAway(moved)),{signal});
      return undefined;
    case "spawn": {
      const { terminal, ...command } = request.spec;
      const handle = terminal === undefined ? await vm.spawn({ ...command, signal }) : await vm.spawn({ ...command, terminal, signal });
      pumpProcess(handle, request.io);
      return { pid: handle.pid, kind: handle.kind,...(handle.snapshotKey===undefined?{}:{snapshotKey:handle.snapshotKey}) };
    }
    case "terminal.attach": {
      const terminal = context.terminals.get(request.key);
      if (terminal === undefined || terminal.source !== "process") throw new VMError("INVALID_ARGUMENT", "no resumed process has that key");
      const handle = await terminal.attach({ signal });
      pumpProcess(handle, request.io);
      return { pid: handle.pid, kind: handle.kind,...(handle.snapshotKey===undefined?{}:{snapshotKey:handle.snapshotKey}) };
    }
    case "exposePort": {
      const preview = await vm.exposePort(request.port, { signal });
      const id = context.nextPreview();
      context.previews.set(id, preview);
      return { port: preview.port, url: preview.url.href, isolation: preview.isolation, preview: id };
    }
    case "preview.close": {
      const preview = context.previews.get(request.preview);
      context.previews.delete(request.preview);
      return preview?.close();
    }
    case "listeningPorts": return vm.listeningPorts({ signal });
    case "watchListeningPorts": return vm.watchListeningPorts(ports => context.event(ports), { signal });
    case "network.connect": return vm.network.connect(request.options, { signal });
    case "network.disconnect": return vm.network.disconnect();
    case "network.watch": return vm.network.watch(state => context.event(state), { signal });
  }
}

async function dispatchSnapshots(request: SnapshotRequest, vm: VM, context: DispatchContext): Promise<unknown> {
  const { signal } = context;
  const snapshots = vm.snapshots;
  switch (request.type) {
    case "snapshots.list": return snapshots.list({ signal });
    case "snapshots.capture": return snapshots.capture({ label: request.label, ...(request.kind === undefined ? {} : { kind: request.kind }), signal });
    case "snapshots.restore": {
      const restored = await snapshots.restore(request.snapshot, {
        ...(request.saveCurrentFirst === undefined ? {} : { saveCurrentFirst: request.saveCurrentFirst }), signal, onProgress: progress => context.event(progress),
      });
      rememberTerminals(context, restored.start.terminals);
      return { image:vm.image,start: encodeStart(restored.start), ...(restored.undo === undefined ? {} : { undo: restored.undo }) };
    }
    case "snapshots.rename": return snapshots.rename(request.snapshot, request.label, { signal });
    case "snapshots.delete": return snapshots.delete(request.snapshot, { signal });
    case "snapshots.usage": return snapshots.usage({ signal });
    case "snapshots.setAppData": return snapshots.setAppData(request.data);
    case "snapshots.observe": {
      snapshots.observe(event => context.event(encodeSnapshotEvent(event)), { signal });
      // The subscription lasts until the page cancels it.
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      return undefined;
    }
    case "snapshots.autoSave.configure": return snapshots.autoSave.configure({ enabled: request.enabled }, { signal });
    case "snapshots.autoSave.hint": snapshots.autoSave.hint(request.hint); return undefined;
    case "snapshots.export": return snapshots.export(request.snapshot, {
      signal, onProgress: progress => context.event(progress),
      ...(request.destination === undefined ? {} : { destination: remoteBackupDestination(request.destination) }),
    });
    case "snapshots.inspect": return snapshots.inspect(request.file, { signal });
    case "snapshots.import": return snapshots.import(request.file, { signal, onProgress: progress => context.event(progress) });
    case "suspend": return vm.suspend({ label: request.label, signal });
  }
}

export function rememberTerminals(context: Pick<DispatchContext, "terminals">, terminals: readonly ResumedTerminal[]): void {
  for (const terminal of terminals) if (terminal.source === "process") context.terminals.set(terminal.key, terminal);
}
