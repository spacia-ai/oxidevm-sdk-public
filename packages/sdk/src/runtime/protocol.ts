export type {Operation,OperationRequest,OperationResponse,OperationDecoders} from "./protocol/operations.js";
import type {Operation,OperationDecoders} from "./protocol/operations.js";
import {decodeCurrentSystemImage,type CurrentSystemImage} from "./protocol/current-system-image.js";
import type { ImagePreparation } from "../values.js";
import {decodeInitialStartState,type InitialStartState} from "./protocol/initial-start.js";
import {decodeShippedInstallIdentity,type ShippedInstallIdentity,type ShippedSource} from "./protocol/shipped-source.js";
export * from "./protocol/initial-start.js";
import {decodeImageInfo} from "../image.js";
import type {PreparedImageIdentity} from "./protocol/storage.js";
export type { PreparedImageIdentity } from "./protocol/storage.js";
import {decodeSelectedNativeFiles,type SelectedNativeFiles} from "./protocol/native-start-files.js";
import {decodePreparedStartImage,type PreparedStartImage,type InspectStartImageRequest} from "./protocol/start-image.js";
import { decodeNativeCheckpointControl, isNativeCheckpointControl, nativeCheckpointControlDecoders, type NativeCheckpointControlOperations, type NativeCheckpointControlRequest } from "./protocol/userspace-checkpoint-control.js";
import { decodeCancel, decodeRequestBase, decodeMessagePort, decodeDiskBridge, type RequestBase, type CancelRequest } from "./protocol/request-base.js";
import type { StorageRequest, StorageIncoming } from "./protocol/storage-requests.js";
export { decodeStorageIncoming } from "./protocol/storage-requests.js";
export type { StorageRequest, StorageIncoming, CancelRequest };
import { decodeFileControl, isFileControlType, fileResponseDecoders, type FileControlOperations, type FileControlRequest } from "./protocol/workspace-files.js";
import { decodeSystemConsoleControl, isSystemConsoleControl, systemConsoleResponseDecoders, type SystemConsoleOperations, type SystemConsoleRequest } from "./protocol/system-console.js";
export { validateSystemConsoleInput } from "./protocol/system-console.js";
import { decodeWorkspacePublicationResult, type WorkspacePublication, type WorkspacePublicationResult } from "./protocol/workspace-publication.js";
import { assistanceResponseDecoders, decodeAssistanceControl, isAssistanceControl, type AssistanceControlOperations, type AssistanceControlRequest } from "./protocol/assistance-control.js";
import { decodeNetworkLinkControl, isNetworkLinkControl, networkLinkResponseDecoders, type NetworkLinkControlOperations, type NetworkLinkControlRequest } from "./protocol/network-link-control.js";
import { decodeListenerControl, isListenerControlType, listenerResponseDecoders, type ListenerControlOperations, type ListenerControlRequest } from "./protocol/listening-ports.js";
import { boolean, exactKeys, integer, record, string } from "./decode.js";
import { VMError } from "./errors.js";
import { MAX_AGENT_PAYLOAD_BYTES } from "./agent-protocol.js";
import type { AgentHello, AgentSpawnResult, ResumedWorkspace } from "./protocol/agent.js";
import type { BackupDestination } from "../backup-destination.js";
export * from "./protocol/shipped-source.js";
import {
  decodeAgentCommand,
  decodeAgentHello,
  decodeAgentPath,
  decodeAgentSpawnResult,
  decodeResumedWorkspace,
  decodeEnvironment,
  decodeStringArray,
  validateAgentBytes,
} from "./protocol/agent.js";
import {
  MAX_AGENT_WAIT_MILLISECONDS,
  MAX_CORE_PROBE_BYTES,
  MAX_CORE_PROBE_STEPS,
  MAX_SYSTEM_ASSET_BYTES,
  MAX_SYSTEM_COMMAND_LINE_BYTES,
  MAX_SYSTEM_PROBE_STEPS,
  MAX_SYSTEM_SLICE_STEPS,
  MAX_SYSTEM_TRACE_EVENTS,
  type PROTOCOL_VERSION,
} from "./protocol/common.js";
import {
  type CoreProbeResult,
  decodeCoreProbeResult,
} from "./protocol/core.js";
import {
  decodeBytes,
  decodeUndefined,
} from "./protocol/decoders.js";
import { validateSystemAotTrainingBundle } from "./protocol/system-aot-training-bundle.js";
import {
  decodeJitInstallMode,
  type SystemJitInstallMode,
} from "./protocol/system-trace-background-compile.js";
import type {
  ManagedBoot,
  PreparedUserspaceRootfs,
  PreparedManagedImage,
  WorkspaceEntry,
} from "./protocol/storage.js";
import {
  decodePreparedUserspaceRootfs,
  decodePreparedManagedImage,
  decodePreparedSystemAot,
  decodeWorkspaceEntries,
} from "./protocol/storage.js";
import {
  decodeInterpretedRipRanges,
  decodeInterpretedSemantics,
  decodeSystemTraceSnapshot,
} from "./protocol/system-trace.js";
import {
  type SystemProbeResult,
  type SystemSliceResult,
  type SystemTraceRipRange,
  type SystemTraceSnapshot,
  decodeSystemProbeResult,
  decodeSystemSliceResult,
} from "./protocol/system.js";
import {
  type BackupExportResult,
  type BackupInspection,
  decodeBackupExportResult,
  decodeBackupInspection,
} from "./protocol/snapshot-archive.js";
import {
  type AutoSaveHint,
  decodeCaptureFields,
  decodeRestoredSnapshot,
  decodeSnapshotControlRequest,
  decodeSnapshotInfo,
  decodeSnapshotInfos,
  decodeSnapshotRef,
  decodeSnapshotUsage,
  isSnapshotControlType,
  type NamedSnapshotKind,
  type RestoredSnapshot,
  type SnapshotControlRequest,
  type SnapshotInfo,
  type SnapshotMachine,
  type SnapshotRef,
  type SnapshotUsage,
  validateAppData,
} from "./protocol/snapshots.js";
import { validateWorkspaceId } from "./workspace-path.js";

