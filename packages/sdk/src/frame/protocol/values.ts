import type {
  BootProgress, FeatureSupport, LicenseStatus, VMStart, SnapshotEvent, StartProgress, VMCapabilities, WorkspacePersistence,
} from "../../contracts.js";
import {decodeImageInfo} from "../../image.js";
import type { ImageInfo } from "../../image.js";
export {decodeImageInfo} from "../../image.js";
import { boolean, exactKeys, integer, record, string } from "../../runtime/decode.js";
import { VMError, deserializeError, serializeUnknownError } from "../../runtime/errors.js";
import type { SerializedError } from "../../runtime/errors.js";
import { decodeNetworkState } from "../../runtime/protocol/network.js";
import { MAX_APP_DATA_BYTES, decodeSnapshotInfo, decodeSnapshotEventRecord } from "../../runtime/protocol/snapshots.js";
import type { NetworkState } from "../../runtime/network-types.js";
import { decodeUserspaceWorkspaceStart } from "../../runtime/protocol/workspace-start.js";
import type { RuntimeMode } from "../../values.js";

// Values the runtime frame sends back: the description of a created VM, how a System VM
// started, and the payloads of progress and restore point events. The page decodes each one; the
// frame encodes the closures and errors these values hold in the page (a resumed terminal's
// attach, a failed save's VMError) as data.

/** Everything a page's VM object answers without asking the frame again. */
export interface VMDescription {
  readonly mode: RuntimeMode;
  readonly image: ImageInfo;
  readonly workspace: { readonly id: string; readonly persistence: WorkspacePersistence };
  readonly capabilities: VMCapabilities;
  readonly network: NetworkState;
  readonly license: LicenseStatus;
  readonly start: StartWire;
}

/** A start whose resumed terminals carry no attach closure: the page attaches by key. */
export type StartWire =
  | Extract<VMStart, { readonly kind: "booted" }>
  | (Omit<Extract<VMStart, { readonly kind: "resumed" }>, "terminals"> & { readonly terminals: readonly TerminalWire[] });

export type TerminalWire =
  | { readonly source: "console"; readonly key: "console"; readonly screenTail: Uint8Array }
  | { readonly source: "process"; readonly key: string; readonly command: string; readonly screenTail: Uint8Array };

export type SnapshotEventWire =
  | Exclude<SnapshotEvent, { readonly type: "save-failed" | "image-preparation-failed" }>
  | { readonly type: "save-failed"; readonly kind: Extract<SnapshotEvent, { readonly type: "save-failed" }>["kind"]; readonly error: SerializedError }
  | { readonly type:"image-preparation-failed"; readonly error:SerializedError };

const BOOT_REASONS = ["first-start", "restart", "fresh-image", "update-image", "no-save", "incompatible", "damaged", "no-space", "restore-failed", "agent-unavailable"] as const;
const SHIPPED_REASONS = ["untrusted", "signature-invalid", "newer", "older", "incompatible", "damaged", "unavailable", "no-space", "restore-failed", "agent-unavailable"] as const;
const WORKSPACE_STATES = ["in-sync", "reconciled", "conflict-preserved"] as const;
const UNAVAILABLE = ["mode-unsupported", "image-unsupported", "browser-unsupported", "release-gate-open", "not-configured", "runtime-unsupported"] as const;
const MAX_TERMINALS = 64;
const MAX_TAIL_BYTES = 64 * 1024;
const MAX_TEXT = 4096;

export function encodeStart(start: VMStart): StartWire {
  if (start.kind === "booted") return start;
  return {
    ...start,
    terminals: start.terminals.map((terminal): TerminalWire => terminal.source === "console"
      ? { source: "console", key: "console", screenTail: terminal.screenTail }
      : { source: "process", key: terminal.key, command: terminal.command, screenTail: terminal.screenTail }),
  };
}

export function encodeSnapshotEvent(event: SnapshotEvent): SnapshotEventWire {
  return event.type === "save-failed" ? { type: "save-failed", kind: event.kind, error: serializeUnknownError(event.error) } : event.type==="image-preparation-failed" ? {...event,error:serializeUnknownError(event.error)} : event;
}

