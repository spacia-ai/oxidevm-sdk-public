import { decodeCommandInterceptors } from "../command-interceptors.js";
import { decodeUserspaceJitProfile, type UserspaceJitProfile } from "./protocol/userspace-jit-profile.js";
import { decodeMessagePort } from "./protocol/request-base.js";
import { decodeFileMount, decodeFileRequestBytes, decodeFileResponseBytes, decodeChangeCursor, type FileMount } from "./protocol/userspace-files.js";
import { exactKeys, integer, record, string } from "./decode.js";
import { decodeUserspaceJitTier, type UserspaceJitTier } from "./jit-tier-option.js";
import { VMError } from "./errors.js";
import { decodeAgentSpawnResult, decodeStringArray, type AgentSpawnResult } from "./protocol/agent.js";
import {
  PROTOCOL_VERSION,
  type ExecutionTiming,
  type ExecutionTimingMode,
} from "./protocol/common.js";
import { decodeBytes, decodeUndefined, finiteNonnegativeNumber, nonnegativeBigint } from "./protocol/decoders.js";
import type { Operation, OperationDecoders } from "./protocol.js";
import { decodeCoreException, type CoreException } from "./protocol/core.js";
import type { CoreRuntimeProfile } from "./protocol/system.js";
import { decodeCoreRuntimeProfile, coreTraceVersionForRecord } from "./protocol/system-trace-core-profile.js";
import { jitChainProfileReconciles } from "./protocol/system-trace-profile.js";
import { SYSTEM_TRACE_SCHEMA_VERSION } from "./protocol/system-trace-schema.js";
import {
  decodeBackgroundCompileProfile,
  decodeJitInstallMode,
  emptyBackgroundCompileProfile,
  type SystemBackgroundCompileProfile,
  type SystemJitInstallMode,
} from "./protocol/system-trace-background-compile.js";
import {
  decodeJitCodeProfile,
  emptyJitCodeProfile,
  type SystemJitCodeProfile,
} from "./protocol/system-trace-jit-code.js";
import {
  decodeJitHealthProfile,
  emptyJitHealthProfile,
  type SystemJitHealthProfile,
} from "./protocol/system-trace-jit-health.js";
import { decodeUserspaceSyscallTrace, type UserspaceSyscallTraceSnapshot } from "./userspace-abi.js";
import { decodeUserspaceSliceProfile, emptyUserspaceSliceProfile, type UserspaceSliceProfile } from "./protocol/userspace-slices.js";
import { decodeUserspaceListenerRead } from "./userspace-listeners.js";
import type { ListeningPortsRead } from "./listening-ports.js";
import { decodeLinuxSignal, decodeSignalScope, type LinuxSignal, type SignalScope } from "./process-signals.js";
import type { RuntimeVMOptions } from "./vm-types.js";
import { decodeAccelerationNotice, type AccelerationNotice } from "./js-process/late-failure.js";

const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;

export interface UserspaceTerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface UserspaceExecutionProfile {
  /** Live diagnostic reads include VM-scoped native maps. Archived exit profiles can omit them. */
  readonly jit?: UserspaceJitProfile;
  readonly pid: number;
  /** Effective Rust-owned maximum tier; null when an archived capture lacks the record. */
  readonly jitTier: UserspaceJitTier | null;
  readonly retiredInstructions: bigint;
  readonly jitInstructions: bigint;
  readonly interpretedInstructions: bigint;
  readonly jitTier1Retired: bigint;
  readonly jitTier2Retired: bigint;
  readonly jitTier1Ring0Retired: bigint;
  readonly jitTier1Ring3Retired: bigint;
  readonly jitTier2Ring0Retired: bigint;
  readonly jitTier2Ring3Retired: bigint;
  readonly guestKernelInstructions: bigint;
  readonly guestDeviceInstructions: bigint;
  readonly guestPageTableWalkInstructions: bigint;
  readonly guestSchedulerInstructions: bigint;
  readonly guestTcpStackInstructions: bigint;
  readonly unknownAttributionInstructions: bigint;
  readonly lastException: CoreException | null;
  readonly timing: ExecutionTiming;
  readonly jitBatches: number;
  readonly interpreterBatches: number;
  readonly compileModules: number;
  readonly recompiledModules: number;
  readonly moduleEvictions: number;
  readonly prepareCalls: number;
  readonly prepareSamples: number;
  readonly prepareMilliseconds: number;
  readonly jitChainAttempts: bigint;
  readonly jitChainHits: bigint;
  readonly jitChainMissingCoverage: bigint;
  readonly jitChainMissingCache: bigint;
  readonly jitChainMissingDispatchSlot: bigint;
  readonly jitChainMissingEntry: bigint;
  readonly jitChainInvalidCode: bigint;
  readonly jitChainContextFailures: bigint;
  readonly jitResidentTierLoopCalls: bigint;
  readonly jitHotBlockTransitions: bigint;
  readonly jitHotBoundaryStops: bigint;
  readonly jitPartialBudgetFallbacks: bigint;
  readonly jitTailChainTransitions: bigint;
  readonly jitTier2ExecutionEntries: bigint;
  readonly jitMemoryReads: bigint;
  readonly jitMemoryPreflightWrites: bigint;
  readonly jitMemoryStageWrites: bigint;
  readonly jitMemoryWrites: bigint;
  readonly jitMemoryDirectPreflightWrites: bigint;
  readonly jitReadCacheHits: bigint;
  readonly jitWriteCacheHits: bigint;
  readonly jitReadVictimHits: bigint;
  readonly jitWriteVictimHits: bigint;
  readonly jitResidentAdapterCompletions: bigint;
  readonly jitAdapterExitsReturned: bigint;
  readonly jitResidentTaskSwitches: bigint;
  readonly jitResidentZeroRetirementExhaustions: bigint;
  readonly jitResidentHostWaitExits: bigint;
  readonly jitDispatchRebindSameModuleCrossAddressSpace: bigint;
  readonly jitDispatchRebindDifferentModule: bigint;
  readonly jitDispatchRebindSameAddressSpace: bigint;
  readonly jitBindingInvalidationsUnregister: bigint;
  readonly jitBindingInvalidationsEviction: bigint;
  readonly jitBindingInvalidationsReplacement: bigint;
  readonly jitActiveBindings: bigint;
  readonly jitActiveArtifacts: bigint;
  readonly jitActiveAddressSpaces: bigint;
  readonly jitAliasBindings: bigint;
  readonly jitAliasReuses: bigint;
  readonly jitCacheBindingBytes: bigint;
  readonly jitCacheArtifactBytes: bigint;
  readonly jitCacheTotalBytes: bigint;
  readonly mappedBytes: bigint;
  readonly residentBytes: bigint;
  readonly materializedPages: bigint;
  readonly directReadPageFills: bigint;
  readonly directWritePageFills: bigint;
  /** Translation-journal events across live processes; recorded covers the rest plus pending. */
  readonly translationJournalRecorded: bigint;
  readonly translationJournalDrained: bigint;
  readonly translationJournalCoalesced: bigint;
  readonly translationJournalDropped: bigint;
  readonly translationJournalRangeOverflows: bigint;
  readonly translationJournalCodeWriteOverflows: bigint;
  /** Pages compiled code currently depends on. */
  readonly translationJournalTrackedPages: bigint;
  /** Guest clock: user retirement, deterministic kernel work, and idle catch-up. */
  readonly guestClockTicks: bigint;
  readonly guestClockRetiredTicks: bigint;
  readonly guestClockIdleTicks: bigint;
  readonly realtimeOffsetSteps: bigint;
  readonly guestClockKernelTicks: bigint;
  /** Zero identifies archived profiles from before kernel accounting. */
  readonly kernelAccountingModel: 0 | 1;
  readonly workerRunTurns: number;
  readonly workerYields: number;
  readonly workerMessages: number;
  readonly hostRequests: number;
  readonly hostRequestBytes: bigint;
  readonly pendingWorkPolls: number;
  readonly hostRequestServicePolls: number;
  readonly outputServicePolls: number;
  readonly exitServicePolls: number;
  readonly timerServicePolls: number;
  /** How run slices ended and the host work served inside them; empty in captures before protocol 166. */
  readonly slices: UserspaceSliceProfile;
  readonly coreProfile: CoreRuntimeProfile;
  /** Tier-1 modules compiled off the guest's thread; empty in captures before protocol 49. */
  readonly backgroundCompile: SystemBackgroundCompileProfile;
  /** Whether the runtime's JIT still compiles, and why not; active in captures before
   * protocol 57. */
  readonly jitHealth: SystemJitHealthProfile;
  /** Estimated executable memory of compiled translations and the code budget; empty in
   * captures before protocol 58. */
  readonly jitCode: SystemJitCodeProfile;
}