export * from "./protocol/agent.js";
export * from "./protocol/common.js";
export * from "./protocol/workspace-publication.js";
export * from "./protocol/workspace-restore.js";
export * from "./protocol/workspace-read.js";
export * from "./protocol/core.js";
export * from "./protocol/decoders.js";
export * from "./protocol/snapshots.js";
export * from "./protocol/snapshot-archive.js";
export * from "./protocol/storage.js";
export * from "./protocol/system-aot-training-bundle.js";
export * from "./protocol/system-aot.js";
export * from "./protocol/system-trace.js";
export { SYSTEM_TRACE_SCHEMA_VERSION } from "./protocol/system-trace-schema.js";
export * from "./protocol/system.js";

export interface RuntimeVMCapabilities {
  readonly execution: "parallel-shared-memory" | "serialized";
  readonly vcpus: 1 | 2 | 3 | 4;
  readonly sharedMemory: boolean;
}

export interface ControlOperations extends NativeCheckpointControlOperations, AssistanceControlOperations, NetworkLinkControlOperations, ListenerControlOperations, FileControlOperations, SystemConsoleOperations {
  readonly initialize: Operation<
    {
      readonly coreWasmUrl: string;
      readonly sharedCoreWasmUrl: string;
      readonly workspaceId: string;
      readonly memoryMiB: number;
      readonly vcpus: 1 | 2 | 3 | 4;
      readonly snapshotPort: InstanceType<typeof MessagePort>;
      readonly diskBridge?: SharedArrayBuffer;
      readonly diskPort?: InstanceType<typeof MessagePort>;
    },
    RuntimeVMCapabilities
  >;
  readonly "run-core-probe": Operation<
    {
      readonly program: Uint8Array;
      readonly maximumSteps: number;
    },
    CoreProbeResult
  >;
  readonly "run-system-probe": Operation<
    {
      readonly memoryMiB: number;
      readonly kernel: Uint8Array;
      readonly initrd?: Uint8Array;
      readonly disk?: Uint8Array;
      readonly hostDiskBytes?: number;
      readonly commandLine: string;
      readonly maximumSteps: number;
    },
    SystemProbeResult
  >;
  readonly "boot-system": Operation<
    {
      readonly console?: "serial" | "virtio";
      readonly memoryMiB: number;
      readonly kernel: Uint8Array;
      readonly initrd?: Uint8Array;
      readonly disk?: Uint8Array;
      readonly hostDiskBytes?: number;
      readonly commandLine: string;
    },
    undefined
  >;
  readonly "configure-system-aot": Operation<
    { readonly configuration: PreparedManagedImage["aot"] },
    undefined
  >;
  readonly "quiesce-disk": Operation<undefined, undefined>;
  readonly "run-system-slice": Operation<
    { readonly maximumSteps: number },
    SystemSliceResult
  >;
  readonly "start-system": Operation<
    {
      readonly sessionId: number;
      readonly port: InstanceType<typeof MessagePort>;
    },
    undefined
  >;
  readonly "pause-system": Operation<
    { readonly sessionId: number },
    undefined
  >;
  readonly "resume-system": Operation<
    { readonly sessionId: number },
    undefined
  >;
  readonly "stop-system": Operation<
    { readonly sessionId: number },
    undefined
  >;
  readonly "configure-system-trace": Operation<
    {
      readonly capacity: number;
      readonly interpreterOnly: boolean;
      readonly interpretedSemantics: readonly number[];
      readonly interpretedRipRanges: readonly SystemTraceRipRange[];
      readonly checkpointPolicy: "faults-and-stderr" | "faults-only";
    },
    undefined
  >;
  readonly "read-system-trace": Operation<undefined, SystemTraceSnapshot>;
  readonly "read-system-aot-training": Operation<undefined, Uint8Array>;
  readonly snapshot: Operation<{ readonly label?: string; readonly kind?: NamedSnapshotKind }, SnapshotRef>;
  readonly restore: Operation<{ readonly snapshot: SnapshotRef;readonly initialStart?:ShippedInstallIdentity }, RestoredSnapshot>;
  /** Sets the page data (at most 1 MiB) later restore points carry; null for none. */
  readonly "snapshot-app-data": Operation<{ readonly data: Uint8Array | null }, undefined>;
  /** Sends this VM's restore point events to `port`. */
  readonly "snapshot-events": Operation<{ readonly port: InstanceType<typeof MessagePort> }, undefined>;
  readonly "auto-save-configure": Operation<{ readonly enabled: boolean }, undefined>;
  readonly "auto-save-hint": Operation<{ readonly hint: AutoSaveHint }, undefined>;
  readonly "wait-agent": Operation<
    { readonly timeoutMilliseconds: number },
    AgentHello
  >;
  /** Reseeds a restored guest's entropy pool and steps its paused clock to the host's. */
  readonly "agent-refresh-guest": Operation<undefined, undefined>;
  /** Carries the workspace store's changes since `snapshot` was saved into the restored guest. */
  readonly "agent-reconcile-workspace": Operation<{ readonly snapshot: SnapshotRef }, ResumedWorkspace>;
  readonly "agent-read-file": Operation<
    { readonly path: string },
    Uint8Array
  >;
  readonly "agent-write-file": Operation<
    { readonly path: string; readonly data: Uint8Array },
    undefined
  >;
  readonly "agent-list": Operation<
    { readonly path: string },
    WorkspaceEntry[]
  >;
  readonly "agent-workspace-manifest": Operation<undefined, Uint8Array>;
  readonly "agent-workspace-delta": Operation<undefined, Uint8Array>;
  readonly "agent-apply-workspace": Operation<{ readonly data: Uint8Array }, undefined>;
  readonly "agent-apply-workspace-delta": Operation<{ readonly data: Uint8Array }, undefined>;
  readonly "agent-restore-workspace": Operation<{ readonly workspaceBaseSha256: string }, boolean>;
  readonly "agent-sync-workspace": Operation<{ readonly workspaceBaseSha256: string }, boolean>;
  readonly "agent-remove": Operation<
    { readonly path: string; readonly recursive: boolean },
    undefined
  >;
  readonly "agent-spawn": Operation<
    {
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly guestPaths?: boolean;
      readonly terminal?: { readonly columns: number; readonly rows: number };
      readonly port: InstanceType<typeof MessagePort>;
    },
    AgentSpawnResult
  >;
  /** Gives a page to a process restored with a snapshot; its screen replays first. */
  readonly "agent-attach-process": Operation<
    { readonly agentRequestId: number; readonly port: InstanceType<typeof MessagePort> },
    AgentSpawnResult
  >;
  readonly "agent-stdin": Operation<
    { readonly pid: number; readonly data: Uint8Array },
    number
  >;
  readonly "agent-close-stdin": Operation<
    { readonly pid: number },
    undefined
  >;
  readonly "agent-signal": Operation<
    { readonly pid: number; readonly signal: "TERM" | "KILL" | "INT" | "HUP" },
    undefined
  >;
  readonly "agent-process-control": Operation<{ readonly pid: number; readonly sessionId: number; readonly control: ProcessControl }, undefined>;
  readonly dispose: Operation<undefined, undefined>;
}