export function decodeVMDescription(value: unknown): VMDescription {
  const description = record(value, "VM description");
  const mode = description["mode"];
  if (mode !== "system" && mode !== "userspace") throw protocol("VM description mode is invalid");
  exactKeys(description, ["mode", "image", "workspace", "capabilities", "network", "license", "start"]);
  const workspace = record(description["workspace"], "workspace description");
  exactKeys(workspace, ["id", "persistence"]);
  const image = decodeImageInfo(description["image"]);
  if (image.mode !== mode) throw protocol("VM image mode does not match the VM");
  const start=decodeStart(description["start"]);
  if(start.kind === "resumed" && (start.snapshot.mode !== mode || mode === "userspace" && start.terminals.some(terminal=>terminal.source === "console"))) throw protocol("resumed start does not match runtime mode");
  return {
    mode,
    image,
    workspace: { id: bounded(workspace["id"], "workspace id", 128), persistence: decodePersistence(workspace["persistence"]) },
    capabilities: decodeCapabilities(description["capabilities"]),
    network: decodeNetworkState(description["network"]),
    license: decodeLicenseStatus(description["license"]),
    start,
  };
}


export function decodeStart(value: unknown): StartWire {
  const start = record(value, "start");
  const update=start["update"]===undefined?undefined:record(start["update"],"start image update");
  if(update!==undefined) exactKeys(update,["id","version"]);
  const offer=update===undefined?{}:{update:{id:bounded(update["id"],"update image id",256),version:bounded(update["version"],"update image version",256)}};
  if (start["kind"] === "booted") {
    exactKeys(start, ["kind", "reason"], ["skipped", "shipped", "workspaceDetails", "update"]);
    const shipped = start["shipped"] === undefined ? undefined : record(start["shipped"], "shipped skip");
    if (shipped !== undefined) exactKeys(shipped, ["reason"]);
    return {
      ...offer,
      ...(start["workspaceDetails"] === undefined ? {} : { workspaceDetails: decodeUserspaceWorkspaceStart(start["workspaceDetails"]) }),
      kind: "booted", reason: oneOf(start["reason"], BOOT_REASONS, "boot reason"),
      ...(start["skipped"] === undefined ? {} : { skipped: decodeSnapshotInfo(start["skipped"]) }),
      ...(shipped === undefined ? {} : { shipped: { reason: oneOf(shipped["reason"], SHIPPED_REASONS, "shipped skip reason") } }),
    };
  }
  if (start["kind"] !== "resumed") throw protocol("start kind is invalid");
  exactKeys(start, ["kind", "snapshot", "appData", "terminals", "newerFilesDropped", "workspace"], ["skipped", "workspaceDetails", "update"]);
  const terminals: unknown = start["terminals"];
  if (!Array.isArray(terminals) || terminals.length > MAX_TERMINALS) throw protocol("resumed terminals are invalid");
  const list: readonly unknown[] = terminals;
  return {
    kind: "resumed",
    ...offer,
    ...(start["workspaceDetails"] === undefined ? {} : { workspaceDetails: decodeUserspaceWorkspaceStart(start["workspaceDetails"]) }),
    snapshot: decodeSnapshotInfo(start["snapshot"]),
    appData: start["appData"] === null ? null : bytes(start["appData"], MAX_APP_DATA_BYTES),
    terminals: list.map(decodeTerminal),
    newerFilesDropped: boolean(start["newerFilesDropped"], "newer files dropped"),
    workspace: oneOf(start["workspace"], WORKSPACE_STATES, "resumed workspace state"),
    ...(start["skipped"] === undefined ? {} : { skipped: decodeSnapshotInfo(start["skipped"]) }),
  };
}