export interface UserspaceOperations {
  readonly "js-trace": Operation<{ readonly capacity?: number }, Uint8Array>;
  /** ADR 0026: a port that carries each late fast-path failure until the page closes it. */
  readonly "acceleration-notices": Operation<undefined, MessagePort>;
  readonly "spawn-js": Operation<FileMount & { readonly worker: string; readonly arguments: readonly string[]; readonly environment: readonly string[]; readonly cwd: string; readonly port: MessagePort; readonly terminal?: UserspaceTerminalSize }, NativeSpawnResult>;
  readonly files: Operation<{ readonly request: Uint8Array; readonly mount?: FileMount }, Uint8Array>;
  readonly "file-changes": Operation<{ readonly cursor: bigint }, Uint8Array>;
  readonly initialize: Operation<
    { readonly wasmUrl: string; readonly wasmModule?: WebAssembly.Module; readonly memoryMiB: number; readonly storagePort?: MessagePort; readonly networkPort?: MessagePort; readonly nativeExecutionPort?: MessagePort; readonly maxProcesses?: number; readonly syscallTraceCapacity?: number; readonly executionTiming?: ExecutionTimingMode; readonly jitInstall?: SystemJitInstallMode; readonly jitTier?: UserspaceJitTier } & Pick<Extract<RuntimeVMOptions, { mode: "userspace" }>, "initialUser" | "rootPersistence" | "interceptors">,
    undefined
  >;
  readonly spawn: Operation<
    {
      readonly elf: Uint8Array;
      readonly arguments: readonly string[];
      readonly environment: readonly string[];
      readonly cwd: string;
      readonly rootfs: Uint8Array;
      readonly port: MessagePort;
      readonly terminal?: UserspaceTerminalSize;
    },
    NativeSpawnResult
  >;
  readonly "spawn-managed": Operation<
    {
      readonly rootTreeSha256: string;
      readonly workspaceBaseSha256: string;
      readonly cpuProfile: "x86-64-v2" | "x86-64-v3";
      readonly executable: string;
      readonly arguments: readonly string[];
      readonly environment: readonly string[];
      readonly cwd: string;
      readonly rootfs: Uint8Array;
      readonly port: MessagePort;
      readonly terminal?: UserspaceTerminalSize;
    },
    NativeSpawnResult
  >;
  readonly "attach-process": Operation<{ readonly attachmentKey: number; readonly port: MessagePort }, NativeSpawnResult>;
  readonly stdin: Operation<{ readonly sessionId: number; readonly pid: number; readonly data: Uint8Array }, number>;
  readonly "close-stdin": Operation<{ readonly sessionId: number; readonly pid: number }, undefined>;
  readonly "resize-terminal": Operation<{ readonly sessionId: number; readonly pid: number; readonly terminal: UserspaceTerminalSize }, undefined>;
  readonly signal: Operation<
    { readonly sessionId: number; readonly pid: number; readonly signal: "TERM" | "KILL" | "INT" | "HUP" },
    undefined
  >;
  readonly "signal-named": Operation<{ readonly pid: number; readonly sessionId: number; readonly signal: LinuxSignal; readonly scope: SignalScope }, undefined>;
  readonly "terminal-resize": Operation<{ readonly pid: number; readonly sessionId: number; readonly terminal: UserspaceTerminalSize }, undefined>;
  readonly "terminal-interrupt": Operation<{ readonly pid: number; readonly sessionId: number }, undefined>;
  readonly "read-syscall-trace": Operation<{ readonly pid: number }, UserspaceSyscallTraceSnapshot>;
  readonly "read-execution-profile": Operation<{ readonly pid: number }, UserspaceExecutionProfile>;
  /** The runtime's listeners, or "unchanged" while the generation the caller knows stands. */
  readonly "listening-ports": Operation<{ readonly known: bigint | null }, ListeningPortsRead>;
  readonly "network-revoke": Operation<undefined, undefined>;
  readonly dispose: Operation<undefined, undefined>;
}