export interface StorageOperations {
  readonly "check-system-update": Operation<{ readonly manifestUrl: string; readonly manifestSHA256?: string; readonly trustedKeyId?: string; readonly trustedPublicKey?: Uint8Array }, { readonly id: string; readonly version: string } | null>;
  readonly "prepare-current-system-image": Operation<undefined, undefined>;
  readonly "initial-start-state":Operation<undefined,InitialStartState>;
  readonly "initial-start-retire":Operation<undefined,undefined>;
  readonly "initial-start-begin":Operation<{readonly source:ShippedInstallIdentity},InitialStartState>;
  readonly "current-system-image":Operation<undefined,CurrentSystemImage>;
  readonly "current-userspace-rootfs":Operation<undefined,PreparedUserspaceRootfs>;
  readonly "current-userspace-image":Operation<undefined,PreparedImageIdentity>;
  readonly "abort-userspace-files":Operation<{readonly sourceId:string},undefined>;
  readonly "select-userspace-files":Operation<{readonly boot:ManagedBoot;readonly rootTreeSha256:string;readonly rootPersistence:"ephemeral"|"persistent"},SelectedNativeFiles>;
  readonly "inspect-start-image":Operation<InspectStartImageRequest,PreparedStartImage|null>;
  readonly "erase-local-data": Operation<undefined, undefined>;
  readonly initialize: Operation<
    {
      readonly workspaceId: string;
      readonly snapshotPort: InstanceType<typeof MessagePort>;
      readonly ephemeral?: boolean;
      readonly rootfsNetworkPort?: InstanceType<typeof MessagePort>;
      readonly userspaceStoragePort?: InstanceType<typeof MessagePort>;
      readonly diskBridge?: SharedArrayBuffer;
      readonly diskPort?: InstanceType<typeof MessagePort>;
      /** A full-system VM's shape, which its restore points must fit. */
      readonly machine?: SnapshotMachine;
    },
    undefined
  >;
  readonly "snapshot-list": Operation<undefined, readonly SnapshotInfo[]>;
  readonly "workspace-persistence": Operation<undefined, "opfs" | "indexeddb">;
  readonly "snapshot-rename": Operation<{ readonly snapshot: SnapshotRef; readonly label: string }, SnapshotInfo>;
  readonly "snapshot-delete": Operation<{ readonly snapshot: SnapshotRef }, undefined>;
  readonly "snapshot-usage": Operation<undefined, SnapshotUsage>;
  /** The restore point the VM last matched, then the automatic saves before it, newest first. */
  readonly "snapshot-resume-candidates": Operation<undefined, readonly SnapshotInfo[]>;
  readonly "snapshot-export": Operation<
    { readonly snapshot: SnapshotRef; readonly destination?: BackupDestination; readonly progress: InstanceType<typeof MessagePort> },
    BackupExportResult
  >;
  readonly "snapshot-import": Operation<{ readonly file: Blob; readonly progress: InstanceType<typeof MessagePort> }, SnapshotInfo>;
  readonly "snapshot-inspect": Operation<{ readonly file: Blob }, BackupInspection>;
  readonly "snapshot-install-shipped": Operation<
    {
      readonly name: string;
      readonly trustedKeyId: string;
      readonly trustedPublicKey: Uint8Array;
      readonly progress: InstanceType<typeof MessagePort>;
      readonly source?: ShippedSource;
    },
    SnapshotInfo
  >;
  readonly "prepare-managed-image": Operation<
    {
      readonly imagePreparation?: ImagePreparation;
      readonly manifestUrl: string;
      readonly trustedKeyId?: string;
      readonly manifestSHA256?: string;
      readonly trustedPublicKey?: Uint8Array;
      readonly boot?: ManagedBoot;
      readonly cachedOnly?: boolean;
    },
    PreparedManagedImage
  >;
  readonly "prepare-userspace-rootfs": Operation<
    { readonly manifestUrl: string; readonly trustedKeyId: string; readonly trustedPublicKey: Uint8Array; readonly manifestSHA256?: string; readonly cachedOnly?: boolean; readonly boot?:ManagedBoot; readonly imagePreparation?: ImagePreparation },
    PreparedUserspaceRootfs
  >;
  readonly "check-userspace-update": Operation<
    { readonly manifestUrl:string; readonly manifestSHA256?:string; readonly trustedKeyId:string; readonly trustedPublicKey:Uint8Array },
    { readonly id:string; readonly version:string } | null
  >;
  readonly "read-rootfs-file": Operation<{ readonly path: string }, Uint8Array>;
  readonly "read-file": Operation<{ readonly path: string }, Uint8Array>;
  readonly "write-file": Operation<
    { readonly path: string; readonly data: Uint8Array },
    undefined
  >;
  readonly list: Operation<{ readonly path: string }, WorkspaceEntry[]>;
  readonly remove: Operation<
    { readonly path: string; readonly recursive: boolean },
    undefined
  >;
  readonly "commit-workspace-streams": Operation<{ readonly publication: WorkspacePublication }, WorkspacePublicationResult>;
  readonly "commit-workspace-snapshot": Operation<
    { readonly workspaceBaseSha256: string; readonly data: Uint8Array },
    number
  >;
  readonly "commit-workspace-delta": Operation<
    { readonly workspaceBaseSha256: string; readonly data: Uint8Array },
    number
  >;
  readonly "read-workspace-snapshot": Operation<
    { readonly workspaceBaseSha256: string },
    Uint8Array | undefined
  >;
  readonly "read-workspace-delta": Operation<
    { readonly workspaceBaseSha256: string },
    Uint8Array | undefined
  >;
  readonly dispose: Operation<undefined, undefined>;
}

