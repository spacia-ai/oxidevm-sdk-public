import {validateWorkspaceId} from "../../runtime/workspace-path.js";
import { boolean, exactKeys, integer, record, string } from "../../runtime/decode.js";
import { VMError } from "../../runtime/errors.js";
import { decodeRelayOptions } from "../../runtime/protocol/network.js";
import type { RelayOptions } from "../../runtime/protocol/network.js";
import { decodeSnapshotRef, validateAppData, validateAutoSaveEnabled, validateAutoSaveHint } from "../../runtime/protocol/snapshots.js";
import type { AutoSaveHint } from "../../runtime/protocol/snapshots.js";
import type { SnapshotRef } from "../../contracts.js";
import { FRAME_PROTOCOL_VERSION } from "./handshake.js";
import { decodeKeeperReport } from "./keepers.js";
import { decodeWorkspaceRequest, isWorkspaceFrameType } from "./workspace.js";
import type { WorkspaceFrameOperation } from "./workspace.js";

// Requests the page sends the runtime frame over the connected port, one per public VM method.
// Every request carries `v` and a page-chosen `id`; replies and events name that id, and
// `{ type: "cancel", id }` aborts it. Values the VM validates itself (paths, commands, labels) are
// only type-checked here; the VM's own validation runs in the frame exactly as in a local VM.

/** What a spawned process asks for. The VM's spawn validation runs on it in the frame. */
export interface SpawnWire {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly terminal?: { readonly columns: number; readonly rows: number };
}

export type FrameOperation =
  | { readonly type: "js-trace"; readonly capacity?: number }
  /** Protocol 16 (ADR 0026): late fast-path failures as events until the page cancels. */
  | { readonly type: "acceleration-notices" }
  | { readonly type: "checkForUpdate" }
  | { readonly type: "prepareImage" }
  | {readonly type:"workspace-handoff";readonly workspaceId:string;readonly timeoutMs?:number}
  | {readonly type:"handoff.allow"}
  | { readonly type: "create"; readonly options: unknown }
  | { readonly type: "workspace.read" | "workspace.readText" | "workspace.list"; readonly path: string }
  | { readonly type: "workspace.write"; readonly path: string; readonly data: Uint8Array }
  | { readonly type: "workspace.writeText"; readonly path: string; readonly data: string }
  | { readonly type: "workspace.remove"; readonly path: string; readonly recursive: boolean }
  | WorkspaceFrameOperation
  | { readonly type: "spawn"; readonly spec: SpawnWire; readonly io: MessagePort }
  | { readonly type: "terminal.attach"; readonly key: string; readonly io: MessagePort }
  | { readonly type: "exposePort"; readonly port: number }
  | { readonly type: "preview.close"; readonly preview: number }
  | { readonly type: "listeningPorts" | "watchListeningPorts" }
  | { readonly type: "network.connect"; readonly options: RelayOptions }
  | { readonly type: "network.disconnect" | "network.watch" }
  | { readonly type: "snapshots.list" | "snapshots.usage" | "snapshots.observe" }
  | { readonly type: "snapshots.capture"; readonly label: string; readonly kind?: "named" | "safety" | "automatic" }
  | { readonly type: "snapshots.restore"; readonly snapshot: SnapshotRef; readonly saveCurrentFirst?: boolean }
  | { readonly type: "snapshots.rename"; readonly snapshot: SnapshotRef; readonly label: string }
  | { readonly type: "snapshots.delete"; readonly snapshot: SnapshotRef }
  | { readonly type: "snapshots.setAppData"; readonly data: Uint8Array | null }
  | { readonly type: "snapshots.autoSave.configure"; readonly enabled: boolean }
  | { readonly type: "snapshots.autoSave.hint"; readonly hint: AutoSaveHint }
  | { readonly type: "snapshots.export"; readonly snapshot: SnapshotRef; readonly destination?: MessagePort }
  | { readonly type: "snapshots.inspect" | "snapshots.import"; readonly file: Blob }
  | { readonly type: "suspend"; readonly label: string }
  | { readonly type: "dispose" }
  /** Protocol 3: dispose the frame's VM, then erase the runtime origin's OxideVM data. */
  | { readonly type: "erase-local-data" };

