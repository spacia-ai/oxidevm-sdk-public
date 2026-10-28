import { bindFrameDiagnostics } from "../../vm-adapter.js";
import { decodeAccelerationNotice } from "../../runtime/js-process/late-failure.js";
import { decodeBytes } from "../../runtime/protocol/decoders.js";
import { imageUpdateSignal } from "../../image-update.js";
import {decodeImageInfo,type ImageInfo} from "../../image.js";
import {decodeMovedAway} from "../protocol/handoff.js";
import type {
  BackupExportResult, ExecSpec, VMSnapshots, VMStart, ListeningPort, NetworkState, PipeSpawnSpec, PreviewHandle,
  ProcessHandle, RelayConnectionOptions, ResumedTerminal, SnapshotInfo, SnapshotUsage, TerminalHandle, TerminalSpawnSpec, VM, VMNetwork,
} from "../../contracts.js";
import { abortIfRequested } from "../../engine-assets.js";
import { execProcess } from "../../process.js";
import { exactKeys, integer, record, string } from "../../runtime/decode.js";
import { VMError } from "../../runtime/errors.js";
import { validateHandoffRegistration } from "../../runtime/workspace-handoff.js";
import { decodeNetworkState, serializeRelayOptions } from "../../runtime/protocol/network.js";
import { decodeBackupExportResult, decodeBackupInspection } from "../../runtime/protocol/snapshot-archive.js";
import { decodeSnapshotInfo, decodeSnapshotInfos, decodeSnapshotRef, decodeSnapshotUsage, validateAutoSaveHint } from "../../runtime/protocol/snapshots.js";
import { decodeListeningPorts } from "../../runtime/protocol/listening-ports.js";
import type { RuntimeSelection, ValidatedVMOptions } from "../../vm-options.js";
import { encodeFrameOptions } from "../protocol/options.js";
import type { FrameOperation } from "../protocol/requests.js";
import { decodeBootProgress, decodeByteProgress, decodeSnapshotEvent, decodeStart, decodeStartProgress, decodeUnit, decodeVMDescription } from "../protocol/values.js";
import type { StartWire, VMDescription } from "../protocol/values.js";
import { serveBackupDestination } from "./backup-destination.js";
import { FrameChannel } from "./channel.js";
import type { FrameCall } from "./channel.js";
import { mountRuntimeFrame } from "./iframe.js";
import { frameProcess } from "./process.js";
import { pageKeepers } from "./preview-keepers.js";
import { frameWorkspace } from "./workspace.js";

// The VM a page gets in frame mode (ADR 0021): every method is a request to the runtime frame,
// which runs the same local VM a self-hosted page would. Synchronous members (mode, image,
// workspace identity, capabilities, start) come from the frame's description of the VM it created;
// `network.state` follows the frame's network owner through a watch held for the VM's lifetime.

export async function createFrameVM(options: ValidatedVMOptions, runtime: Extract<RuntimeSelection, { readonly hosting: "frame" }>): Promise<VM> {
  abortIfRequested(options.signal);
  if (!globalThis.crossOriginIsolated) {
    throw new VMError("FEATURE_NOT_AVAILABLE", "the OxideVM runtime frame needs a cross-origin isolated page: serve it with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp (or credentialless)", { reason: "browser-unsupported", requirement: "cross-origin-isolation" });
  }
  const frame = await mountRuntimeFrame(runtime.origin, options.signal);
  try {
    return await connectFrameVM(frame.port, options, location.href, () => frame.remove());
  } catch (error) {
    frame.remove();
    throw error;
  }
}

/** Creates the VM over an already connected port; `release` runs once the VM is disposed. */
export async function connectFrameVM(port: MessagePort, options: ValidatedVMOptions, page: string, release: () => void): Promise<VM> {
  // Preview keepers live in this page so they share a storage partition with the previews it shows.
  // The channel only calls back once the frame speaks, after both exist.
  const channel = new FrameChannel(port, (command, ports) => { keepers.handle(command, ports); });
  const keepers = pageKeepers(options.preview, (keeper, origin, data) => { channel.reportKeeper(keeper, origin, data); });
  const releaseAll = () => { keepers.dispose(); release(); };
  const description = await channel.request({ type: "create", options: encodeFrameOptions(options, page) }, {
    decode: decodeVMDescription, signal: options.signal,
    onEvent: event => { options.onProgress?.(decodeBootProgress(event)); },
  }).catch((error: unknown) => { channel.close(); keepers.dispose(); throw error; });
  return frameVM(channel, description, page, releaseAll);
}