export const controlResponseDecoders: OperationDecoders<ControlOperations> = {
  ...assistanceResponseDecoders,
  ...networkLinkResponseDecoders,
  ...listenerResponseDecoders,
  ...fileResponseDecoders,
  ...systemConsoleResponseDecoders,
  ...nativeCheckpointControlDecoders,
  initialize: decodeRuntimeVMCapabilities,
  "run-core-probe": decodeCoreProbeResult,
  "run-system-probe": decodeSystemProbeResult,
  "boot-system": decodeUndefined,
  "configure-system-aot": decodeUndefined,
  "quiesce-disk": decodeUndefined,
  "run-system-slice": decodeSystemSliceResult,
  "start-system": decodeUndefined,
  "pause-system": decodeUndefined,
  "resume-system": decodeUndefined,
  "stop-system": decodeUndefined,
  "configure-system-trace": decodeUndefined,
  "read-system-trace": decodeSystemTraceSnapshot,
  "read-system-aot-training": validateSystemAotTrainingBundle,
  snapshot: decodeSnapshotRef,
  restore: decodeRestoredSnapshot,
  "snapshot-app-data": decodeUndefined,
  "snapshot-events": decodeUndefined,
  "auto-save-configure": decodeUndefined,
  "auto-save-hint": decodeUndefined,
  "wait-agent": decodeAgentHello,
  "agent-refresh-guest": decodeUndefined,
  "agent-reconcile-workspace": decodeResumedWorkspace,
  "agent-read-file": decodeBytes,
  "agent-write-file": decodeUndefined,
  "agent-list": decodeWorkspaceEntries,
  "agent-workspace-manifest": decodeBytes,
  "agent-workspace-delta": decodeBytes,
  "agent-apply-workspace": decodeUndefined,
  "agent-apply-workspace-delta": decodeUndefined,
  "agent-restore-workspace": value => boolean(value, "streamed workspace restoration"),
  "agent-sync-workspace": value => boolean(value, "streamed workspace synchronization"),
  "agent-remove": decodeUndefined,
  "agent-spawn": decodeAgentSpawnResult,
  "agent-attach-process": decodeAgentSpawnResult,
  "agent-stdin": (value) => integer(value, "accepted agent stdin bytes", 0),
  "agent-close-stdin": decodeUndefined,
  "agent-signal": decodeUndefined,
  "agent-process-control": decodeUndefined,
  dispose: decodeUndefined,
};

function decodeRuntimeVMCapabilities(value: unknown): RuntimeVMCapabilities {
  const capabilities = record(value, "RuntimeVM capabilities");
  exactKeys(capabilities, ["execution", "vcpus", "sharedMemory"]);
  const execution = string(capabilities["execution"], "execution capability");
  if (execution !== "parallel-shared-memory" && execution !== "serialized") {
    throw new VMError("PROTOCOL_ERROR", "execution capability is invalid");
  }
  return {
    execution,
    vcpus: decodeVcpuCount(capabilities["vcpus"]),
    sharedMemory: boolean(capabilities["sharedMemory"], "sharedMemory capability"),
  };
}

export const storageResponseDecoders: OperationDecoders<StorageOperations> = {
  "check-system-update": value => {
    if(value===null)return null;
    const offer=record(value,"image update");exactKeys(offer,["id","version"]);
    return {id:string(offer["id"],"image id"),version:string(offer["version"],"image version")};
  },
  "prepare-current-system-image": decodeUndefined,
  "initial-start-state":decodeInitialStartState,
  "initial-start-retire":decodeUndefined,
  "initial-start-begin":decodeInitialStartState,
  "current-system-image":decodeCurrentSystemImage,
  "current-userspace-image":decodeImageInfo,
  "current-userspace-rootfs":decodePreparedUserspaceRootfs,
  "abort-userspace-files":decodeUndefined,
  "select-userspace-files":decodeSelectedNativeFiles,
  "inspect-start-image":decodePreparedStartImage,
  "erase-local-data": decodeUndefined,
  "workspace-persistence": value => {
    if (value !== "opfs" && value !== "indexeddb") throw new VMError("PROTOCOL_ERROR", "storage backend must be durable OPFS or IndexedDB");
    return value;
  },
  initialize: decodeUndefined,
  "snapshot-list": decodeSnapshotInfos,
  "snapshot-rename": decodeSnapshotInfo,
  "snapshot-delete": decodeUndefined,
  "snapshot-usage": decodeSnapshotUsage,
  "snapshot-resume-candidates": decodeSnapshotInfos,
  "snapshot-export": decodeBackupExportResult,
  "snapshot-import": decodeSnapshotInfo,
  "snapshot-inspect": decodeBackupInspection,
  "snapshot-install-shipped": decodeSnapshotInfo,
  "prepare-managed-image": decodePreparedManagedImage,
  "prepare-userspace-rootfs": decodePreparedUserspaceRootfs,
  "check-userspace-update": value => {
    if(value===null)return null;
    const offer=record(value,"image update");exactKeys(offer,["id","version"]);
    return {id:string(offer["id"],"image id"),version:string(offer["version"],"image version")};
  },
  "read-rootfs-file": decodeBytes,
  "read-file": decodeBytes,
  "write-file": decodeUndefined,
  list: decodeWorkspaceEntries,
  remove: decodeUndefined,
  "commit-workspace-streams": decodeWorkspacePublicationResult,
  "commit-workspace-snapshot": (value) => integer(value, "workspace generation", 1),
  "commit-workspace-delta": (value) => integer(value, "workspace generation", 1),
  "read-workspace-snapshot": (value) => value === undefined ? undefined : decodeBytes(value),
  "read-workspace-delta": (value) => value === undefined ? undefined : decodeBytes(value),
  dispose: decodeUndefined,
};