export function decodeBootProgress(value: unknown): BootProgress {
  const progress = record(value, "boot progress");
  switch (progress["phase"]) {
    case "prepare-image": {
      exactKeys(progress, ["phase", "stage", "completedBytes", "totalBytes"]);
      const stage = progress["stage"];
      if (stage !== "download" && stage !== "verify" && stage !== "commit") throw protocol("image preparation stage is invalid");
      const totalBytes = integer(progress["totalBytes"], "image size", 0);
      return { phase: "prepare-image", stage, totalBytes, completedBytes: integer(progress["completedBytes"], "prepared bytes", 0, totalBytes) };
    }
    case "download": {
      exactKeys(progress, ["phase", "asset", "completedBytes", "totalBytes"]);
      const asset = progress["asset"];
      if (asset !== "engine" && asset !== "image" && asset !== "restore-point") throw protocol("download asset is invalid");
      return { phase: "download", asset, completedBytes: integer(progress["completedBytes"], "downloaded bytes", 0), totalBytes: progress["totalBytes"] === null ? null : integer(progress["totalBytes"], "download size", 0) };
    }
    case "validate": case "ready":
      exactKeys(progress, ["phase"]);
      return { phase: progress["phase"] };
    case "boot": {
      exactKeys(progress, ["phase", "mode"]);
      const mode = progress["mode"];
      if (mode !== "system" && mode !== "userspace") throw protocol("boot progress mode is invalid");
      return { phase: "boot", mode };
    }
    case "restore": {
      exactKeys(progress, ["phase", "step"], ["completedBytes", "totalBytes"]);
      const step = progress["step"];
      if (step !== "open" && step !== "wake" && step !== "reconnect") throw protocol("restore progress step is invalid");
      if (progress["completedBytes"] !== undefined || progress["totalBytes"] !== undefined) {
        if (step !== "open") throw protocol("Only open progress carries byte counts");
        const totalBytes = integer(progress["totalBytes"], "restore size", 0);
        const completedBytes = integer(progress["completedBytes"], "restored bytes", 0, totalBytes);
        return { phase: "restore", step, completedBytes, totalBytes };
      }
      return { phase: "restore", step };
    }
    default:
      throw protocol("boot progress phase is invalid");
  }
}

export function decodeStartProgress(value: unknown): StartProgress {
  const progress = record(value, "start progress");
  const step = progress["step"];
  if (step === "boot" || step === "wake" || step === "reconnect") { exactKeys(progress, ["step"]); return { step }; }
  if (step !== "prepare" && step !== "download" && step !== "open") throw protocol("start progress step is invalid");
  exactKeys(progress, ["step", "completedBytes", "totalBytes"]);
  return { step, completedBytes: integer(progress["completedBytes"], "completed bytes", 0), totalBytes: integer(progress["totalBytes"], "total bytes", 0) };
}

export function decodeByteProgress(value: unknown): { readonly completedBytes: number; readonly totalBytes: number } {
  const progress = record(value, "byte progress");
  exactKeys(progress, ["completedBytes", "totalBytes"]);
  const totalBytes = integer(progress["totalBytes"], "total bytes", 0);
  return { completedBytes: integer(progress["completedBytes"], "completed bytes", 0, totalBytes), totalBytes };
}

export function decodeSnapshotEvent(value: unknown): SnapshotEvent {
  const event = decodeSnapshotEventRecord(value);
  return event.type === "save-failed" || event.type === "image-preparation-failed"
    ? { ...event, error: deserializeError(event.error) } : event;
}

export function decodeLicenseStatus(value: unknown): LicenseStatus {
  const status = record(value, "license status");
  switch (status["tier"]) {
    case "development": exactKeys(status, ["tier"]); return { tier: "development" };
    case "licensed": {
      exactKeys(status, ["tier", "licenseId", "licensee", "expiresAt", "selfHost", "telemetry", "commercial", "validity", "validUntil"]);
      const licenseId = string(status["licenseId"], "license id");
      if (!/^[0-9a-f]{32}$/u.test(licenseId)) throw protocol("license id is invalid");
      const licensee = string(status["licensee"], "licensee");
      if (new TextEncoder().encode(licensee).length > 64) throw protocol("licensee is invalid");
      const expiresAt = integer(status["expiresAt"], "license expiry", 0);
      const validUntil = integer(status["validUntil"], "license grace end", expiresAt + 1);
      return { tier: "licensed", licenseId, licensee, expiresAt, validUntil,
        commercial: boolean(status["commercial"], "commercial license"), validity: oneOf(status["validity"], ["active", "grace"] as const, "license validity"),
        selfHost: boolean(status["selfHost"], "self-host license"), telemetry: boolean(status["telemetry"], "license telemetry") };
    }
    default: throw protocol("license tier is invalid");
  }
}