function frameVM(channel: FrameChannel, description: VMDescription, page: string, release: () => void): VM {
  let disposal: Promise<void> | undefined;
  let image=description.image;
  const lifetime = new AbortController();
  const retireConnection=()=>{lifetime.abort();channel.close();release();};
  const call = <T>(operation: FrameOperation, request: FrameCall<T>): Promise<T> => {
    if (disposal !== undefined) return Promise.reject(new VMError("PROTOCOL_ERROR", "VM has been disposed"));
    return channel.request(operation, request);
  };
  const unit = (operation: FrameOperation, signal?: AbortSignal) => call(operation, { decode: decodeUnit, signal });

  const spawnOver = async (operation: (io: MessagePort) => FrameOperation, signal: AbortSignal | undefined): Promise<ProcessHandle | TerminalHandle> => {
    const io = new MessageChannel();
    const spawned = await call(operation(io.port2), { decode: decodeSpawned, signal, transfer: [io.port2] })
      .catch((error: unknown) => { io.port1.close(); throw error; });
    return frameProcess(io.port1, spawned.pid, spawned.kind,spawned.snapshotKey);
  };
  async function spawn(spec: TerminalSpawnSpec): Promise<TerminalHandle>;
  async function spawn(spec: PipeSpawnSpec): Promise<ProcessHandle>;
  async function spawn(spec: PipeSpawnSpec | TerminalSpawnSpec): Promise<ProcessHandle | TerminalHandle> {
    const { signal, ...wire } = spec;
    return spawnOver(io => ({ type: "spawn", spec: wire, io }), signal);
  }

  let networkState: NetworkState = description.network;
  void call({ type: "network.watch" }, { decode: decodeUnit, signal: lifetime.signal, onAbort: "resolve", onEvent: event => { networkState = decodeNetworkState(event); } }).catch(() => {});
  const network: VMNetwork = {
    get state() { return networkState; },
    connect: (connection: RelayConnectionOptions, request?: { readonly signal?: AbortSignal }) =>
      unit({ type: "network.connect", options: serializeRelayOptions(connection, page) }, request?.signal),
    disconnect: () => unit({ type: "network.disconnect" }),
    watch: (onChange, request) => call({ type: "network.watch" }, { decode: decodeUnit, signal: request.signal, onAbort: "resolve", onEvent: event => { onChange(decodeNetworkState(event)); } }),
  };

  const base = {
    checkForUpdate: (request?: { readonly signal?: AbortSignal }) => call({ type: "checkForUpdate" }, {
      signal: imageUpdateSignal(request), decode: value => value === null ? null : decodeImageInfo(value),
    }),
    prepareImage: (request?: { readonly signal?: AbortSignal }) => call({ type: "prepareImage" }, { signal: imageUpdateSignal(request), decode: decodeUnit }),
    allowWorkspaceHandoff:async(listener:Parameters<VM["allowWorkspaceHandoff"]>[0],request:Parameters<VM["allowWorkspaceHandoff"]>[1])=>{
      const requestedSignal=validateHandoffRegistration(listener,request);
      await call({type:"handoff.allow"},{decode:decodeUnit,signal:AbortSignal.any([lifetime.signal,requestedSignal]),onAbort:"resolve",onEvent:event=>{const moved=decodeMovedAway(event);void base.dispose().then(()=>listener(moved),()=>listener(moved));}});
    },
    workspace: frameWorkspace(call, description.workspace),
    network,
    capabilities: description.capabilities,
    license: description.license,
    spawn,
    exec: async (spec: ExecSpec) => {
      const value = record(spec, "exec spec"); exactKeys(value, ["command"], ["args", "cwd", "env", "stdin", "maxOutputBytes", "signal"]);
      const limit = integer(value["maxOutputBytes"] ?? 1024 ** 2, "maxOutputBytes", 1, 64 * 1024 ** 2);
      const process = await spawn({ command: spec.command, ...(spec.args === undefined ? {} : { args: spec.args }), ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }), ...(spec.env === undefined ? {} : { env: spec.env }), ...(spec.signal === undefined ? {} : { signal: spec.signal }) });
      return execProcess(process, { ...spec, maxOutputBytes: limit });
    },
    exposePort: async (port: number, request?: { readonly signal?: AbortSignal }): Promise<PreviewHandle> => {
      const preview = await call({ type: "exposePort", port }, { decode: decodePreview, signal: request?.signal });
      return { port: preview.port, url: new URL(preview.url), isolation: preview.isolation, close: () => unit({ type: "preview.close", preview: preview.preview }) };
    },
    listeningPorts: (request?: { readonly signal?: AbortSignal }) => call({ type: "listeningPorts" }, { decode: decodeListeningPorts, signal: request?.signal }),
    watchListeningPorts: (listener: (ports: readonly ListeningPort[]) => void, request: { readonly signal: AbortSignal }) =>
      call({ type: "watchListeningPorts" }, { decode: decodeUnit, signal: request.signal, onAbort: "resolve", onEvent: event => { listener(decodeListeningPorts(event)); } }),
    dispose: () => {
      disposal ??= channel.request({ type: "dispose" }, { decode: decodeUnit }).finally(retireConnection);
      return disposal;
    },
  };
  const attach = (key: string, signal: AbortSignal | undefined) => spawnOver(io => ({ type: "terminal.attach", key, io }), signal);
  const shared = {
    ...base, start: startFromWire(description.start, attach),
    snapshots: frameSnapshots(call, unit, attach,actual=>{if(actual.mode!==description.mode)throw new VMError("PROTOCOL_ERROR","Restored image belongs to another runtime");image=actual;}),
    suspend: async (request: {readonly label:string;readonly signal?:AbortSignal}) => {
      const snapshot = await call({ type: "suspend", label: request.label }, { decode: decodeSnapshotInfo, signal: request.signal });
      disposal ??= Promise.resolve().finally(retireConnection);
      await disposal; return snapshot;
    },
  };
  const vm: VM = description.mode === "userspace"
    ? { ...shared, spawnJS: (): Promise<never> => Promise.reject(new VMError("FEATURE_NOT_AVAILABLE", "JS processes require self-hosted Userspace")), mode: "userspace", get image(){return {...image,mode:"userspace" as const};} }
    : { ...shared, mode: "system", get image(){return {...image,mode:"system" as const};} };
  bindFrameDiagnostics(vm, {
    readJSProcessTrace: capacity => call({ type: "js-trace", ...(capacity === undefined ? {} : { capacity }) }, { decode: decodeBytes, signal: lifetime.signal }),
    watchAccelerationNotices: (listener, signal) => call({ type: "acceleration-notices" }, {
      decode: decodeUnit, signal: AbortSignal.any([signal, lifetime.signal]), onAbort: "resolve", onEvent: event => { listener(decodeAccelerationNotice(event)); },
    }),
  });
  return vm;

}