export type FrameOperationType = FrameOperation["type"];
export type FrameRequest = FrameOperation & { readonly id: number };
export type FrameMessage =
  | FrameRequest
  | { readonly type: "cancel"; readonly id: number }
  /** What a preview keeper the page embeds for the frame said; `id` is the keeper's number. */
  | { readonly type: "keeper.message"; readonly id: number; readonly origin: string; readonly data: unknown };

/** The largest single workspace write the page may send in one message. */
export const MAX_FRAME_WRITE_BYTES = 256 * 1024 ** 2;
const MAX_ARGUMENTS = 4096;
const MAX_ENVIRONMENT = 1024;
/** Request ids are positive and fit in 31 bits so every side can count them exactly. */
const MAX_REQUEST_ID = 0x7fff_ffff;

/** The request without its envelope, as the page builds it. */
export function frameRequest(id: number, operation: FrameOperation): Readonly<Record<string, unknown>> {
  return { v: FRAME_PROTOCOL_VERSION, id, ...operation };
}

export function decodeFrameMessage(value: unknown): FrameMessage {
  const message = record(value, "frame request");
  integer(message["v"], "frame protocol", FRAME_PROTOCOL_VERSION, FRAME_PROTOCOL_VERSION);
  const id = integer(message["id"], "frame request id", 1, MAX_REQUEST_ID);
  const type = string(message["type"], "frame request type");
  const fields = (required: readonly string[], optional: readonly string[] = []) => exactKeys(message, ["v", "id", "type", ...required], optional);
  switch (type) {
    case "js-trace":
      fields([], ["capacity"]);
      return { type, id, ...(message["capacity"] === undefined ? {} : { capacity: integer(message["capacity"], "JS trace capacity", 0, 4096) }) };
    case "prepareImage": case "checkForUpdate": case "cancel": case "handoff.allow": case "dispose": case "erase-local-data": case "listeningPorts": case "watchListeningPorts": case "network.disconnect": case "network.watch": case "acceleration-notices":
    case "snapshots.list": case "snapshots.usage": case "snapshots.observe":
      fields([]);
      return { type, id };
    case "keeper.message": {
      const report = decodeKeeperReport(message);
      return { type, id: report.keeper, origin: report.origin, data: report.data };
    }
    case "workspace-handoff":
      fields(["workspaceId"],["timeoutMs"]);
      return {type,id,workspaceId:validateWorkspaceId(string(message["workspaceId"],"workspace ID")),...(message["timeoutMs"]===undefined?{}:{timeoutMs:integer(message["timeoutMs"],"handoff timeout",1,600_000)})};
    case "create":
      fields(["options"]);
      return { type, id, options: message["options"] };
    case "workspace.read": case "workspace.readText": case "workspace.list":
      fields(["path"]);
      return { type, id, path: string(message["path"], "workspace path") };
    case "workspace.write":
      fields(["path", "data"]);
      return { type, id, path: string(message["path"], "workspace path"), data: bytes(message["data"], MAX_FRAME_WRITE_BYTES) };
    case "workspace.writeText":
      fields(["path", "data"]);
      return { type, id, path: string(message["path"], "workspace path"), data: string(message["data"], "workspace text") };
    case "workspace.remove":
      fields(["path", "recursive"]);
      return { type, id, path: string(message["path"], "workspace path"), recursive: boolean(message["recursive"], "recursive removal") };
    case "spawn":
      fields(["spec", "io"]);
      return { type, id, spec: decodeSpawnWire(message["spec"]), io: port(message["io"]) };
    case "terminal.attach":
      fields(["key", "io"]);
      return { type, id, key: string(message["key"], "terminal key"), io: port(message["io"]) };
    case "exposePort":
      fields(["port"]);
      return { type, id, port: integer(message["port"], "guest port", 1, 65_535) };
    case "preview.close":
      fields(["preview"]);
      return { type, id, preview: integer(message["preview"], "preview id", 1, MAX_REQUEST_ID) };
    case "network.connect":
      fields(["options"]);
      return { type, id, options: decodeRelayOptions(message["options"], "https://oxidevm-frame.invalid/") };
    case "snapshots.capture": {
      fields(["label"], ["kind"]);
      const kind = message["kind"];
      if (kind !== undefined && kind !== "named" && kind !== "safety" && kind !== "automatic") throw new VMError("PROTOCOL_ERROR", "restore point kind is invalid");
      return { type, id, label: string(message["label"], "restore point label"), ...(kind === undefined ? {} : { kind }) };
    }
    case "snapshots.restore": {
      fields(["snapshot"], ["saveCurrentFirst"]);
      const save = message["saveCurrentFirst"];
      return { type, id, snapshot: decodeSnapshotRef(message["snapshot"]), ...(save === undefined ? {} : { saveCurrentFirst: boolean(save, "save current first") }) };
    }
    case "snapshots.rename":
      fields(["snapshot", "label"]);
      return { type, id, snapshot: decodeSnapshotRef(message["snapshot"]), label: string(message["label"], "restore point label") };
    case "snapshots.delete":
      fields(["snapshot"]);
      return { type, id, snapshot: decodeSnapshotRef(message["snapshot"]) };
    case "snapshots.setAppData":
      fields(["data"]);
      return { type, id, data: validateAppData(message["data"]) };
    case "snapshots.autoSave.configure":
      fields(["enabled"]);
      return { type, id, enabled: validateAutoSaveEnabled({ enabled: message["enabled"] }) };
    case "snapshots.autoSave.hint":
      fields(["hint"]);
      return { type, id, hint: validateAutoSaveHint(message["hint"]) };
    case "snapshots.export": {
      fields(["snapshot"], ["destination"]);
      const destination = message["destination"];
      return { type, id, snapshot: decodeSnapshotRef(message["snapshot"]), ...(destination === undefined ? {} : { destination: port(destination) }) };
    }
    case "snapshots.inspect": case "snapshots.import":
      fields(["file"]);
      return { type, id, file: blob(message["file"]) };
    case "suspend":
      fields(["label"]);
      return { type, id, label: string(message["label"], "restore point label") };
    default:
      if (isWorkspaceFrameType(type)) return { ...decodeWorkspaceRequest(message, type, ["v", "id", "type"], MAX_FRAME_WRITE_BYTES), id };
      throw new VMError("PROTOCOL_ERROR", "unknown frame request");
  }
}