export const userspaceResponseDecoders: OperationDecoders<UserspaceOperations> = {
  "js-trace": decodeFileResponseBytes,
  "acceleration-notices": value => decodeMessagePort(value, "acceleration notice port"),
  "spawn-js": decodeNativeSpawnResult,
  files: decodeFileResponseBytes,
  "file-changes": decodeFileResponseBytes,
  initialize: decodeUndefined,
  spawn: decodeNativeSpawnResult,
  "spawn-managed": decodeNativeSpawnResult,
  "attach-process": decodeNativeSpawnResult,
  stdin: (value) => integer(value, "accepted Userspace stdin bytes", 0),
  "close-stdin": decodeUndefined,
  "resize-terminal": decodeUndefined,
  signal: decodeUndefined,
  "signal-named": decodeUndefined,
  "terminal-resize": decodeUndefined,
  "terminal-interrupt": decodeUndefined,
  "read-syscall-trace": decodeUserspaceSyscallTraceSnapshot,
  "read-execution-profile": decodeUserspaceExecutionProfile,
  "listening-ports": decodeUserspaceListenerRead,
  "network-revoke": decodeUndefined,
  dispose: decodeUndefined,
};

interface RequestBase {
  readonly id: number;
  readonly version: typeof PROTOCOL_VERSION;
}

export type UserspaceRequest =
  | (RequestBase & { readonly type: "js-trace"; readonly capacity?: number })
  | (RequestBase & { readonly type: "spawn-js" } & UserspaceOperations["spawn-js"]["request"])
  | (RequestBase & { readonly type: "signal-named"; readonly pid: number; readonly sessionId: number; readonly signal: LinuxSignal; readonly scope: SignalScope })
  | (RequestBase & { readonly type: "terminal-resize"; readonly pid: number; readonly sessionId: number; readonly terminal: UserspaceTerminalSize })
  | (RequestBase & { readonly type: "terminal-interrupt"; readonly pid: number; readonly sessionId: number })
  | (RequestBase & { readonly type: "files"; readonly request: Uint8Array; readonly mount?: FileMount })
  | (RequestBase & { readonly type: "file-changes"; readonly cursor: bigint })
  | (RequestBase & { readonly type: "initialize" } & UserspaceOperations["initialize"]["request"])
  | (RequestBase & {
      readonly type: "spawn";
      readonly elf: Uint8Array;
      readonly arguments: readonly string[];
      readonly environment: readonly string[];
      readonly cwd: string;
      readonly rootfs: Uint8Array;
      readonly port: MessagePort;
      readonly terminal?: UserspaceTerminalSize;
    })
  | (RequestBase & {
      readonly type: "spawn-managed";
      readonly rootTreeSha256: string;
      readonly workspaceBaseSha256: string;
      readonly cpuProfile: "x86-64-v2" | "x86-64-v3";
      readonly executable: string;
      readonly arguments: readonly string[];
      readonly environment: readonly string[];
      readonly cwd: string;
      readonly rootfs: Uint8Array;
      readonly port: MessagePort;
      readonly terminal?: UserspaceTerminalSize;
    })
  | (RequestBase & { readonly type: "attach-process"; readonly attachmentKey: number; readonly port: MessagePort })
  | (RequestBase & { readonly type: "stdin"; readonly sessionId: number; readonly pid: number; readonly data: Uint8Array })
  | (RequestBase & { readonly type: "close-stdin"; readonly sessionId: number; readonly pid: number })
  | (RequestBase & { readonly type: "resize-terminal"; readonly sessionId: number; readonly pid: number; readonly terminal: UserspaceTerminalSize })
  | (RequestBase & {
      readonly type: "signal";
      readonly sessionId: number;
      readonly pid: number;
      readonly signal: "TERM" | "KILL" | "INT" | "HUP";
    })
  | (RequestBase & { readonly type: "read-syscall-trace"; readonly pid: number })
  | (RequestBase & { readonly type: "read-execution-profile"; readonly pid: number })
  | (RequestBase & { readonly type: "listening-ports"; readonly known: bigint | null })
  | (RequestBase & { readonly type: "network-revoke" | "dispose" | "acceleration-notices" });

export type UserspaceCancelRequest = {
  readonly version: typeof PROTOCOL_VERSION;
  readonly type: "cancel";
  readonly requestId: number;
};