type Call = <T>(operation: FrameOperation, request: FrameCall<T>) => Promise<T>;
type Attach = (key: string, signal: AbortSignal | undefined) => Promise<ProcessHandle | TerminalHandle>;

function frameSnapshots(call: Call, unit: (operation: FrameOperation, signal?: AbortSignal) => Promise<void>, attach: Attach,updateImage:(image:ImageInfo)=>void ): VMSnapshots {
  const progress = (listener: ((value: { readonly completedBytes: number; readonly totalBytes: number }) => void) | undefined) =>
    (event: unknown) => { listener?.(decodeByteProgress(event)); };
  return {
    list: options => call({ type: "snapshots.list" }, { decode: decodeSnapshotInfos, signal: options?.signal }),
    capture: options => call({ type: "snapshots.capture", label: options.label, ...(options.kind === undefined ? {} : { kind: options.kind }) }, { decode: decodeSnapshotInfo, signal: options.signal }),
    restore: async (snapshot, options) => {
      const restored = await call({ type: "snapshots.restore", snapshot: decodeSnapshotRef(snapshot), ...(options?.saveCurrentFirst === undefined ? {} : { saveCurrentFirst: options.saveCurrentFirst }) }, {
        decode: decodeRestoreResult, signal: options?.signal, onEvent: event => { options?.onProgress?.(decodeStartProgress(event)); },
      });
      const start = startFromWire(restored.start, attach);
      if (start.kind !== "resumed"||start.snapshot.mode!==restored.image.mode) throw new VMError("PROTOCOL_ERROR", "Restored start and image do not match");
      updateImage(restored.image);
      return { start, ...(restored.undo === undefined ? {} : { undo: restored.undo }) };
    },
    rename: (snapshot, label, options) => call({ type: "snapshots.rename", snapshot: decodeSnapshotRef(snapshot), label }, { decode: decodeSnapshotInfo, signal: options?.signal }),
    delete: (snapshot, options) => unit({ type: "snapshots.delete", snapshot: decodeSnapshotRef(snapshot) }, options?.signal),
    usage: (options): Promise<SnapshotUsage> => call({ type: "snapshots.usage" }, { decode: decodeSnapshotUsage, signal: options?.signal }),
    setAppData: data => unit({ type: "snapshots.setAppData", data }),
    observe: (listener, options) => {
      void call({ type: "snapshots.observe" }, { decode: decodeUnit, signal: options.signal, onAbort: "resolve", onEvent: event => { listener(decodeSnapshotEvent(event)); } }).catch(() => {});
    },
    autoSave: {
      configure: (policy, options) => unit({ type: "snapshots.autoSave.configure", enabled: policy.enabled }, options?.signal),
      // A hint is advice the frame may drop; there is nothing for the page to wait for.
      hint: hint => { void unit({ type: "snapshots.autoSave.hint", hint: validateAutoSaveHint(hint) }).catch(() => {}); },
    },
    export: async (snapshot, options): Promise<BackupExportResult> => {
      const destination = options?.destination === undefined ? undefined : new MessageChannel();
      if (destination !== undefined && options?.destination !== undefined) serveBackupDestination(options.destination, destination.port1);
      return call({ type: "snapshots.export", snapshot: decodeSnapshotRef(snapshot), ...(destination === undefined ? {} : { destination: destination.port2 }) }, {
        decode: decodeBackupExportResult, signal: options?.signal, onEvent: progress(options?.onProgress), transfer: destination === undefined ? [] : [destination.port2],
      });
    },
    inspect: (file, options) => call({ type: "snapshots.inspect", file }, { decode: decodeBackupInspection, signal: options?.signal }),
    import: (file, options): Promise<SnapshotInfo> => call({ type: "snapshots.import", file }, { decode: decodeSnapshotInfo, signal: options?.signal, onEvent: progress(options?.onProgress) }),
  };
}

