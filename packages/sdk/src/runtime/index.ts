import { createUserspaceRuntimeVM, decodeUserspaceProfileOptions } from "./userspace-vm.js";
import { createSystemRuntimeVM } from "./system-vm.js";
import { BrowserAssistance } from "./browser-assistance.js";
import { validateRuntimeVMOptions } from "./vm-options.js";
import { decodeJitInstallOption } from "./jit-install-option.js";
import { decodeJitTierOption } from "./jit-tier-option.js";
import { VMError } from "./errors.js";
import type { RuntimeVMOptions, RuntimeVM } from "./vm-types.js";
export type { NetworkState, RelayConnectionOptions, RelayFailureReason, VMNetwork } from "./network-types.js";
export { VMError } from "./errors.js";
export { acquireLocalDataLease } from "./local-data.js";
export { detectBrowserSupport, MINIMUM_BROWSERS } from "./browser-support.js";
export type { BrowserFeature, BrowserSupport, MinimumBrowser } from "./browser-support.js";
export { decodeSystemTraceSnapshot } from "./protocol.js";
export type { VMErrorCode } from "./errors.js";
export type {
  CoreCpuState,
  CoreException,
  CoreProbeExit,
  CoreProbeResult,
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
  RuntimeVMCapabilities,
  WorkspaceEntry,
  PreparedManagedImage,
  SnapshotRef,
} from "./protocol.js";
export type {
  ManagedImageArtifact,
  ManagedImageChunk,
  ManagedImageManifest,
} from "./managed-image.js";
export type { SystemExecution } from "./system-execution.js";
export type { Workspace } from "./workspace.js";
export type {
  WorkspaceFileEntry, WorkspaceFile, WorkspaceChange, WorkspaceWatch, WorkspaceReadOptions, WorkspaceWriteOptions, WorkspaceOperationOptions, WorkspaceWatchOptions,
} from "./workspace-files.js";
export { requestWorkspaceHandoff } from "./workspace-handoff.js";
export { describeSnapshotError } from "./snapshot-errors.js";
export { backupFileName } from "./backup-file-name.js";
export type { WorkspaceHandoffOptions, WorkspaceHandoffResult, WorkspaceMovedAway } from "./workspace-handoff.js";
export type {
  AutoSaveHint,
  AutoSavePolicy,
  BackupExportResult,
  BackupInspection,
  BackupOptions,
  BackupProgress,
  SnapshotCompatibility,
  ManagedBootReason,
  ManagedResume,
  ManagedStart,
  ResumedTerminal,
  ResumedWorkspaceState,
  SnapshotEvent,
  SnapshotInfo,
  SnapshotKind,
  SnapshotRestoreOptions,
  SnapshotRestoreResult,
  SnapshotResumability,
  ShippedSkipReason,
  SnapshotUsage,
  StartProgress,
  RuntimeVMAutoSave,
  RuntimeVMSnapshots,
} from "./snapshot-types.js";

export type { AssistanceOptions, BuildScriptApprovalRequest, DependencyInstallHandle, DependencyPreparationOptions, ProcessExecution, RuntimeMode, NetworkMode, UserspaceLimitsOptions, RuntimeVMOptions, SpawnSpec, ProcessHandle, PreviewHandle, PreviewIsolation, ListeningPort, ManagedImageInfo, ManagedImageBootOptions, SystemBootSpec, RuntimeVMDiagnostics, RuntimeVM } from "./vm-types.js";
export { validateRuntimeVMOptions } from "./vm-options.js";
export { isPreviewSessionOrigin } from "./preview-session.js";

export async function createRuntimeVM(options: RuntimeVMOptions): Promise<RuntimeVM> {
  const profileOptions = decodeUserspaceProfileOptions(options);
  const jitInstall = decodeJitInstallOption(options);
  const jitTier = decodeJitTierOption(options);
  const validated = validateRuntimeVMOptions(options);
  if (validated.mode === "userspace") {
    return createUserspaceRuntimeVM(validated, profileOptions, jitInstall, jitTier);
  }
  if (profileOptions !== undefined) {
    throw new VMError("INVALID_ARGUMENT", "Userspace profile options require Userspace mode");
  }
  if (jitTier !== undefined) throw new VMError("INVALID_ARGUMENT", "The JIT tier option requires Userspace mode");

  return createSystemRuntimeVM(validated, jitInstall, (control, options) => new BrowserAssistance(control, options));
}