export function decodeUserspaceRequest(value: unknown): UserspaceRequest | UserspaceCancelRequest {
  const request = record(value, "Userspace worker request");
  const type = string(request["type"], "Userspace worker request type");
  if (type === "cancel") {
    exactKeys(request, ["version", "type", "requestId"]);
    return {
      version: decodeVersion(request["version"]),
      type,
      requestId: integer(request["requestId"], "Userspace cancellation id", 1),
    };
  }
  const base = {
    id: integer(request["id"], "Userspace request id", 1),
    version: decodeVersion(request["version"]),
  };
  switch (type) {
    case "js-trace":
      exactKeys(request, ["id", "version", "type"], ["capacity"]);
      return { ...base, type, ...(request["capacity"] === undefined ? {} : { capacity: integer(request["capacity"], "JS trace capacity", 0, 4096) }) };
    case "spawn-js": {
      exactKeys(request, ["id", "version", "type", "rootTreeSha256", "workspaceBaseSha256", "cpuProfile", "worker", "arguments", "environment", "cwd", "rootfs", "port"], ["terminal"]);
      const mount = decodeFileMount({ rootTreeSha256: request["rootTreeSha256"], workspaceBaseSha256: request["workspaceBaseSha256"], cpuProfile: request["cpuProfile"], rootfs: request["rootfs"] });
      const worker = string(request["worker"], "JS process worker");
      if (worker.length > 4096 || worker.includes("\0")) throw new VMError("PROTOCOL_ERROR", "JS worker URL is invalid");
      return { ...base, ...mount, type, worker, arguments: decodeStringArray(request["arguments"], "JS arguments"), environment: decodeStringArray(request["environment"], "JS environment"), cwd: decodeAbsolutePath(request["cwd"], "JS cwd"), port: decodeMessagePort(request["port"], "JS process port"), ...(request["terminal"] === undefined ? {} : { terminal: decodeTerminalSize(request["terminal"]) }) };
    }
    case "files":
      exactKeys(request, ["id", "version", "type", "request"], ["mount"]);
      return { ...base, type, request: decodeFileRequestBytes(request["request"]), ...(request["mount"] === undefined ? {} : { mount: decodeFileMount(request["mount"]) }) };
    case "file-changes":
      exactKeys(request, ["id", "version", "type", "cursor"]);
      return { ...base, type, cursor: decodeChangeCursor(request["cursor"]) };
    case "initialize": {
      exactKeys(request, ["id", "version", "type", "wasmUrl", "memoryMiB"], ["wasmModule", "storagePort", "networkPort", "nativeExecutionPort", "maxProcesses", "syscallTraceCapacity", "executionTiming", "jitInstall", "jitTier", "initialUser", "rootPersistence", "interceptors"]);
      const wasmModule = request["wasmModule"];
      if (wasmModule !== undefined && !(wasmModule instanceof WebAssembly.Module)) throw new VMError("PROTOCOL_ERROR", "Userspace engine module is invalid");
      const initialUser = request["initialUser"];
      const rootPersistence = request["rootPersistence"];
      if (initialUser !== undefined && initialUser !== "user" && initialUser !== "root") throw new VMError("PROTOCOL_ERROR", "Invalid initialUser");
      if (rootPersistence !== undefined && rootPersistence !== "ephemeral" && rootPersistence !== "persistent") throw new VMError("PROTOCOL_ERROR", "Invalid rootPersistence");
      if (request["storagePort"] !== undefined && !(request["storagePort"] instanceof MessagePort)) {
        throw new VMError("PROTOCOL_ERROR", "Userspace storage port is invalid");
      }
      if (request["networkPort"] !== undefined && !(request["networkPort"] instanceof MessagePort)) {
        throw new VMError("PROTOCOL_ERROR", "Userspace network port is invalid");
      }
      if (request["nativeExecutionPort"] !== undefined && !(request["nativeExecutionPort"] instanceof MessagePort)) throw new VMError("PROTOCOL_ERROR", "Invalid native execution port");
      return {
        ...base,
        type,
        wasmUrl: string(request["wasmUrl"], "Userspace Wasm URL"),
        ...(wasmModule === undefined ? {} : { wasmModule }),
        memoryMiB: integer(request["memoryMiB"], "Userspace memory", 64, 3072),
        ...(request["interceptors"] === undefined ? {} : { interceptors: decodeCommandInterceptors(request["interceptors"]) }),
        ...(initialUser === undefined ? {} : { initialUser }),
        ...(rootPersistence === undefined ? {} : { rootPersistence }),
        ...(request["storagePort"] === undefined ? {} : { storagePort: request["storagePort"] }),
        ...(request["networkPort"] === undefined ? {} : { networkPort: request["networkPort"] }),
        ...(request["nativeExecutionPort"] === undefined ? {} : { nativeExecutionPort: request["nativeExecutionPort"] }),
        ...(request["maxProcesses"] === undefined
          ? {}
          : { maxProcesses: integer(request["maxProcesses"], "Userspace max processes", 1, 64) }),
        ...(request["syscallTraceCapacity"] === undefined
          ? {}
          : { syscallTraceCapacity: integer(request["syscallTraceCapacity"], "Userspace syscall trace capacity", 1, 4096) }),
        ...(request["executionTiming"] === undefined
          ? {}
          : { executionTiming: decodeExecutionTimingMode(request["executionTiming"]) }),
        ...(request["jitInstall"] === undefined
          ? {}
          : { jitInstall: decodeJitInstallMode(request["jitInstall"]) }),
        ...(request["jitTier"] === undefined ? {} : { jitTier: decodeUserspaceJitTier(request["jitTier"]) }),
      };
    }
    case "spawn": {
      exactKeys(request, ["id", "version", "type", "elf", "arguments", "environment", "cwd", "rootfs", "port"], ["terminal"]);
      const elf = boundedBytes(request["elf"], "Userspace ELF");
      const rootfs = boundedBytes(request["rootfs"], "Userspace rootfs");
      if (!(request["port"] instanceof MessagePort)) {
        throw new VMError("PROTOCOL_ERROR", "Userspace process port is invalid");
      }
      return {
        ...base,
        type,
        elf,
        arguments: decodeStringArray(request["arguments"], "Userspace arguments"),
        environment: decodeStringArray(request["environment"], "Userspace environment"),
        cwd: decodeAbsolutePath(request["cwd"], "Userspace cwd"),
        rootfs,
        port: request["port"],
        ...(request["terminal"] === undefined ? {} : { terminal: decodeTerminalSize(request["terminal"]) }),
      };
    }
    case "spawn-managed": {
      exactKeys(request, ["id", "version", "type", "rootTreeSha256", "workspaceBaseSha256", "cpuProfile", "executable", "arguments", "environment", "cwd", "rootfs", "port"], ["terminal"]);
      const rootTreeSha256 = string(request["rootTreeSha256"], "Userspace root tree SHA-256");
      if (!/^[0-9a-f]{64}$/u.test(rootTreeSha256)) {
        throw new VMError("PROTOCOL_ERROR", "Userspace root tree SHA-256 is invalid");
      }
      const workspaceBaseSha256 = string(request["workspaceBaseSha256"], "Userspace workspace base SHA-256");
      if (!/^[0-9a-f]{64}$/u.test(workspaceBaseSha256)) {
        throw new VMError("PROTOCOL_ERROR", "Userspace workspace base SHA-256 is invalid");
      }
      const cpuProfile = string(request["cpuProfile"], "Userspace CPU profile");
      if (cpuProfile !== "x86-64-v2" && cpuProfile !== "x86-64-v3") {
        throw new VMError("PROTOCOL_ERROR", "Userspace CPU profile is invalid");
      }
      const executable = string(request["executable"], "Userspace executable");
      if (!executable.startsWith("/") || executable.length > 4096 || executable.includes("\0")) {
        throw new VMError("PROTOCOL_ERROR", "Userspace executable path is invalid");
      }
      if (!(request["port"] instanceof MessagePort)) {
        throw new VMError("PROTOCOL_ERROR", "Userspace process port is invalid");
      }
      return {
        ...base,
        type,
        rootTreeSha256,
        workspaceBaseSha256,
        cpuProfile,
        executable,
        arguments: decodeStringArray(request["arguments"], "Userspace arguments"),
        environment: decodeStringArray(request["environment"], "Userspace environment"),
        cwd: decodeAbsolutePath(request["cwd"], "Userspace cwd"),
        rootfs: boundedBytes(request["rootfs"], "Userspace rootfs metadata"),
        port: request["port"],
        ...(request["terminal"] === undefined ? {} : { terminal: decodeTerminalSize(request["terminal"]) }),
      };
    }
    case "attach-process":
      exactKeys(request, ["id", "version", "type", "attachmentKey", "port"]);
      return { ...base, type, attachmentKey: integer(request["attachmentKey"], "native attachment key", 1, 0xffff_ffff),
        port: decodeMessagePort(request["port"], "native process attachment port") };
    case "stdin":
      exactKeys(request, ["id", "version", "type", "pid", "sessionId", "data"]);
      return {
        ...base,
        type,
        sessionId: integer(request["sessionId"], "process session", 1),
        pid: integer(request["pid"], "Userspace pid", 1, 0xffff_ffff),
        data: boundedBytes(request["data"], "Userspace stdin"),
      };
    case "resize-terminal":
      exactKeys(request, ["id", "version", "type", "pid", "sessionId", "terminal"]);
      return { ...base, type, sessionId: integer(request["sessionId"], "process session", 1), pid: integer(request["pid"], "Userspace pid", 1, 0xffff_ffff), terminal: decodeTerminalSize(request["terminal"]) };
    case "close-stdin":
      exactKeys(request, ["id", "version", "type", "pid", "sessionId"]);
      return { ...base, type, sessionId: integer(request["sessionId"], "process session", 1), pid: integer(request["pid"], "Userspace pid", 1, 0xffff_ffff) };
    case "signal-named": {
      exactKeys(request, ["id", "version", "type", "pid", "sessionId", "signal", "scope"]);
      return { ...base, type, pid: integer(request["pid"], "Userspace pid", 1, 0xffff_ffff), sessionId: integer(request["sessionId"], "process session", 1), signal: decodeLinuxSignal(request["signal"]), scope: decodeSignalScope(request["scope"]) };
    }
    case "terminal-resize": {
      exactKeys(request, ["id", "version", "type", "pid", "sessionId", "terminal"]);
      return { ...base, type, pid: integer(request["pid"], "Userspace pid", 1, 0xffff_ffff), sessionId: integer(request["sessionId"], "process session", 1), terminal: decodeTerminalSize(request["terminal"]) };
    }
    case "terminal-interrupt": {
      exactKeys(request, ["id", "version", "type", "pid", "sessionId"]);
      return { ...base, type, pid: integer(request["pid"], "Userspace pid", 1, 0xffff_ffff), sessionId: integer(request["sessionId"], "process session", 1) };
    }
    case "signal": {
      exactKeys(request, ["id", "version", "type", "pid", "sessionId", "signal"]);
      const signal = string(request["signal"], "Userspace signal");
      if (signal !== "TERM" && signal !== "KILL" && signal !== "INT" && signal !== "HUP") {
        throw new VMError("PROTOCOL_ERROR", "Userspace signal is invalid");
      }
      return {
        ...base,
        type,
        sessionId: integer(request["sessionId"], "process session", 1),
        pid: integer(request["pid"], "Userspace pid", 1, 0xffff_ffff),
        signal,
      };
    }
    case "read-syscall-trace":
    case "read-execution-profile":
      exactKeys(request, ["id", "version", "type", "pid"]);
      return { ...base, type, pid: integer(request["pid"], "Userspace pid", 1, 0xffff_ffff) };
    case "listening-ports": {
      exactKeys(request, ["id", "version", "type", "known"]);
      const known = request["known"] === null ? null : nonnegativeBigint(request["known"], "Userspace known listener generation");
      if (known !== null && known > 0xffff_ffff_ffff_ffffn) throw new VMError("PROTOCOL_ERROR", "Userspace known listener generation exceeds 64 bits");
      return { ...base, type, known };
    }
    case "network-revoke":
    case "dispose":
    case "acceleration-notices":
      exactKeys(request, ["id", "version", "type"]);
      return { ...base, type };
    default:
      throw new VMError("PROTOCOL_ERROR", `unknown Userspace operation ${type}`);
  }
}