function startFromWire(start: StartWire, attach: Attach): VMStart {
  if (start.kind === "booted") return start;
  return {
    ...start,
    terminals: start.terminals.map((terminal): ResumedTerminal => terminal.source === "console" ? terminal : {
      ...terminal, attach: options => attach(terminal.key, options?.signal),
    }),
  };
}

function decodeRestoreResult(value: unknown): { readonly start: StartWire;readonly image:ImageInfo; readonly undo?: SnapshotInfo } {
  const result = record(value, "restore result");
  exactKeys(result, ["start","image"], ["undo"]);
  return { image:decodeImageInfo(result["image"]),start: decodeStart(result["start"]), ...(result["undo"] === undefined ? {} : { undo: decodeSnapshotInfo(result["undo"]) }) };
}

function decodeSpawned(value: unknown): { readonly pid: number; readonly kind: "process" | "terminal";readonly snapshotKey?:string } {
  const spawned = record(value, "spawned process");
  exactKeys(spawned, ["pid", "kind"],["snapshotKey"]);
  const snapshotKey=spawned["snapshotKey"]===undefined?undefined:string(spawned["snapshotKey"],"process snapshot key");
  if(snapshotKey!==undefined&&(!/^process:[1-9][0-9]{0,15}$/u.test(snapshotKey)||!Number.isSafeInteger(Number(snapshotKey.slice(8)))))throw new VMError("PROTOCOL_ERROR","Process snapshot key is invalid");
  const kind = spawned["kind"];
  if (kind !== "process" && kind !== "terminal") throw new VMError("PROTOCOL_ERROR", "spawned process kind is invalid");
  return { pid: integer(spawned["pid"], "process id", 1, 0x7fff_ffff), kind,...(snapshotKey===undefined?{}:{snapshotKey}) };
}

function decodePreview(value: unknown): { readonly port: number; readonly url: string; readonly isolation: "per-session" | "shared"; readonly preview: number } {
  const preview = record(value, "exposed preview");
  exactKeys(preview, ["port", "url", "isolation", "preview"]);
  const isolation = preview["isolation"];
  if (isolation !== "per-session" && isolation !== "shared") throw new VMError("PROTOCOL_ERROR", "preview isolation is invalid");
  const url = string(preview["url"], "preview URL");
  if (!/^https?:\/\//u.test(url)) throw new VMError("PROTOCOL_ERROR", "preview URL is invalid");
  return { port: integer(preview["port"], "preview port", 1, 65_535), url, isolation, preview: integer(preview["preview"], "preview id", 1, 0x7fff_ffff) };
}
