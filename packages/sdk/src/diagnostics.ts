/** Opt-in advanced runtime surface. It lists every name it exposes, so a new runtime export reaches this subpath only by an edit here. */
export {
  acquireLocalDataLease,
  backupFileName,
  createRuntimeVM,
  decodeSystemTraceSnapshot,
  describeSnapshotError,
  detectBrowserSupport,
  isPreviewSessionOrigin,
  MINIMUM_BROWSERS,
  requestWorkspaceHandoff,
  validateRuntimeVMOptions,
  VMError,
} from "./runtime/index.js";
export type {
  AssistanceOptions,
  AutoSaveHint,
  AutoSavePolicy,
  BackupExportResult,
  BackupInspection,
  BackupOptions,
  BackupProgress,
  BrowserFeature,
  BrowserSupport,
  BuildScriptApprovalRequest,
  CoreCpuState,
  CoreException,
  CoreProbeExit,
  CoreProbeResult,
  DependencyInstallHandle,
  DependencyPreparationOptions,
  ListeningPort,
  ManagedBootReason,
  ManagedImageArtifact,
  ManagedImageBootOptions,
  ManagedImageChunk,
  ManagedImageInfo,
  ManagedImageManifest,
  ManagedResume,
  ManagedStart,
  MinimumBrowser,
  NetworkMode,
  NetworkState,
  PreparedManagedImage,
  PreviewHandle,
  PreviewIsolation,
  ProcessExecution,
  ProcessHandle,
  RelayConnectionOptions,
  RelayFailureReason,
  ResumedTerminal,
  ResumedWorkspaceState,
  RuntimeMode,
  RuntimeVM,
  RuntimeVMAutoSave,
  RuntimeVMCapabilities,
  RuntimeVMDiagnostics,
  RuntimeVMOptions,
  RuntimeVMSnapshots,
  ShippedSkipReason,
  SnapshotCompatibility,
  SnapshotEvent,
  SnapshotInfo,
  SnapshotKind,
  SnapshotRef,
  SnapshotRestoreOptions,
  SnapshotRestoreResult,
  SnapshotResumability,
  SnapshotUsage,
  SpawnSpec,
  StartProgress,
  SystemBootSpec,
  SystemExecution,
  SystemExecutionEvent,
  SystemProbeResult,
  SystemRuntimeStats,
  SystemSliceResult,
  SystemTraceCpu,
  SystemTraceEvent,
  SystemTraceInstruction,
  SystemTraceProfile,
  SystemTraceRegisters,
  SystemTraceSnapshot,
  UserspaceLimitsOptions,
  VMErrorCode,
  VMNetwork,
  Workspace,
  WorkspaceChange,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceFileEntry,
  WorkspaceHandoffOptions,
  WorkspaceHandoffResult,
  WorkspaceMovedAway,
  WorkspaceOperationOptions,
  WorkspaceReadOptions,
  WorkspaceWatch,
  WorkspaceWatchOptions,
  WorkspaceWriteOptions,
} from "./runtime/index.js";

import type { VM } from "./contracts.js";
import type { RuntimeVMDiagnostics } from "./runtime/vm-types.js";
import { ownedRuntime } from "./vm-adapter.js";

/** Reads the diagnostics of a VM created by this SDK. */
export function getDiagnostics(vm: VM): RuntimeVMDiagnostics { return ownedRuntime(vm).diagnostics; }

/** Erases the runtime origin's OxideVM data: this page's, or the runtime frame's in frame mode. */
export { eraseLocalData } from "./local-data.js";
/** The one engine release this SDK pins: its ID is the SHA-256 of its exact release.json bytes. */
export { engineRelease, engineReleaseId } from "./engine.generated.js";
/** The relay protocol version this SDK speaks, generated from its byte-for-byte copy of the engine's relay specification. */
export { RELAY_VERSION } from "./runtime/workers/relay-generated.js";
/** Generated ISA identities used by instruction entropy records and engine compatibility checks. */
export { instructionIdentities } from "./runtime/isa-identities.generated.js";
export { configureJSProcessTrace, readJSProcessTrace, watchAccelerationNotices } from "./js-process-diagnostics.js";
export type { JSProcessTrace, JSProcessTraceEvent, JSProcessPlacementEvent, JSProcessLateFailureEvent, AccelerationRejectionReason, AccelerationEnvironmentRejection, AccelerationNotice } from "./js-process-diagnostics.js";