function decodeTerminalSize(value: unknown): UserspaceTerminalSize {
  const terminal = record(value, "Userspace terminal");
  exactKeys(terminal, ["columns", "rows"]);
  return {
    columns: integer(terminal["columns"], "Userspace terminal columns", 1, 1_000),
    rows: integer(terminal["rows"], "Userspace terminal rows", 1, 1_000),
  };
}

function decodeUserspaceSyscallTraceSnapshot(value: unknown): UserspaceSyscallTraceSnapshot {
  return decodeUserspaceSyscallTrace(boundedBytes(value, "Userspace syscall trace"));
}

export function decodeUserspaceExecutionProfile(value: unknown, format: "current" | "archive" = "current"): UserspaceExecutionProfile {
  const profile = record(value, "Userspace execution profile");
  const bigintFields = [
    "retiredInstructions", "jitInstructions", "interpretedInstructions",
    "jitTier1Retired", "jitTier2Retired", "jitTier1Ring0Retired", "jitTier1Ring3Retired",
    "jitTier2Ring0Retired", "jitTier2Ring3Retired", "guestKernelInstructions",
    "guestDeviceInstructions", "guestPageTableWalkInstructions", "guestSchedulerInstructions",
    "guestTcpStackInstructions", "unknownAttributionInstructions",
    "jitChainAttempts", "jitChainHits", "jitChainMissingCoverage", "jitChainMissingCache",
    "jitChainMissingDispatchSlot", "jitChainMissingEntry", "jitChainInvalidCode",
    "jitChainContextFailures", "jitResidentTierLoopCalls", "jitHotBlockTransitions",
    "jitHotBoundaryStops", "jitPartialBudgetFallbacks", "jitTailChainTransitions",
    "jitTier2ExecutionEntries",
    "jitMemoryReads", "jitMemoryPreflightWrites", "jitMemoryStageWrites", "jitMemoryWrites",
    "jitMemoryDirectPreflightWrites", "jitReadCacheHits", "jitWriteCacheHits",
    "jitReadVictimHits", "jitWriteVictimHits", "mappedBytes", "residentBytes",
    "jitResidentAdapterCompletions", "jitAdapterExitsReturned", "jitResidentTaskSwitches",
    "jitResidentZeroRetirementExhaustions", "jitResidentHostWaitExits",
    "jitDispatchRebindSameModuleCrossAddressSpace", "jitDispatchRebindDifferentModule",
    "jitDispatchRebindSameAddressSpace", "jitBindingInvalidationsUnregister",
    "jitBindingInvalidationsEviction", "jitBindingInvalidationsReplacement",
    "jitActiveBindings", "jitActiveArtifacts", "jitActiveAddressSpaces",
    "jitAliasBindings", "jitAliasReuses",
    "jitCacheBindingBytes", "jitCacheArtifactBytes", "jitCacheTotalBytes",
    "materializedPages", "directReadPageFills", "directWritePageFills", "hostRequestBytes",
    "translationJournalRecorded", "translationJournalDrained", "translationJournalCoalesced",
    "translationJournalDropped", "translationJournalRangeOverflows",
    "translationJournalCodeWriteOverflows", "translationJournalTrackedPages",
    "guestClockTicks", "guestClockRetiredTicks", "guestClockIdleTicks", "realtimeOffsetSteps",
  ] as const;
  const integerFields = [
    "jitBatches", "interpreterBatches", "compileModules", "recompiledModules",
    "moduleEvictions", "prepareCalls", "prepareSamples", "workerRunTurns", "workerYields",
    "workerMessages", "hostRequests", "pendingWorkPolls", "hostRequestServicePolls",
    "outputServicePolls", "exitServicePolls", "timerServicePolls",
  ] as const;
  exactKeys(
    profile,
    ["pid", ...bigintFields, "lastException", "timing", ...integerFields, "prepareMilliseconds", "coreProfile",
      ...(format === "current" ? ["guestClockKernelTicks", "kernelAccountingModel"] : [])],
    ["backgroundCompile", "jitHealth", "jitCode", "jitTier", "jit", "slices",
      ...(format === "archive" ? ["guestClockKernelTicks", "kernelAccountingModel"] : [])],
  );
  const legacy = format === "archive" && (
    profile["kernelAccountingModel"] === undefined && profile["guestClockKernelTicks"] === undefined
    || profile["kernelAccountingModel"] === 0 && profile["guestClockKernelTicks"] === 0n
  );
  if (!legacy && profile["kernelAccountingModel"] !== 1) {
    throw new VMError("PROTOCOL_ERROR", "Unsupported Userspace kernel accounting model");
  }
  const metric = (field: typeof bigintFields[number]) =>
    nonnegativeBigint(profile[field], `Userspace execution profile ${field}`);
  const result: UserspaceExecutionProfile = {
    ...(profile["jit"] === undefined ? {} : { jit: decodeUserspaceJitProfile(profile["jit"]) }),
    pid: integer(profile["pid"], "Userspace execution profile pid", 1, 0xffff_ffff),
    jitTier: profile["jitTier"] === undefined || profile["jitTier"] === null ? null : decodeUserspaceJitTier(profile["jitTier"]),
    retiredInstructions: metric("retiredInstructions"),
    jitInstructions: metric("jitInstructions"),
    interpretedInstructions: metric("interpretedInstructions"),
    jitTier1Retired: metric("jitTier1Retired"),
    jitTier2Retired: metric("jitTier2Retired"),
    jitTier1Ring0Retired: metric("jitTier1Ring0Retired"),
    jitTier1Ring3Retired: metric("jitTier1Ring3Retired"),
    jitTier2Ring0Retired: metric("jitTier2Ring0Retired"),
    jitTier2Ring3Retired: metric("jitTier2Ring3Retired"),
    guestKernelInstructions: metric("guestKernelInstructions"),
    guestDeviceInstructions: metric("guestDeviceInstructions"),
    guestPageTableWalkInstructions: metric("guestPageTableWalkInstructions"),
    guestSchedulerInstructions: metric("guestSchedulerInstructions"),
    guestTcpStackInstructions: metric("guestTcpStackInstructions"),
    unknownAttributionInstructions: metric("unknownAttributionInstructions"),
    lastException: profile["lastException"] === null
      ? null
      : decodeCoreException(profile["lastException"]),
    timing: decodeExecutionTiming(profile["timing"]),
    jitBatches: integer(profile["jitBatches"], "Userspace execution profile jitBatches", 0),
    interpreterBatches: integer(profile["interpreterBatches"], "Userspace execution profile interpreterBatches", 0),
    compileModules: integer(profile["compileModules"], "Userspace execution profile compileModules", 0),
    recompiledModules: integer(profile["recompiledModules"], "Userspace execution profile recompiledModules", 0),
    moduleEvictions: integer(profile["moduleEvictions"], "Userspace execution profile moduleEvictions", 0),
    prepareCalls: integer(profile["prepareCalls"], "Userspace execution profile prepareCalls", 0),
    prepareSamples: integer(profile["prepareSamples"], "Userspace execution profile prepareSamples", 0),
    prepareMilliseconds: finiteNonnegativeNumber(profile["prepareMilliseconds"], "Userspace execution profile prepareMilliseconds"),
    jitChainAttempts: metric("jitChainAttempts"),
    jitChainHits: metric("jitChainHits"),
    jitChainMissingCoverage: metric("jitChainMissingCoverage"),
    jitChainMissingCache: metric("jitChainMissingCache"),
    jitChainMissingDispatchSlot: metric("jitChainMissingDispatchSlot"),
    jitChainMissingEntry: metric("jitChainMissingEntry"),
    jitChainInvalidCode: metric("jitChainInvalidCode"),
    jitChainContextFailures: metric("jitChainContextFailures"),
    jitResidentTierLoopCalls: metric("jitResidentTierLoopCalls"),
    jitHotBlockTransitions: metric("jitHotBlockTransitions"),
    jitHotBoundaryStops: metric("jitHotBoundaryStops"),
    jitPartialBudgetFallbacks: metric("jitPartialBudgetFallbacks"),
    jitTailChainTransitions: metric("jitTailChainTransitions"),
    jitTier2ExecutionEntries: metric("jitTier2ExecutionEntries"),
    jitMemoryReads: metric("jitMemoryReads"),
    jitMemoryPreflightWrites: metric("jitMemoryPreflightWrites"),
    jitMemoryStageWrites: metric("jitMemoryStageWrites"),
    jitMemoryWrites: metric("jitMemoryWrites"),
    jitMemoryDirectPreflightWrites: metric("jitMemoryDirectPreflightWrites"),
    jitReadCacheHits: metric("jitReadCacheHits"),
    jitWriteCacheHits: metric("jitWriteCacheHits"),
    jitReadVictimHits: metric("jitReadVictimHits"),
    jitWriteVictimHits: metric("jitWriteVictimHits"),
    jitResidentAdapterCompletions: metric("jitResidentAdapterCompletions"),
    jitAdapterExitsReturned: metric("jitAdapterExitsReturned"),
    jitResidentTaskSwitches: metric("jitResidentTaskSwitches"),
    jitResidentZeroRetirementExhaustions: metric("jitResidentZeroRetirementExhaustions"),
    jitResidentHostWaitExits: metric("jitResidentHostWaitExits"),
    jitDispatchRebindSameModuleCrossAddressSpace: metric("jitDispatchRebindSameModuleCrossAddressSpace"),
    jitDispatchRebindDifferentModule: metric("jitDispatchRebindDifferentModule"),
    jitDispatchRebindSameAddressSpace: metric("jitDispatchRebindSameAddressSpace"),
    jitBindingInvalidationsUnregister: metric("jitBindingInvalidationsUnregister"),
    jitBindingInvalidationsEviction: metric("jitBindingInvalidationsEviction"),
    jitBindingInvalidationsReplacement: metric("jitBindingInvalidationsReplacement"),
    jitActiveBindings: metric("jitActiveBindings"),
    jitActiveArtifacts: metric("jitActiveArtifacts"),
    jitActiveAddressSpaces: metric("jitActiveAddressSpaces"),
    jitAliasBindings: metric("jitAliasBindings"),
    jitAliasReuses: metric("jitAliasReuses"),
    jitCacheBindingBytes: metric("jitCacheBindingBytes"),
    jitCacheArtifactBytes: metric("jitCacheArtifactBytes"),
    jitCacheTotalBytes: metric("jitCacheTotalBytes"),
    mappedBytes: metric("mappedBytes"),
    residentBytes: metric("residentBytes"),
    materializedPages: metric("materializedPages"),
    directReadPageFills: metric("directReadPageFills"),
    directWritePageFills: metric("directWritePageFills"),
    translationJournalRecorded: metric("translationJournalRecorded"),
    translationJournalDrained: metric("translationJournalDrained"),
    translationJournalCoalesced: metric("translationJournalCoalesced"),
    translationJournalDropped: metric("translationJournalDropped"),
    translationJournalRangeOverflows: metric("translationJournalRangeOverflows"),
    translationJournalCodeWriteOverflows: metric("translationJournalCodeWriteOverflows"),
    translationJournalTrackedPages: metric("translationJournalTrackedPages"),
    guestClockTicks: metric("guestClockTicks"),
    guestClockRetiredTicks: metric("guestClockRetiredTicks"),
    guestClockIdleTicks: metric("guestClockIdleTicks"),
    realtimeOffsetSteps: metric("realtimeOffsetSteps"),
    guestClockKernelTicks: legacy ? 0n : nonnegativeBigint(profile["guestClockKernelTicks"], "Userspace kernel ticks"),
    kernelAccountingModel: legacy ? 0 : 1,
    workerRunTurns: integer(profile["workerRunTurns"], "Userspace execution profile workerRunTurns", 0),
    workerYields: integer(profile["workerYields"], "Userspace execution profile workerYields", 0),
    workerMessages: integer(profile["workerMessages"], "Userspace execution profile workerMessages", 0),
    hostRequests: integer(profile["hostRequests"], "Userspace execution profile hostRequests", 0),
    pendingWorkPolls: integer(profile["pendingWorkPolls"], "Userspace execution profile pendingWorkPolls", 0),
    hostRequestServicePolls: integer(profile["hostRequestServicePolls"], "Userspace execution profile hostRequestServicePolls", 0),
    outputServicePolls: integer(profile["outputServicePolls"], "Userspace execution profile outputServicePolls", 0),
    exitServicePolls: integer(profile["exitServicePolls"], "Userspace execution profile exitServicePolls", 0),
    timerServicePolls: integer(profile["timerServicePolls"], "Userspace execution profile timerServicePolls", 0),
    hostRequestBytes: metric("hostRequestBytes"),
    slices: profile["slices"] === undefined
      ? emptyUserspaceSliceProfile()
      : decodeUserspaceSliceProfile(profile["slices"], {
        workerRunTurns: integer(profile["workerRunTurns"], "Userspace execution profile workerRunTurns", 0),
        pendingWorkPolls: integer(profile["pendingWorkPolls"], "Userspace execution profile pendingWorkPolls", 0),
      }),
    coreProfile: decodeCoreRuntimeProfile(
      profile["coreProfile"],
      coreTraceVersionForRecord(record(profile["coreProfile"], "Userspace core profile")["recordVersion"]),
    ),
    backgroundCompile: profile["backgroundCompile"] === undefined
      ? emptyBackgroundCompileProfile()
      : decodeBackgroundCompileProfile(profile["backgroundCompile"], SYSTEM_TRACE_SCHEMA_VERSION),
    jitHealth: profile["jitHealth"] === undefined
      ? emptyJitHealthProfile()
      : decodeJitHealthProfile(profile["jitHealth"]),
    jitCode: profile["jitCode"] === undefined
      ? emptyJitCodeProfile()
      : decodeJitCodeProfile(profile["jitCode"]),
  };
  if (
    result.retiredInstructions !== result.jitInstructions + result.interpretedInstructions ||
    (result.jitTier === "tier1" && result.jitTier2Retired !== 0n) ||
    result.jitInstructions !== result.jitTier1Retired + result.jitTier2Retired ||
    result.jitTier1Retired !== result.jitTier1Ring0Retired + result.jitTier1Ring3Retired ||
    result.jitTier2Retired !== result.jitTier2Ring0Retired + result.jitTier2Ring3Retired
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "Userspace execution profile retirement counters do not reconcile",
      {
        retiredInstructions: result.retiredInstructions.toString(),
        jitInstructions: result.jitInstructions.toString(),
        interpretedInstructions: result.interpretedInstructions.toString(),
        jitTier1Retired: result.jitTier1Retired.toString(),
        jitTier2Retired: result.jitTier2Retired.toString(),
        jitTier1Ring0Retired: result.jitTier1Ring0Retired.toString(),
        jitTier1Ring3Retired: result.jitTier1Ring3Retired.toString(),
        jitTier2Ring0Retired: result.jitTier2Ring0Retired.toString(),
        jitTier2Ring3Retired: result.jitTier2Ring3Retired.toString(),
      },
    );
  }
  if (result.prepareSamples > result.prepareCalls) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "Userspace execution profile preparation counters do not reconcile",
    );
  }
  if (
    result.coreProfile.jitDispatchSlotRebindings !==
      result.jitDispatchRebindSameModuleCrossAddressSpace +
        result.jitDispatchRebindDifferentModule +
        result.jitDispatchRebindSameAddressSpace ||
    result.jitAliasBindings > result.jitActiveBindings ||
    result.jitActiveArtifacts > result.jitActiveBindings ||
    result.jitActiveAddressSpaces > result.jitActiveBindings ||
    result.jitResidentHostWaitExits > result.jitResidentAdapterCompletions
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "Userspace execution profile resident/JIT binding counters do not reconcile",
    );
  }
  if (
    result.jitCacheBindingBytes + result.jitCacheArtifactBytes !==
      result.jitCacheTotalBytes ||
    result.jitCacheBindingBytes !== result.coreProfile.jitCacheBindingBytes ||
    result.jitCacheArtifactBytes !== result.coreProfile.jitCacheArtifactBytes ||
    result.jitCacheTotalBytes !== result.coreProfile.jitCacheTotalBytes
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "Userspace execution profile JIT cache byte counters do not reconcile",
    );
  }
  if (
    result.hostRequestServicePolls > result.pendingWorkPolls
    || result.outputServicePolls > result.pendingWorkPolls
    || result.exitServicePolls > result.pendingWorkPolls
    || result.timerServicePolls > result.pendingWorkPolls
  ) {
    throw new VMError(
      "PROTOCOL_ERROR",
      "Userspace execution profile pending-work counters do not reconcile",
    );
  }
  // The core profile counts the chain misses on translations still compiling.
  if (!jitChainProfileReconciles({
    ...result,
    jitChainMissingCompilePending: result.coreProfile.jitChainMissingCompilePending,
  })) {
    throw new VMError("PROTOCOL_ERROR", "Userspace execution profile chain counters do not reconcile");
  }
  if (
    result.jitTier1Ring0Retired !== 0n || result.jitTier2Ring0Retired !== 0n ||
    result.guestKernelInstructions !== 0n || result.guestDeviceInstructions !== 0n ||
    result.guestPageTableWalkInstructions !== 0n || result.guestSchedulerInstructions !== 0n ||
    result.guestTcpStackInstructions !== 0n || result.unknownAttributionInstructions !== 0n
  ) {
    throw new VMError("PROTOCOL_ERROR", "Userspace execution profile violates the userspace invariant");
  }
  if (result.residentBytes < result.materializedPages * 4096n) {
    throw new VMError("PROTOCOL_ERROR", "Userspace execution profile memory counters do not reconcile");
  }
  // Events still held for the next drain account for any excess of recorded events.
  if (
    result.translationJournalRecorded
      < result.translationJournalDrained + result.translationJournalCoalesced + result.translationJournalDropped
  ) {
    throw new VMError("PROTOCOL_ERROR", "Userspace execution profile journal counters do not reconcile");
  }
  if (result.guestClockTicks !== result.guestClockRetiredTicks + result.guestClockIdleTicks + result.guestClockKernelTicks) {
    throw new VMError("PROTOCOL_ERROR", "Userspace execution profile guest clock does not reconcile");
  }
  return result;
}