function decodeSpawnWire(value: unknown): SpawnWire {
  const spec = record(value, "spawn spec");
  exactKeys(spec, ["command"], ["args", "cwd", "env", "terminal"]);
  const args = spec["args"];
  if (args !== undefined && (!Array.isArray(args) || args.length > MAX_ARGUMENTS || !args.every(argument => typeof argument === "string"))) {
    throw new VMError("PROTOCOL_ERROR", "spawn arguments must be strings");
  }
  const environment = spec["env"] === undefined ? undefined : record(spec["env"], "spawn environment");
  if (environment !== undefined && (Object.keys(environment).length > MAX_ENVIRONMENT || !Object.values(environment).every(entry => typeof entry === "string"))) {
    throw new VMError("PROTOCOL_ERROR", "spawn environment values must be strings");
  }
  const terminal = spec["terminal"] === undefined ? undefined : record(spec["terminal"], "terminal size");
  if (terminal !== undefined) exactKeys(terminal, ["columns", "rows"]);
  return {
    command: string(spec["command"], "spawn command"),
    ...(args === undefined ? {} : { args: args.map(argument => string(argument, "spawn argument")) }),
    ...(spec["cwd"] === undefined ? {} : { cwd: string(spec["cwd"], "spawn directory") }),
    ...(environment === undefined ? {} : { env: Object.fromEntries(Object.entries(environment).map(([name, entry]) => [name, string(entry, "spawn environment value")])) }),
    ...(terminal === undefined ? {} : { terminal: { columns: integer(terminal["columns"], "terminal columns", 1, 1000), rows: integer(terminal["rows"], "terminal rows", 1, 1000) } }),
  };
}

function bytes(value: unknown, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > maximum) throw new VMError("PROTOCOL_ERROR", "frame bytes are invalid");
  return value;
}

function port(value: unknown): MessagePort {
  if (!(value instanceof MessagePort)) throw new VMError("PROTOCOL_ERROR", "frame request must transfer a MessagePort");
  return value;
}

function blob(value: unknown): Blob {
  if (!(value instanceof Blob)) throw new VMError("PROTOCOL_ERROR", "frame request must carry a file");
  return value;
}