export type ControlRequest =
  | NativeCheckpointControlRequest
  | SystemConsoleRequest
  | (RequestBase & { readonly type: "agent-process-control"; readonly pid: number; readonly sessionId: number; readonly control: ProcessControl })
  | AssistanceControlRequest
  | NetworkLinkControlRequest
  | ListenerControlRequest
  | FileControlRequest
  | (RequestBase & {
      readonly type: "initialize";
      readonly coreWasmUrl: string;
      readonly sharedCoreWasmUrl: string;
      readonly workspaceId: string;
      /** The VM's RAM; restores are checked against it before any destructive step. */
      readonly memoryMiB: number;
      readonly vcpus: 1 | 2 | 3 | 4;
      readonly snapshotPort: InstanceType<typeof MessagePort>;
      readonly diskBridge?: SharedArrayBuffer;
      readonly diskPort?: InstanceType<typeof MessagePort>;
      /** Diagnostic override of how Tier-1 modules are installed. */
      readonly jitInstall?: SystemJitInstallMode;
    })
  | (RequestBase & {
      readonly type: "run-core-probe";
      readonly program: Uint8Array;
      readonly maximumSteps: number;
    })
  | (RequestBase & {
      readonly type: "run-system-probe";
      readonly memoryMiB: number;
      readonly kernel: Uint8Array;
      readonly initrd?: Uint8Array;
      readonly disk?: Uint8Array;
      readonly hostDiskBytes?: number;
      readonly commandLine: string;
      readonly maximumSteps: number;
    })
  | (RequestBase & {
      readonly type: "boot-system";
      readonly console?: "serial" | "virtio";
      readonly memoryMiB: number;
      readonly kernel: Uint8Array;
      readonly initrd?: Uint8Array;
      readonly disk?: Uint8Array;
      readonly hostDiskBytes?: number;
      readonly commandLine: string;
    })
  | (RequestBase & {
      readonly type: "configure-system-aot";
      readonly configuration: PreparedManagedImage["aot"];
    })
  | (RequestBase & { readonly type: "quiesce-disk" })
  | (RequestBase & {
      readonly type: "run-system-slice";
      readonly maximumSteps: number;
    })
  | (RequestBase & {
      readonly type: "start-system";
      readonly sessionId: number;
      readonly port: InstanceType<typeof MessagePort>;
    })
  | (RequestBase & {
      readonly type: "pause-system" | "resume-system" | "stop-system";
      readonly sessionId: number;
    })
  | (RequestBase & {
      readonly type: "configure-system-trace";
      readonly capacity: number;
      readonly interpreterOnly: boolean;
      readonly interpretedSemantics: readonly number[];
      readonly interpretedRipRanges: readonly SystemTraceRipRange[];
      readonly checkpointPolicy: "faults-and-stderr" | "faults-only";
    })
  | (RequestBase & {
      readonly type: "read-system-trace";
    })
  | (RequestBase & {
      readonly type: "read-system-aot-training";
    })
  | (RequestBase & {
      readonly type: "snapshot";
      readonly label?: string;
      readonly kind?: NamedSnapshotKind;
    })
  | (RequestBase & { readonly type: "snapshot-app-data"; readonly data: Uint8Array | null })
  | (RequestBase & SnapshotControlRequest)
  | (RequestBase & {
      readonly type: "restore" | "agent-reconcile-workspace";
      readonly snapshot: SnapshotRef;
      readonly initialStart?:ShippedInstallIdentity;
    })
  | (RequestBase & {
      readonly type: "wait-agent";
      readonly timeoutMilliseconds: number;
    })
  | (RequestBase & {
      readonly type: "agent-read-file" | "agent-list";
      readonly path: string;
    })
  | (RequestBase & { readonly type: "agent-workspace-manifest" })
  | (RequestBase & { readonly type: "agent-workspace-delta" | "agent-refresh-guest" })
  | (RequestBase & { readonly type: "agent-apply-workspace"; readonly data: Uint8Array })
  | (RequestBase & { readonly type: "agent-apply-workspace-delta"; readonly data: Uint8Array })
  | (RequestBase & { readonly type: "agent-restore-workspace"; readonly workspaceBaseSha256: string })
  | (RequestBase & { readonly type: "agent-sync-workspace"; readonly workspaceBaseSha256: string })
  | (RequestBase & {
      readonly type: "agent-write-file";
      readonly path: string;
      readonly data: Uint8Array;
    })
  | (RequestBase & {
      readonly type: "agent-remove";
      readonly path: string;
      readonly recursive: boolean;
    })
  | (RequestBase & {
      readonly type: "agent-spawn";
      readonly command: string;
      readonly args: readonly string[];
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly guestPaths?: boolean;
      readonly terminal?: { readonly columns: number; readonly rows: number };
      readonly port: InstanceType<typeof MessagePort>;
    })
  | (RequestBase & {
      readonly type: "agent-attach-process";
      readonly agentRequestId: number;
      readonly port: InstanceType<typeof MessagePort>;
    })
  | (RequestBase & {
      readonly type: "agent-stdin";
      readonly pid: number;
      readonly data: Uint8Array;
    })
  | (RequestBase & {
      readonly type: "agent-close-stdin";
      readonly pid: number;
    })
  | (RequestBase & {
      readonly type: "agent-signal";
      readonly pid: number;
      readonly signal: "TERM" | "KILL" | "INT" | "HUP";
    })
  | (RequestBase & { readonly type: "dispose" });

export type ControlIncoming = ControlRequest | CancelRequest;

export type WorkerResponse =
  | {
      readonly id: number;
      readonly version: typeof PROTOCOL_VERSION;
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly id: number;
      readonly version: typeof PROTOCOL_VERSION;
      readonly ok: false;
      readonly error: unknown;
    };