function decodeExecutionTimingMode(value: unknown): ExecutionTimingMode {
  const timing = record(value, "Userspace execution timing mode");
  exactKeys(timing, ["kind"]);
  const kind = string(timing["kind"], "Userspace execution timing mode kind");
  if (kind !== "disabled" && kind !== "sampled" && kind !== "exact") {
    throw new VMError("PROTOCOL_ERROR", "Userspace execution timing mode is invalid");
  }
  return { kind };
}

function decodeExecutionTiming(value: unknown): ExecutionTiming {
  const timing = record(value, "Userspace execution timing");
  const kind = string(timing["kind"], "Userspace execution timing kind");
  if (kind === "disabled") {
    exactKeys(timing, ["kind"]);
    return { kind };
  }
  if (kind !== "sampled" && kind !== "exact") {
    throw new VMError("PROTOCOL_ERROR", "Userspace execution timing kind is invalid");
  }
  exactKeys(timing, ["kind", "jitMilliseconds", "interpreterMilliseconds", "compileMilliseconds"], kind === "sampled" ? ["samples"] : []);
  const timings = {
    jitMilliseconds: finiteNonnegativeNumber(timing["jitMilliseconds"], "Userspace execution timing jitMilliseconds"),
    interpreterMilliseconds: finiteNonnegativeNumber(timing["interpreterMilliseconds"], "Userspace execution timing interpreterMilliseconds"),
    compileMilliseconds: finiteNonnegativeNumber(timing["compileMilliseconds"], "Userspace execution timing compileMilliseconds"),
  };
  return kind === "sampled"
    ? { kind: "sampled", samples: integer(timing["samples"], "Userspace execution timing samples", 0), ...timings }
    : { kind: "exact", ...timings };
}