function decodeTerminal(value: unknown): TerminalWire {
  const terminal = record(value, "resumed terminal");
  if (terminal["source"] === "console") {
    exactKeys(terminal, ["source", "key", "screenTail"]);
    if (terminal["key"] !== "console") throw protocol("console terminal key is invalid");
    return { source: "console", key: "console", screenTail: bytes(terminal["screenTail"], MAX_TAIL_BYTES) };
  }
  if (terminal["source"] !== "process") throw protocol("resumed terminal source is invalid");
  exactKeys(terminal, ["source", "key", "command", "screenTail"]);
  return { source: "process", key: bounded(terminal["key"], "terminal key", 128), command: bounded(terminal["command"], "terminal command", MAX_TEXT), screenTail: bytes(terminal["screenTail"], MAX_TAIL_BYTES) };
}

function decodePersistence(value: unknown): WorkspacePersistence {
  const persistence = record(value, "workspace persistence");
  if (persistence["kind"] === "ephemeral") { exactKeys(persistence, ["kind"]); return { kind: "ephemeral" }; }
  if (persistence["kind"] !== "persistent") throw protocol("workspace persistence is invalid");
  exactKeys(persistence, ["kind", "backend", "browserRetention"]);
  const backend = persistence["backend"];
  const retention = persistence["browserRetention"];
  if ((backend !== "opfs" && backend !== "indexeddb") || (retention !== "best-effort" && retention !== "granted")) throw protocol("workspace persistence is invalid");
  return { kind: "persistent", backend, browserRetention: retention };
}

function decodeCapabilities(value: unknown): VMCapabilities {
  const capabilities = record(value, "VM capabilities");
  exactKeys(capabilities, ["previews", "snapshots", "maximumVcpus", "commandAcceleration", "crossOriginIsolated"]);
  const maximumVcpus = capabilities["maximumVcpus"];
  if (maximumVcpus !== 1 && maximumVcpus !== 2 && maximumVcpus !== 3 && maximumVcpus !== 4) throw protocol("maximum vCPUs are invalid");
  return {
    previews: decodeSupport(capabilities["previews"]), snapshots: decodeSupport(capabilities["snapshots"]), maximumVcpus,
    commandAcceleration: decodeSupport(capabilities["commandAcceleration"]),
    crossOriginIsolated: boolean(capabilities["crossOriginIsolated"], "cross-origin isolation"),
  };
}

function decodeSupport(value: unknown): FeatureSupport {
  const support = record(value, "feature support");
  if (support["available"] === true) { exactKeys(support, ["available"]); return { available: true }; }
  exactKeys(support, ["available", "reason"]);
  if (support["available"] !== false) throw protocol("feature support is invalid");
  return { available: false, reason: oneOf(support["reason"], UNAVAILABLE, "unavailable reason") };
}

/** The result of a request that answers with nothing. */
export function decodeUnit(value: unknown): void {
  if (value !== undefined && value !== null) throw protocol("the frame returned a value where none was expected");
}

function oneOf<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  const found = values.find(candidate => candidate === value);
  if (found === undefined) throw protocol(`${label} is invalid`);
  return found;
}

function bounded(value: unknown, label: string, maximum: number): string {
  const text = string(value, label);
  if (text.length === 0 || text.length > maximum) throw protocol(`${label} is invalid`);
  return text;
}

function bytes(value: unknown, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > maximum) throw protocol("frame bytes are invalid");
  return value;
}

function protocol(message: string): VMError {
  return new VMError("PROTOCOL_ERROR", message);
}
