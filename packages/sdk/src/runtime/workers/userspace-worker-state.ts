import type { JsProcessWorkers } from "./js-process/driver.js";
import type { ProcessAttachmentState } from "./userspace-worker-attachments.js";
import type { CoreRunExit } from "../core-abi.js";
import type { UserspaceRunResult } from "../userspace-abi.js";
import type { Core } from "./control/core.js";
import type { JitRuntime } from "./control/jit-runtime.js";
import type { UserspaceRootPersistence } from "./userspace-root-persistence.js";
import type { UserspaceWorkspacePersistence } from "./userspace-workspace-persistence.js";
import type { UserspaceHostService } from "./userspace-host-service.js";
import type { UserspaceCheckpoints } from "./userspace-checkpoint.js";
import { AttentionFairness } from "../host-attention.js";
import { emptyUserspaceSliceProfile, type UserspaceSliceProfile } from "../protocol/userspace-slices.js";

export interface RuntimeState {
  startup: "scaffold" | "ready";
  readonly instance: WebAssembly.Instance;
  readonly core: Core;
  readonly memory: WebAssembly.Memory;
  readonly jitRuntime: JitRuntime;
  readonly checkpoints: UserspaceCheckpoints;
  readonly rootTreeSha256: string | undefined;
  readonly workspaceBaseSha256: string | undefined;
  rootPersistence?: UserspaceRootPersistence;
  workspacePersistence?: UserspaceWorkspacePersistence;
  jsProcesses?: JsProcessWorkers;
  hostService?: UserspaceHostService;
  pendingResult: UserspaceRunResult | undefined;
  /** The output generation an interactive run slice last ended for (`userspace-run-slices.ts`). */
  outputYieldGeneration: bigint;
  workerRunTurns: number;
  workerYields: number;
  workerMessages: number;
  hostRequests: number;
  hostRequestBytes: bigint;
  pendingWorkPolls: number;
  hostRequestServicePolls: number;
  outputServicePolls: number;
  exitServicePolls: number;
  timerServicePolls: number;
  /** How run slices ended (`userspace-run-loop.ts`). */
  readonly slices: UserspaceSliceProfile;
  /** The guest's share between host-attention yields. */
  readonly fairness: AttentionFairness;
  lastException: Extract<CoreRunExit, { readonly kind: "exception" }>["exception"] | undefined;
}
/** The parts of a runtime its Wasm instantiation produces (`userspace-runtime.ts`). */
export type RuntimeBinding = Pick<RuntimeState, "instance" | "core" | "memory" | "jitRuntime" | "checkpoints">;

/** A freshly mounted runtime with zeroed worker counters. */
export function newRuntimeState(
  binding: RuntimeBinding,
  startup: RuntimeState["startup"],
  rootTreeSha256: string | undefined,
  workspaceBaseSha256: string | undefined,
): RuntimeState {
  return {
    ...binding, startup, rootTreeSha256, workspaceBaseSha256, pendingResult: undefined, outputYieldGeneration: -1n,
    workerRunTurns: 0, workerYields: 0, workerMessages: 0, hostRequests: 0, hostRequestBytes: 0n,
    pendingWorkPolls: 0, hostRequestServicePolls: 0, outputServicePolls: 0, exitServicePolls: 0, timerServicePolls: 0,
    slices: emptyUserspaceSliceProfile(), fairness: new AttentionFairness(), lastException: undefined,
  };
}

export interface ProcessState extends ProcessAttachmentState {
  runtime: RuntimeState;
  readonly port: MessagePort;
}