function boundedBytes(value: unknown, label: string): Uint8Array {
  const bytes = decodeBytes(value);
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new VMError("PROTOCOL_ERROR", `${label} is too large`);
  }
  return bytes;
}

function decodeVersion(value: unknown): typeof PROTOCOL_VERSION {
  if (integer(value, "protocol version") !== PROTOCOL_VERSION) {
    throw new VMError("PROTOCOL_ERROR", "protocol version mismatch");
  }
  return PROTOCOL_VERSION;
}

function decodeAbsolutePath(value: unknown, label: string): string {
  const path = string(value, label);
  if (!path.startsWith("/") || path.length > 4096 || path.includes("\0")) {
    throw new VMError("PROTOCOL_ERROR", `${label} is invalid`);
  }
  return path;
}

export type NativeSpawnResult=AgentSpawnResult&{readonly identityKey:number};
function decodeNativeSpawnResult(value:unknown):NativeSpawnResult {
 const result=decodeAgentSpawnResult(value);if(result.identityKey===undefined)throw new VMError("PROTOCOL_ERROR","Native process has no stable snapshot identity");
 return {...result,identityKey:result.identityKey};
}

/** One message on an acceleration-notices port. */
export function decodeAccelerationNoticeMessage(value: unknown): AccelerationNotice {
  const message = record(value, "acceleration notice message");
  exactKeys(message, ["version", "notice"]);
  decodeVersion(message["version"]);
  return decodeAccelerationNotice(message["notice"]);
}