export function validateCoreProbeInput(
  programBytes: number,
  maximumSteps: number,
): void {
  if (
    !Number.isInteger(maximumSteps) ||
    maximumSteps < 1 ||
    maximumSteps > MAX_CORE_PROBE_STEPS
  ) {
    throw new VMError(
      "INVALID_ARGUMENT",
      `maximumSteps must be an integer from 1 to ${MAX_CORE_PROBE_STEPS.toLocaleString("en-US")}`,
    );
  }
  if (
    !Number.isInteger(programBytes) ||
    programBytes < 0 ||
    programBytes > MAX_CORE_PROBE_BYTES
  ) {
    throw new VMError(
      "INVALID_ARGUMENT",
      `diagnostic programs are limited to ${MAX_CORE_PROBE_BYTES / 1024} KiB`,
    );
  }
}

export function validateSystemProbeInput(
  memoryMiB: number,
  kernelBytes: number,
  initrdBytes: number,
  diskBytes: number,
  commandLine: string,
  maximumSteps: number,
): void {
  validateSystemBootInput(
    memoryMiB,
    kernelBytes,
    initrdBytes,
    diskBytes,
    commandLine,
  );
  validateMaximumSteps(maximumSteps, MAX_SYSTEM_PROBE_STEPS);
}

export function validateSystemBootInput(
  memoryMiB: number,
  kernelBytes: number,
  initrdBytes: number,
  diskBytes: number,
  commandLine: string,
): void {
  if (!Number.isInteger(memoryMiB) || memoryMiB < 16 || memoryMiB > 3072) {
    throw new VMError(
      "INVALID_ARGUMENT",
      "memoryMiB must be an integer from 16 to 3072",
    );
  }
  for (const [label, length, required] of [
    ["kernel", kernelBytes, true],
    ["initrd", initrdBytes, false],
    ["disk", diskBytes, false],
  ] as const) {
    if (
      !Number.isInteger(length) ||
      length < (required ? 1 : 0) ||
      length > MAX_SYSTEM_ASSET_BYTES
    ) {
      throw new VMError(
        "INVALID_ARGUMENT",
        `${label} must be ${required ? "non-empty and " : ""}at most ${MAX_SYSTEM_ASSET_BYTES / 1024 / 1024} MiB`,
      );
    }
  }
  const commandBytes = new TextEncoder().encode(commandLine).byteLength;
  if (
    commandBytes === 0 ||
    commandBytes > MAX_SYSTEM_COMMAND_LINE_BYTES ||
    commandLine.includes("\0")
  ) {
    throw new VMError(
      "INVALID_ARGUMENT",
      `commandLine must be 1 to ${MAX_SYSTEM_COMMAND_LINE_BYTES} UTF-8 bytes without NUL`,
    );
  }
}

export function validateSystemSliceInput(maximumSteps: number): void {
  validateMaximumSteps(maximumSteps, MAX_SYSTEM_SLICE_STEPS);
}

export function decodeControlIncoming(value: unknown): ControlIncoming {
  const message = record(value, "control request");
  const type = string(message["type"], "request type");
  if (type === "cancel") return decodeCancel(message);
  if (isAssistanceControl(type)) return decodeAssistanceControl(message);
  if (isNetworkLinkControl(type)) return decodeNetworkLinkControl(message);
  if (isFileControlType(type)) return decodeFileControl(message);
  if (isSystemConsoleControl(type)) return decodeSystemConsoleControl(message);
  if (isListenerControlType(type)) return decodeListenerControl(message);
  const base = decodeRequestBase(message);
  if (isNativeCheckpointControl(type)) return decodeNativeCheckpointControl(message, base, type);
  if (isSnapshotControlType(type)) return { ...base, ...decodeSnapshotControlRequest(message, type) };
  switch (type) {
    case "initialize":
      exactKeys(
        message,
        ["id", "version", "type", "coreWasmUrl", "sharedCoreWasmUrl", "workspaceId", "memoryMiB", "vcpus", "snapshotPort"],
        ["diskBridge", "diskPort", "jitInstall"],
      );
      return {
        ...base,
        type,
        coreWasmUrl: string(message["coreWasmUrl"], "coreWasmUrl"),
        sharedCoreWasmUrl: string(message["sharedCoreWasmUrl"], "sharedCoreWasmUrl"),
        memoryMiB: integer(message["memoryMiB"], "memoryMiB", 16, 3072),
        vcpus: decodeVcpuCount(message["vcpus"]),
        workspaceId: validateWorkspaceId(
          string(message["workspaceId"], "workspaceId"),
        ),
        snapshotPort: decodeMessagePort(message["snapshotPort"], "snapshotPort"),
        ...decodeDiskBridge(message),
        ...(message["jitInstall"] === undefined
          ? {}
          : { jitInstall: decodeJitInstallMode(message["jitInstall"]) }),
      };
    case "run-core-probe": {
      exactKeys(message, [
        "id",
        "version",
        "type",
        "program",
        "maximumSteps",
      ]);
      const program = decodeBytes(message["program"]);
      const maximumSteps = integer(
        message["maximumSteps"],
        "maximumSteps",
        1,
        MAX_CORE_PROBE_STEPS,
      );
      validateCoreProbeInput(program.byteLength, maximumSteps);
      return { ...base, type, program, maximumSteps };
    }
    case "run-system-probe": {
      exactKeys(
        message,
        [
          "id",
          "version",
          "type",
          "memoryMiB",
          "kernel",
          "commandLine",
          "maximumSteps",
        ],
        ["initrd", "disk", "hostDiskBytes"],
      );
      const memoryMiB = integer(message["memoryMiB"], "memoryMiB", 16, 3072);
      const kernel = decodeBytes(message["kernel"]);
      const initrd =
        message["initrd"] === undefined
          ? undefined
          : decodeBytes(message["initrd"]);
      const disk =
        message["disk"] === undefined ? undefined : decodeBytes(message["disk"]);
      const hostDiskBytes = decodeHostDiskBytes(message["hostDiskBytes"], disk);
      const commandLine = string(message["commandLine"], "commandLine");
      const maximumSteps = integer(
        message["maximumSteps"],
        "maximumSteps",
        1,
        MAX_SYSTEM_PROBE_STEPS,
      );
      validateSystemProbeInput(
        memoryMiB,
        kernel.byteLength,
        initrd?.byteLength ?? 0,
        disk?.byteLength ?? 0,
        commandLine,
        maximumSteps,
      );
      return {
        ...base,
        type,
        memoryMiB,
        kernel,
        commandLine,
        maximumSteps,
        ...(initrd === undefined ? {} : { initrd }),
        ...(disk === undefined ? {} : { disk }),
        ...(hostDiskBytes === undefined ? {} : { hostDiskBytes }),
      };
    }
    case "boot-system": {
      exactKeys(
        message,
        ["id", "version", "type", "memoryMiB", "kernel", "commandLine"],
        ["initrd", "disk", "hostDiskBytes", "console"],
      );
      const console = message["console"];
      if (console !== undefined && console !== "serial" && console !== "virtio") throw new VMError("PROTOCOL_ERROR", "invalid human console selection");
      const memoryMiB = integer(message["memoryMiB"], "memoryMiB", 16, 3072);
      const kernel = decodeBytes(message["kernel"]);
      const initrd =
        message["initrd"] === undefined
          ? undefined
          : decodeBytes(message["initrd"]);
      const disk =
        message["disk"] === undefined ? undefined : decodeBytes(message["disk"]);
      const hostDiskBytes = decodeHostDiskBytes(message["hostDiskBytes"], disk);
      const commandLine = string(message["commandLine"], "commandLine");
      validateSystemBootInput(
        memoryMiB,
        kernel.byteLength,
        initrd?.byteLength ?? 0,
        disk?.byteLength ?? 0,
        commandLine,
      );
      return {
        ...base,
        type,
        memoryMiB,
        kernel,
        commandLine,
        ...(console === undefined ? {} : { console }),
        ...(initrd === undefined ? {} : { initrd }),
        ...(disk === undefined ? {} : { disk }),
        ...(hostDiskBytes === undefined ? {} : { hostDiskBytes }),
      };
    }
    case "configure-system-aot":
      exactKeys(message, ["id", "version", "type", "configuration"]);
      return {
        ...base,
        type,
        configuration: decodePreparedSystemAot(message["configuration"]),
      };
    case "run-system-slice": {
      exactKeys(message, ["id", "version", "type", "maximumSteps"]);
      const maximumSteps = integer(
        message["maximumSteps"],
        "maximumSteps",
        1,
        MAX_SYSTEM_SLICE_STEPS,
      );
      return { ...base, type, maximumSteps };
    }
    case "quiesce-disk":
      exactKeys(message, ["id", "version", "type"]);
      return { ...base, type };
    case "start-system": {
      exactKeys(message, ["id", "version", "type", "sessionId", "port"]);
      const port = message["port"];
      if (!(port instanceof MessagePort)) {
        throw new VMError(
          "PROTOCOL_ERROR",
          "system execution port is invalid",
        );
      }
      return {
        ...base,
        type,
        sessionId: integer(message["sessionId"], "session id", 1),
        port,
      };
    }
    case "pause-system":
    case "resume-system":
    case "stop-system":
      exactKeys(message, ["id", "version", "type", "sessionId"]);
      return {
        ...base,
        type,
        sessionId: integer(message["sessionId"], "session id", 1),
      };
    case "configure-system-trace": {
      exactKeys(message, [
        "id",
        "version",
        "type",
        "capacity",
        "interpreterOnly",
        "interpretedSemantics",
        "interpretedRipRanges",
        "checkpointPolicy",
      ]);
      const interpreterOnly = boolean(
        message["interpreterOnly"],
        "interpreter-only trace mode",
      );
      const interpretedSemantics = decodeInterpretedSemantics(
        message["interpretedSemantics"],
      );
      const interpretedRipRanges = decodeInterpretedRipRanges(
        message["interpretedRipRanges"],
      );
      const checkpointPolicy = message["checkpointPolicy"];
      if (
        checkpointPolicy !== "faults-and-stderr" &&
        checkpointPolicy !== "faults-only"
      ) {
        throw new VMError(
          "PROTOCOL_ERROR",
          "system trace checkpoint policy is invalid",
        );
      }
      if (interpreterOnly && interpretedSemantics.length !== 0) {
        throw new VMError(
          "PROTOCOL_ERROR",
          "interpreter-only mode cannot also quarantine semantics",
        );
      }
      if (
        interpretedRipRanges.length !== 0 &&
        interpretedSemantics.length === 0
      ) {
        throw new VMError(
          "PROTOCOL_ERROR",
          "RIP quarantine ranges require at least one semantic",
        );
      }
      return {
        ...base,
        type,
        capacity: integer(
          message["capacity"],
          "system trace capacity",
          0,
          MAX_SYSTEM_TRACE_EVENTS,
        ),
        interpreterOnly,
        interpretedSemantics,
        interpretedRipRanges,
        checkpointPolicy,
      };
    }
    case "read-system-trace":
    case "read-system-aot-training":
      exactKeys(message, ["id", "version", "type"]);
      return { ...base, type };
    case "snapshot":
      return { ...base, type, ...decodeCaptureFields(message) };
    case "snapshot-app-data":
      exactKeys(message, ["id", "version", "type", "data"]);
      return { ...base, type, data: validateAppData(message["data"]) };
    case "restore":
      exactKeys(message, ["id", "version", "type", "snapshot"],["initialStart"]);
      return { ...base, type, snapshot: decodeSnapshotRef(message["snapshot"]),...(message["initialStart"]===undefined?{}:{initialStart:decodeShippedInstallIdentity(message["initialStart"])}) };
    case "agent-reconcile-workspace":
      exactKeys(message, ["id", "version", "type", "snapshot"]);
      return { ...base, type, snapshot: decodeSnapshotRef(message["snapshot"]) };
    case "wait-agent":
      exactKeys(message, [
        "id",
        "version",
        "type",
        "timeoutMilliseconds",
      ]);
      return {
        ...base,
        type,
        timeoutMilliseconds: integer(
          message["timeoutMilliseconds"],
          "agent wait timeout",
          1,
          MAX_AGENT_WAIT_MILLISECONDS,
        ),
      };
    case "agent-read-file":
    case "agent-list":
      exactKeys(message, ["id", "version", "type", "path"]);
      return {
        ...base,
        type,
        path: decodeAgentPath(message["path"]),
      };
    case "agent-workspace-manifest":
    case "agent-workspace-delta":
    case "agent-refresh-guest":
      exactKeys(message, ["id", "version", "type"]);
      return { ...base, type };
    case "agent-sync-workspace": case "agent-restore-workspace": {
      exactKeys(message, ["id", "version", "type", "workspaceBaseSha256"]);
      const workspaceBaseSha256 = string(message["workspaceBaseSha256"], "workspace base SHA-256");
      if (!/^[0-9a-f]{64}$/u.test(workspaceBaseSha256)) throw new VMError("PROTOCOL_ERROR", "workspace base SHA-256 is invalid");
      return { ...base, type, workspaceBaseSha256 };
    }
    case "agent-apply-workspace":
    case "agent-apply-workspace-delta": {
      exactKeys(message, ["id", "version", "type", "data"]);
      const data = decodeBytes(message["data"]);
      if (data.byteLength > MAX_AGENT_PAYLOAD_BYTES) {
        throw new VMError("PROTOCOL_ERROR", "workspace snapshot exceeds the agent payload limit");
      }
      return { ...base, type, data };
    }
    case "agent-write-file": {
      exactKeys(message, ["id", "version", "type", "path", "data"]);
      const data = decodeBytes(message["data"]);
      validateAgentBytes(data);
      return {
        ...base,
        type,
        path: decodeAgentPath(message["path"]),
        data,
      };
    }
    case "agent-remove":
      exactKeys(message, [
        "id",
        "version",
        "type",
        "path",
        "recursive",
      ]);
      return {
        ...base,
        type,
        path: decodeAgentPath(message["path"]),
        recursive: boolean(message["recursive"], "recursive"),
      };
    case "agent-spawn": {
      exactKeys(message, [
        "id",
        "version",
        "type",
        "command",
        "args",
        "cwd",
        "env",
        "port",
      ], ["terminal", "guestPaths"]);
      const port = message["port"];
      if (!(port instanceof MessagePort)) {
        throw new VMError("PROTOCOL_ERROR", "process port is invalid");
      }
      return {
        ...base,
        type,
        command: decodeAgentCommand(message["command"]),
        args: decodeStringArray(message["args"], "process arguments"),
        cwd: decodeAgentPath(message["cwd"]),
        env: decodeEnvironment(message["env"]),
        ...(message["guestPaths"] === undefined ? {} : { guestPaths: boolean(message["guestPaths"], "guest path semantics") }),
        ...(message["terminal"] === undefined ? {} : { terminal: decodeTerminalSize(message["terminal"]) }),
        port,
      };
    }
    case "agent-attach-process": {
      exactKeys(message, ["id", "version", "type", "agentRequestId", "port"]);
      const port = message["port"];
      if (!(port instanceof MessagePort)) {
        throw new VMError("PROTOCOL_ERROR", "process port is invalid");
      }
      return {
        ...base,
        type,
        agentRequestId: integer(message["agentRequestId"], "guest process request id", 1, 0xffff_ffff),
        port,
      };
    }
    case "agent-stdin": {
      exactKeys(message, ["id", "version", "type", "pid", "data"]);
      const data = decodeBytes(message["data"]);
      validateAgentBytes(data);
      return {
        ...base,
        type,
        pid: integer(message["pid"], "guest process id", 1, 0xffff_ffff),
        data,
      };
    }
    case "agent-close-stdin":
      exactKeys(message, ["id", "version", "type", "pid"]);
      return {
        ...base,
        type,
        pid: integer(message["pid"], "guest process id", 1, 0xffff_ffff),
      };
    case "agent-process-control": {
      exactKeys(message, ["id", "version", "type", "pid", "sessionId", "control"]);
      return { ...base, type, pid: integer(message["pid"], "process PID", 1, 0xffff_ffff), sessionId: integer(message["sessionId"], "process generation", 1, 0xffff_ffff), control: decodeProcessControl(message["control"]) };
    }
    case "agent-signal": {
      exactKeys(message, ["id", "version", "type", "pid", "signal"]);
      const signal = string(message["signal"], "guest process signal");
      if (
        signal !== "TERM" &&
        signal !== "KILL" &&
        signal !== "INT" &&
        signal !== "HUP"
      ) {
        throw new VMError(
          "PROTOCOL_ERROR",
          "guest process signal is invalid",
        );
      }
      return {
        ...base,
        type,
        pid: integer(message["pid"], "guest process id", 1, 0xffff_ffff),
        signal,
      };
    }
    case "dispose":
      exactKeys(message, ["id", "version", "type"]);
      return { ...base, type };
    default:
      throw new VMError(
        "PROTOCOL_ERROR",
        `unknown control operation ${type}`,
      );
  }
}

function decodeTerminalSize(value: unknown): { readonly columns: number; readonly rows: number } {
  const size = record(value, "terminal size");
  exactKeys(size, ["columns", "rows"]);
  return {
    columns: integer(size["columns"], "terminal columns", 1, 1_000),
    rows: integer(size["rows"], "terminal rows", 1, 1_000),
  };
}

function decodeVcpuCount(value: unknown): 1 | 2 | 3 | 4 {
  const count = integer(value, "vcpus", 1, 4);
  if (count === 1 || count === 2 || count === 3 || count === 4) return count;
  throw new VMError("PROTOCOL_ERROR", "vcpus must be from 1 to 4");
}

function decodeHostDiskBytes(
  value: unknown,
  inlineDisk: Uint8Array | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (inlineDisk !== undefined) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "inline and host-backed disks are mutually exclusive",
    );
  }
  const bytes = integer(value, "host disk bytes", 512);
  if (bytes % 512 !== 0) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "host disk bytes must be sector aligned",
    );
  }
  return bytes;
}

function validateMaximumSteps(maximumSteps: number, maximum: number): void {
  if (
    !Number.isInteger(maximumSteps) ||
    maximumSteps < 1 ||
    maximumSteps > maximum
  ) {
    throw new VMError(
      "INVALID_ARGUMENT",
      `maximumSteps must be an integer from 1 to ${maximum.toLocaleString("en-US")}`,
    );
  }
}
import { decodeProcessControl, type ProcessControl } from "./protocol/process-control.js";
