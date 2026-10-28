import { coreFailureError } from "../core-failure.js";
import {
  type CoreJitAction,
  type CoreRunExit,
  decodeJitAction,
  decodeRunResult,
  isJitGuardExit,
  JIT_EXIT_PERFORMANCE_BOUNDARY,
} from "../../core-abi.js";
import { VMError } from "../../errors.js";
import {
  readSystemJitContextDiagnostics,
  readSystemJitExecutionDiagnostics,
} from "../../protocol/system-trace-jit.js";
import {
  type CoreProbeExit,
  type SystemInterpreterReason,
  type SystemTraceCpu,
  type SystemTraceJitContext,
} from "../../protocol.js";
import type { ExecutionTiming, ExecutionTimingMode } from "../../protocol/common.js";
import {
  type Core,
  type JitBlock,
  assertStatus,
  callNumber,
  memorySlice,
  readExportedView,
  readRecord,
} from "./core.js";
import { recordCompileLatency } from "./telemetry.js";
import { reactivateDormantJitBlock } from "./jit-dormant.js";
import {
  admitJitCode,
  type CompiledJitAction,
  evictJitBlock,
  installJitBlock,
  jitDispatchers,
  rollbackStagedJitBlock,
  selectJitBlockBinding,
  touchJitBlock,
  touchLastDispatchedJitBlock,
} from "./jit-blocks.js";
import {
  jitCompletionFailures,
  jitTraceExit,
  localJitBytes,
  synchronizeJitDispatchGeneration,
  TraceRecordingCadence,
  validatePreparedJitModuleLength,
  validateResidentGuardExecution,
  jitRetiredInstructions,
} from "./jit-runtime-helpers.js";
import { drainJitProfileSamples } from "./jit-profile-samples.js";
import { drainJitAliasBindings } from "./jit-aliases.js";
import { JitDeferredInstall } from "./jit-deferred-install.js";
import {
  type JitDegradation,
  JitModuleFailure,
  jitFailureError,
  recordInterpretedCompile,
  recordParkedCompile,
  recordJitFailure,
  recordPromotionFailure,
} from "./jit-health.js";
import {
  compileJitModule,
  installCompiledJitModule,
  jitImports,
  nextCompileGeneration,
  type PreparedJitModule,
  prepareJitModule,
} from "./jit-module-install.js";
import type { SystemJitInstallMode } from "../../protocol/system-trace-background-compile.js";
import type { SystemAotRuntime } from "./aot-runtime.js";
import { aotInstallEntry, attemptAotInstall, clearJitBindings } from "./jit-aot.js";
import { recordSystemTrace, systemTraceBase, systemTraceCpu, systemTraceEnabled } from "./trace.js";

const JIT_EXIT_CONTINUE = 0;
const JIT_EXIT_GUARD = 1;
const JIT_EXIT_HALTED = 3;

export { drainJitProfileSamples, validatePreparedJitModuleLength };
const JIT_EXIT_FAULT = 4;
const DEGRADED_INTERPRETER_STEPS = 64;
const PREPARE_SAMPLE_INTERVAL = 256;
const EXECUTION_TIMING_SAMPLE_INTERVAL = 256;
const MAX_INSTALL_ONLY_ACTIONS = 256;


function systemExit(exit: CoreRunExit): CoreProbeExit;
function systemExit(exit: CoreRunExit | undefined): CoreProbeExit | undefined;
function systemExit(exit: CoreRunExit | undefined): CoreProbeExit | undefined {
  if (exit?.kind === "adapter-exit") {
    throw new VMError(
      "UNSUPPORTED_SYSCALL",
      "system execution requested an adapter exit",
    );
  }
  if (exit?.kind === "internal-failure") {
    throw coreFailureError(exit);
  }
  return exit;
}

export class JitRuntime {
  private readonly recordingCadence = new TraceRecordingCadence();
  private timingCalls = 0;
  private timingSamples = 0;

  readonly #install: JitDeferredInstall;
  readonly #onDegraded: ((degradation: JitDegradation) => void) | undefined;

  /** `onDegraded` hears the JIT leave `active` after a compile or instantiation failure, once
   * per runtime generation. */
  constructor(
    private readonly timingMode: ExecutionTimingMode = { kind: "disabled" },
    private readonly aotRuntime?: SystemAotRuntime,
    install: JitDeferredInstall = new JitDeferredInstall(),
    onDegraded?: (degradation: JitDegradation) => void,
  ) {
    this.#install = install;
    this.#onDegraded = onDegraded;
  }

  initialize(): void {
    this.recordingCadence.reset();
    this.timingCalls = 0;
    this.timingSamples = 0;
    this.invalidate();
  }

  dispose(): Promise<void> {
    this.recordingCadence.reset();
    this.invalidate();
    this.#install.dispose();
    return Promise.resolve();
  }

  /** The machine or its JIT state is being replaced: compiles in flight are abandoned. */
  invalidate(): void {
    this.#install.invalidate();
  }

  /** Selects how Tier-1 modules are installed (diagnostic A/B switch). */
  configureInstall(mode: SystemJitInstallMode): void {
    this.#install.configure(mode);
  }

  /** Whether the guest's slice should end so a compiled module can be installed: one is ready
   * or, without a shared ready counter, modules are compiling and the slice has run a while.
   * Counts each such early end. */
  yieldForCompiledModule(loaded: Core, sliceMilliseconds: number): boolean {
    if (!this.#install.shouldYield(sliceMilliseconds)) return false;
    loaded.traceProfile.worker.backgroundCompile.earlyYields += 1;
    return true;
  }

  clearCatalogBindings(loaded: Core): void {
    clearJitBindings(loaded);
  }

  executionTiming(loaded: Core): ExecutionTiming {
    if (this.timingMode.kind === "disabled") return { kind: "disabled" };
    const worker = loaded.traceProfile.worker;
    const timings = {
      jitMilliseconds: worker.jitMilliseconds,
      interpreterMilliseconds: worker.interpreterMilliseconds,
      compileMilliseconds: worker.compileMilliseconds,
    };
    return this.timingMode.kind === "sampled"
      ? { kind: "sampled", samples: this.timingSamples, ...timings }
      : { kind: "exact", ...timings };
  }

  runBlock(
    loaded: Core,
    requestId: number,
    remaining: number,
    systemBooted: boolean,
    abortIfCanceled: (requestId: number) => void,
  ): CoreProbeExit | undefined {
    return systemExit(
      this.runBlockExit(loaded, requestId, remaining, systemBooted, abortIfCanceled, 0),
    );
  }

  runLinuxBlock(
    loaded: Core,
    requestId: number,
    remaining: number,
    abortIfCanceled: (requestId: number) => void,
  ): CoreRunExit | undefined {
    return this.runBlockExit(loaded, requestId, remaining, false, abortIfCanceled, 0);
  }

  private runBlockExit(
    loaded: Core,
    requestId: number,
    remaining: number,
    systemBooted: boolean,
    abortIfCanceled: (requestId: number) => void,
    installOnlyActions: number,
  ): CoreRunExit | undefined {
    if (installOnlyActions > MAX_INSTALL_ONLY_ACTIONS) {
      throw new VMError(
        "VM_FAULT",
        "JIT emitted consecutive install-only actions without guest progress",
      );
    }
    this.#install.record(loaded);
    if (this.#install.hasWork()) this.#reportDegradation(this.#install.settle(loaded));
    const before =
      systemTraceEnabled(loaded) ? systemTraceCpu(loaded) : undefined;
    const prepareStartedAt = this.startTiming(loaded);
    if (systemBooted && loaded.traceInterpreterOnly) {
      return this.runInterpreterExit(loaded, Math.min(remaining, DEGRADED_INTERPRETER_STEPS), "degraded");
    }
    if (systemBooted && loaded.jitHealth.state === "disabled") {
      const action = prepareJitAction(loaded, remaining, this.timingMode.kind);
      if (action.kind === "interpreted-result") {
        return this.readInterpretedResult(
          loaded,
          action,
          "degraded",
          before,
          this.elapsed(prepareStartedAt),
        );
      }
      discardPreparedJit(loaded, "degraded fallback");
      return this.runInterpreterExit(
        loaded,
        Math.min(
          remaining,
          action.maximumInstructions,
          DEGRADED_INTERPRETER_STEPS,
        ),
        "degraded",
      );
    }
    const action = prepareJitAction(loaded, remaining, this.timingMode.kind);
    if (action.kind === "interpreted-result") {
      return this.readInterpretedResult(
        loaded,
        action,
        "admission",
        before,
        this.elapsed(prepareStartedAt),
      );
    }
    const executionBudget = Math.min(remaining, action.maximumInstructions);
    let block: JitBlock;
    let cacheHit: boolean;
    let contextLength: number;
    try {
      const moduleLength = callNumber(loaded, "oxidevm_jit_module_len");
      contextLength = callNumber(loaded, "oxidevm_jit_context_len");
      validatePreparedJitModuleLength(moduleLength, action.moduleLength);
      if (contextLength !== action.contextLength) {
        throw new VMError(
          "VM_FAULT",
          "JIT action lengths changed before execution",
        );
      }
      const bindingKey = `${action.cacheKey.toString(16)}:${action.moduleLength}`;
      const artifactKey = `${action.artifactCacheKey.toString(16)}:${action.artifactModuleLength}`;
      const candidate = loaded.jitBlocks.get(artifactKey);
      cacheHit = candidate !== undefined;
      if (candidate === undefined ||
        !selectJitBlockBinding(loaded, candidate, action, bindingKey, moduleLength)) {
        return this.compilePreparedJitBlock(
          loaded,
          requestId,
          action,
          artifactKey,
          bindingKey,
          moduleLength,
          contextLength,
          executionBudget,
          systemBooted,
          abortIfCanceled,
          remaining,
          installOnlyActions,
        );
      }
      block = candidate;
    } catch (error) {
      discardPreparedJit(loaded, "action resolution", error);
      throw error;
    }
    return this.executePreparedJitBlock(
      loaded,
      action,
      block,
      contextLength,
      executionBudget,
      cacheHit,
      systemBooted,
      requestId,
      remaining,
      abortIfCanceled,
      installOnlyActions,
    );
  }

  runInterpreter(
    loaded: Core,
    maximumSteps: number,
    reason: SystemInterpreterReason,
  ): CoreProbeExit {
    return systemExit(this.runInterpreterExit(loaded, maximumSteps, reason));
  }

  private runInterpreterExit(
    loaded: Core,
    maximumSteps: number,
    reason: SystemInterpreterReason,
  ): CoreRunExit {
    const before =
      systemTraceEnabled(loaded) ? systemTraceCpu(loaded) : undefined;
    const startedAt = this.startTiming(loaded);
    assertStatus(callNumber(loaded, "oxidevm_run", [maximumSteps]));
    const exit = decodeRunResult(readRecord(loaded, "result"));
    return this.recordInterpreterResult(
      loaded,
      exit,
      maximumSteps,
      reason,
      before,
      this.elapsed(startedAt),
    );
  }

  private readInterpretedResult(
    loaded: Core,
    action: Extract<CoreJitAction, { readonly kind: "interpreted-result" }>,
    reason: SystemInterpreterReason,
    before: SystemTraceCpu | undefined,
    durationMilliseconds: number,
  ): CoreRunExit {
    const exit = decodeRunResult(readRecord(loaded, "result"));
    if (exit.steps !== BigInt(action.instructionCount)) {
      throw new VMError(
        "VM_FAULT",
        "resident interpreter result does not match its JIT action",
      );
    }
    const actionProfile = loaded.traceProfile.worker.interpretedActionReasons[action.reason];
    actionProfile.batches += 1;
    actionProfile.instructions += exit.steps;
    return this.recordInterpreterResult(
      loaded,
      exit,
      action.maximumInstructions,
      reason,
      before,
      durationMilliseconds,
    );
  }

  private recordInterpreterResult(
    loaded: Core,
    exit: CoreRunExit,
    maximumSteps: number,
    reason: SystemInterpreterReason,
    before: SystemTraceCpu | undefined,
    durationMilliseconds: number,
  ): CoreRunExit {
    loaded.runtimeStats.interpretedInstructions += exit.steps;
    loaded.traceProfile.worker.interpreterBatches += 1;
    loaded.traceProfile.worker.interpreterMilliseconds +=
      durationMilliseconds;
    const reasonProfile =
      loaded.traceProfile.worker.interpreterReasons[reason];
    reasonProfile.batches += 1;
    reasonProfile.instructions += exit.steps;
    reasonProfile.milliseconds += durationMilliseconds;
    if (before !== undefined) {
      const traceExit = systemExit(exit);
      recordSystemTrace(loaded, {
        kind: "interpreter",
        ...systemTraceBase(loaded),
        before,
        after: systemTraceCpu(loaded),
        budget: maximumSteps,
        steps: exit.steps,
        durationMilliseconds,
        reason,
        exit: traceExit.kind,
      });
    }
    return exit;
  }

  runGuardFallback(loaded: Core, maximumSteps: number): CoreProbeExit {
    return this.runInterpreter(
      loaded,
      Math.min(maximumSteps, DEGRADED_INTERPRETER_STEPS),
      "guard",
    );
  }

  runLinuxGuardFallback(loaded: Core, maximumSteps: number): CoreRunExit {
    return this.runInterpreterExit(
      loaded,
      Math.min(maximumSteps, DEGRADED_INTERPRETER_STEPS),
      "guard",
    );
  }

  private compilePreparedJitBlock(
    loaded: Core,
    requestId: number,
    action: CompiledJitAction,
    artifactKey: string,
    bindingKey: string,
    moduleLength: number,
    contextLength: number,
    executionBudget: number,
    systemBooted: boolean,
    abortIfCanceled: (requestId: number) => void,
    remaining: number,
    installOnlyActions: number,
  ): CoreRunExit | undefined {
    const dormant = loaded.dormantJitBlocks.get(artifactKey);
    if (dormant !== undefined &&
      selectJitBlockBinding(loaded, dormant, action, bindingKey, moduleLength)) {
      reactivateDormantJitBlock(loaded, artifactKey);
      abortIfCanceled(requestId);
      const installStarted = this.startArtifactTiming();
      const block = installJitBlock(
        loaded,
        dormant.byteLength,
        dormant.instance,
        dormant,
        dormant.trace,
        dormant.recordTrace,
      );
      loaded.traceProfile.worker.installMilliseconds += this.elapsed(installStarted);
      return this.executePreparedJitBlock(
        loaded,
        action,
        block,
        contextLength,
        executionBudget,
        true,
        systemBooted,
        requestId,
        remaining,
        abortIfCanceled,
        installOnlyActions,
      );
    }
    if (moduleLength === 0) {
      if (action.kind === "install" && this.aotRuntime !== undefined && attemptAotInstall({
        loaded,
        runtime: this.aotRuntime,
        action,
        imports: jitImports(loaded),
        install: (prepared, pending) => installJitBlock(
          loaded,
          0,
          prepared.instance,
          aotInstallEntry(
            action,
            bindingKey,
            artifactKey,
            prepared,
            pending,
            nextCompileGeneration(loaded),
          ),
          prepared.trace,
          prepared.recordTrace,
        ),
        rollback: (block) => rollbackStagedJitBlock(loaded, block),
      })) {
        return this.runBlockExit(
          loaded,
          requestId,
          remaining,
          systemBooted,
          abortIfCanceled,
          installOnlyActions + 1,
        );
      }
      assertStatus(callNumber(loaded, "oxidevm_jit_forget_pending"));
      discardPreparedJit(loaded, "released module recovery");
      if (action.kind === "install") {
        return this.runBlockExit(
          loaded,
          requestId,
          remaining,
          systemBooted,
          abortIfCanceled,
          installOnlyActions + 1,
        );
      }
      return this.runInterpreterExit(
        loaded,
        Math.min(executionBudget, action.instructionCount),
        "guard",
      );
    }
    // A degraded JIT compiles nothing new; the site runs on the interpreter. Only misses reach
    // this branch, so translated execution gains no work.
    if (loaded.jitHealth.state !== "active") {
      return this.degradedCompile(
        loaded, action, artifactKey, requestId, remaining, systemBooted, abortIfCanceled,
        installOnlyActions,
      );
    }
    let prepared: PreparedJitModule;
    let moduleBytes: Uint8Array<ArrayBuffer>;
    try {
      moduleBytes = localJitBytes(readExportedView(loaded, "oxidevm_jit_module"));
      if (moduleBytes.byteLength !== moduleLength) {
        throw new VMError(
          "VM_FAULT",
          "JIT module length changed before compilation",
        );
      }
      prepared = prepareJitModule(loaded, action, artifactKey, bindingKey, moduleBytes);
    } catch (error) {
      throw failSynchronousCompile(loaded, action, bindingKey, artifactKey, error);
    }
    // The code budget may evict live blocks to admit the module, or refuse it: the site then
    // runs on the interpreter and its compile is offered again on a later visit.
    if (admitJitCode(loaded, prepared.codeBytes) !== null) {
      discardPreparedJit(loaded, "code budget refusal");
      if (!systemBooted && prepared.entry.tier === "tier2" && action.kind === "install") {
        return this.runBlockExit(loaded, requestId, remaining, systemBooted, abortIfCanceled, installOnlyActions + 1);
      }
      return this.runInterpreterExit(
        loaded,
        Math.min(remaining, DEGRADED_INTERPRETER_STEPS),
        "code-budget",
      );
    }
    // A Compile miss hands its module to the compiler worker; the guest interprets the site
    // until the compiled module is installed between transactions. The deferred install owns
    // the reservation from here; a join leaves it to the compile already in flight.
    const deferral = (action.kind === "compile" || !systemBooted && prepared.entry.tier === "tier2") && this.#install.active
      ? this.#install.defer(loaded, prepared, moduleBytes)
      : "refused";
    if (deferral !== "refused") {
      if (deferral === "joined") loaded.jitCode.releaseReservation(prepared.codeBytes);
      return this.runBlockExit(
        loaded,
        requestId,
        remaining,
        systemBooted,
        abortIfCanceled,
        installOnlyActions + 1,
      );
    }
    let block: JitBlock;
    let compileMilliseconds: number;
    try {
      abortIfCanceled(requestId);
      const compileStarted = this.startArtifactTiming();
      const compiledModule = compileJitModule(moduleBytes);
      compileMilliseconds = this.elapsed(compileStarted);
      abortIfCanceled(requestId);
      block = installCompiledJitModule(loaded, prepared, compiledModule, compileMilliseconds);
    } catch (error) {
      if (error instanceof VMError && error.code === "ABORTED") {
        throw error;
      }
      if (!(error instanceof JitModuleFailure)) {
        throw failSynchronousCompile(loaded, action, bindingKey, artifactKey, error);
      }
      if (!systemBooted && prepared.entry.tier === "tier2" && action.kind === "install") {
        recordPromotionFailure(loaded.jitHealth, {
          phase: error.phase, generation: loaded.runtimeEpoch, cacheKey: action.cacheKey, error: error.engineError,
        });
        discardPreparedJit(loaded, "failed raw trace promotion");
        return this.runBlockExit(loaded, requestId, remaining, systemBooted, abortIfCanceled, installOnlyActions + 1);
      }
      this.#reportDegradation(recordJitFailure(loaded.jitHealth, {
        phase: error.phase,
        generation: loaded.runtimeEpoch,
        cacheKey: action.cacheKey,
        error: error.engineError,
      }));
      return this.degradedCompile(
        loaded, action, artifactKey, requestId, remaining, systemBooted, abortIfCanceled,
        installOnlyActions,
      );
    } finally {
      loaded.jitCode.releaseReservation(prepared.codeBytes);
    }
    loaded.traceProfile.worker.synchronousCompiles += 1;
    recordCompileLatency(loaded.runtimeStats, compileMilliseconds);
    loaded.traceProfile.worker.compileMilliseconds += compileMilliseconds;
    return this.executePreparedJitBlock(
      loaded,
      action,
      block,
      contextLength,
      executionBudget,
      false,
      systemBooted,
      requestId,
      remaining,
      abortIfCanceled,
      installOnlyActions,
    );
  }


  /**
   * A Compile or Install action the degraded JIT will not compile. A Compile translation is
   * parked in the core, which then interprets its sites from their instruction boundaries
   * without offering it again; anything the core will not park ends unexecuted and runs on the
   * interpreter, as the degraded system path does.
   */
  private degradedCompile(
    loaded: Core,
    action: CompiledJitAction,
    artifactKey: string,
    requestId: number,
    remaining: number,
    systemBooted: boolean,
    abortIfCanceled: (requestId: number) => void,
    installOnlyActions: number,
  ): CoreRunExit | undefined {
    if (action.kind === "compile" && this.#install.park(loaded, action, artifactKey)) {
      recordParkedCompile(loaded.jitHealth);
      return this.runBlockExit(
        loaded, requestId, remaining, systemBooted, abortIfCanceled, installOnlyActions + 1,
      );
    }
    discardPreparedJit(loaded, "degraded compile");
    recordInterpretedCompile(loaded.jitHealth);
    return this.runInterpreterExit(
      loaded,
      Math.min(remaining, DEGRADED_INTERPRETER_STEPS),
      "degraded",
    );
  }

  #reportDegradation(degradation: JitDegradation | undefined): void {
    if (degradation !== undefined) this.#onDegraded?.(degradation);
  }

  private executePreparedJitBlock(
    loaded: Core,
    action: CompiledJitAction,
    block: JitBlock,
    contextLength: number,
    executionBudget: number,
    cacheHit: boolean,
    systemBooted: boolean,
    requestId: number,
    remaining: number,
    abortIfCanceled: (requestId: number) => void,
    installOnlyActions: number,
  ): CoreRunExit | undefined {
    let settled = false;
    const traceBefore =
      systemTraceEnabled(loaded) ? systemTraceCpu(loaded) : undefined;
    const traceStartedAt = this.startTiming(loaded);
    try {
      if (cacheHit) {
        loaded.runtimeStats.cacheHits += 1n;
        touchJitBlock(loaded, block);
      }
      const registration = callNumber(loaded, "oxidevm_jit_register", [
        block.cacheKey,
        block.slot,
      ]);
      if (registration !== 0) {
        if (loaded.jitBlocks.get(block.key) === block) {
          evictJitBlock(loaded, block, "stale-registration");
        }
        const completion = callNumber(loaded, "oxidevm_jit_complete", [
          JIT_EXIT_GUARD,
        ]);
        settled = true;
        assertJitCompletion(
          loaded,
          completion,
          JIT_EXIT_GUARD,
          "stale registration fallback",
        );
        if (action.kind === "install") {
          return this.runBlockExit(
            loaded,
            requestId,
            remaining,
            systemBooted,
            abortIfCanceled,
            installOnlyActions + 1,
          );
        }
        return this.runInterpreterExit(
          loaded,
          Math.min(executionBudget, action.instructionCount),
          "guard",
        );
      }
      assertStatus(registration);
      synchronizeJitDispatchGeneration(loaded, block);
      if (action.kind === "install") {
        settled = true;
        return this.runBlockExit(
          loaded,
          requestId,
          remaining,
          systemBooted,
          abortIfCanceled,
          installOnlyActions + 1,
        );
      }

      const dispatchers = jitDispatchers(loaded);
      const run = this.recordingCadence.takeWindow()
        ? dispatchers.record
        : dispatchers.run;
      const contextPointer = callNumber(loaded, "oxidevm_jit_context_ptr");
      memorySlice(loaded.memory, contextPointer, contextLength);
      const executionBefore = readSystemJitExecutionDiagnostics(loaded.memory, contextPointer);
      const contextBefore =
        traceBefore === undefined
          ? undefined
          : readSystemJitContextDiagnostics(loaded.memory, contextPointer);
      const rawExit: unknown = Reflect.apply(run, undefined, [
        contextPointer,
        BigInt(executionBudget),
        block.slot,
      ]);
      drainJitAliasBindings(loaded);
      drainJitProfileSamples(loaded, contextPointer);
      const contextBoundary =
        contextBefore === undefined
          ? undefined
          : readSystemJitContextDiagnostics(loaded.memory, contextPointer);
      const executionBoundary = readSystemJitExecutionDiagnostics(
        loaded.memory,
        contextPointer,
      );
      this.recordingCadence.advance(executionBefore.retired, executionBoundary.retired);
      loaded.profileJitModules.recordOuterExecution(
        block.profileModuleId,
        executionBoundary.retired - executionBefore.retired,
      );
      const lastDispatchSlot = executionBoundary.lastDispatchSlot;
      touchLastDispatchedJitBlock(
        loaded,
        block.key,
        lastDispatchSlot,
      );
      if (
        typeof rawExit !== "number" ||
        !Number.isInteger(rawExit) ||
        rawExit < JIT_EXIT_CONTINUE ||
        rawExit > JIT_EXIT_PERFORMANCE_BOUNDARY
      ) {
        throw new VMError(
          "VM_FAULT",
          "compiled JIT block returned an invalid exit",
        );
      }
      const completion = callNumber(loaded, "oxidevm_jit_complete", [rawExit]);
      settled = true;
      assertJitCompletion(
        loaded,
        completion,
        rawExit,
        "translated execution",
        {
          actionStartRip: action.startRip,
          candidateRip: executionBoundary.rip,
          retired: executionBoundary.retired,
          halted: executionBoundary.halted,
          dispatchSlot: block.slot,
          lastDispatchSlot,
          instructions: block.instructions,
        },
      );
      const residentInterpreted = BigInt(
        callNumber(loaded, "oxidevm_jit_interpreted_steps"),
      );
      const contextAfter =
        contextBefore === undefined
          ? undefined
          : readSystemJitContextDiagnostics(
              loaded.memory,
              callNumber(loaded, "oxidevm_jit_context_ptr"),
            );
      if (isJitGuardExit(rawExit)) {
        loaded.runtimeStats.guardExits += 1n;
        const execution =
          executionBoundary.retired === 0n
            ? undefined
            : decodeRunResult(readRecord(loaded, "result"));
        if (execution !== undefined) {
          if (residentInterpreted !== 0n) {
            validateResidentGuardExecution(execution, residentInterpreted, executionBudget);
          }
          if (execution.kind !== "step-limit" || execution.steps > BigInt(executionBudget)) {
            throw new VMError("VM_FAULT", "compiled JIT block reported an invalid guard execution");
          }
          loaded.runtimeStats.jitInstructions += jitRetiredInstructions(
            execution, executionBoundary.retired, residentInterpreted,
          );
          loaded.runtimeStats.interpretedInstructions += residentInterpreted;
        }
        recordJitTrace(
          loaded,
          block,
          traceBefore,
          executionBudget,
          cacheHit,
          rawExit,
          executionBoundary.retired,
          residentInterpreted,
          lastDispatchSlot,
          executionBoundary.chainTransitions,
          this.elapsed(traceStartedAt),
          contextBefore,
          contextBoundary,
          contextAfter,
        );
        return execution;
      }
      const execution = decodeRunResult(readRecord(loaded, "result"));
      const expectedKind =
        rawExit === JIT_EXIT_HALTED
          ? "halted"
          : rawExit === JIT_EXIT_FAULT
            ? "exception"
            : "step-limit";
      const residentSystemExit =
        rawExit === JIT_EXIT_CONTINUE &&
        (execution.kind === "reset" ||
          execution.kind === "adapter-exit" ||
          execution.kind === "internal-failure");
      if (
        (execution.kind !== expectedKind && !residentSystemExit) ||
        execution.steps <= 0n ||
        execution.steps > BigInt(executionBudget) ||
        residentInterpreted > execution.steps
      ) {
        throw new VMError(
          "VM_FAULT",
          "compiled JIT block reported an invalid retired count",
        );
      }
      loaded.runtimeStats.jitInstructions += jitRetiredInstructions(
        execution, executionBoundary.retired, residentInterpreted,
      );
      loaded.runtimeStats.interpretedInstructions += residentInterpreted;
      recordJitTrace(
        loaded,
        block,
        traceBefore,
        executionBudget,
        cacheHit,
        rawExit,
        executionBoundary.retired,
        residentInterpreted,
        lastDispatchSlot,
        executionBoundary.chainTransitions,
        this.elapsed(traceStartedAt),
        contextBefore,
        contextBoundary,
        contextAfter,
      );
      return execution;
    } catch (error) {
      if (!settled) {
        discardPreparedJit(loaded, "translated execution cleanup", error);
      }
      throw error;
    }
  }

  private startTiming(loaded: Core): number | undefined {
    const call = this.timingCalls++;
    if (this.timingMode.kind === "disabled" && !systemTraceEnabled(loaded)
      || this.timingMode.kind === "sampled" && call % EXECUTION_TIMING_SAMPLE_INTERVAL !== 0) {
      return undefined;
    }
    this.timingSamples += 1;
    return performance.now();
  }

  private startArtifactTiming(): number {
    return artifactTimingStart();
  }

  private elapsed(startedAt: number | undefined): number {
    return startedAt === undefined ? 0 : performance.now() - startedAt;
  }

}

/** Compile, instantiate and install happen at most a few hundred times per
 * second and dominate JIT warm-up (a Node startup compiles tens of thousands
 * of blocks), so they are timed in every execution timing mode; only per-batch
 * execution timing stays sampled to protect the hot path. */
export function artifactTimingStart(): number {
  return performance.now();
}

function recordJitTrace(
  loaded: Core,
  block: JitBlock,
  before: SystemTraceCpu | undefined,
  budget: number,
  cacheHit: boolean,
  rawExit: number,
  steps: bigint,
  residentInterpreted: bigint,
  lastDispatchSlot: number | null,
  chainTransitions: number,
  durationMilliseconds: number,
  contextBefore: SystemTraceJitContext | undefined,
  contextBoundary: SystemTraceJitContext | undefined,
  contextAfter: SystemTraceJitContext | undefined,
): void {
  loaded.traceProfile.worker.jitBatches += 1;
  loaded.traceProfile.worker.jitInstructions += steps - residentInterpreted;
  if (residentInterpreted !== 0n) {
    loaded.traceProfile.worker.interpreterBatches += 1;
    loaded.traceProfile.worker.interpreterReasons.admission.batches += 1;
    loaded.traceProfile.worker.interpreterReasons.admission.instructions +=
      residentInterpreted;
  }
  loaded.traceProfile.worker.jitChainTransitions +=
    BigInt(chainTransitions);
  loaded.traceProfile.worker.jitMilliseconds += durationMilliseconds;
  if (cacheHit) loaded.traceProfile.worker.jitCacheHits += 1n;
  if (isJitGuardExit(rawExit)) {
    loaded.traceProfile.worker.jitGuardExits += 1n;
  }
  if (
    before === undefined ||
    contextBefore === undefined ||
    contextBoundary === undefined ||
    contextAfter === undefined
  ) {
    return;
  }
  recordSystemTrace(loaded, {
    kind: "jit",
    ...systemTraceBase(loaded),
    before,
    after: systemTraceCpu(loaded),
    cacheKey: block.cacheKey,
    cacheHit,
    dispatchSlot: block.slot,
    lastDispatchSlot,
    budget,
    steps,
    durationMilliseconds,
    exit: jitTraceExit(rawExit),
    instructions: block.instructions,
    contextBefore,
    contextBoundary,
    contextAfter,
    artifact: block.artifact,
  });
}

function discardPreparedJit(
  loaded: Core,
  phase: string,
  cause?: unknown,
): void {
  const cleanup = callNumber(loaded, "oxidevm_jit_complete", [JIT_EXIT_GUARD]);
  if (cleanup !== 0) {
    const failureMask = callNumber(
      loaded,
      "oxidevm_jit_completion_failure",
    );
    if (cause instanceof Error && failureMask === 1 << 9) throw cause;
    const failures = jitCompletionFailures(failureMask);
    throw new VMError(
      "VM_FAULT",
      `failed to discard prepared JIT state during ${phase} (${failures.join(", ")})`,
      {
        phase,
        status: cleanup,
        failureMask,
        failures,
        ...(cause === undefined
          ? {}
          : {
              cause:
                cause instanceof Error
                  ? cause.message
                  : "non-Error failure",
            }),
      },
    );
  }
}

function assertJitCompletion(
  loaded: Core,
  status: number,
  exit: number,
  phase: string,
  context: Readonly<Record<string, unknown>> = {},
): void {
  if (status !== 0) {
    const failureMask = callNumber(
      loaded,
      "oxidevm_jit_completion_failure",
    );
    const failures = jitCompletionFailures(failureMask);
    const residentInterpreted = callNumber(
      loaded,
      "oxidevm_jit_interpreted_steps",
    );
    const candidateRip = context["candidateRip"];
    const actionStartRip = context["actionStartRip"];
    const retired = context["retired"];
    const lastDispatchSlot = context["lastDispatchSlot"];
    const suffix =
      typeof candidateRip === "bigint" &&
      typeof actionStartRip === "bigint" &&
      typeof retired === "bigint"
        ? ` for candidate 0x${actionStartRip.toString(16)} at RIP 0x${candidateRip.toString(16)} after ${retired.toString()} instructions, dispatch slot ${String(lastDispatchSlot)}`
        : "";
    throw new VMError(
      "VM_FAULT",
      `JIT completion was rejected during ${phase} (${failures.join(", ")}, status ${String(status)}, exit ${String(exit)})${suffix}`,
      {
        phase,
        status,
        exit,
        failureMask,
        failures,
        residentInterpreted,
        ...context,
      },
    );
  }
}

function prepareJitAction(
  loaded: Core,
  maximumInstructions: number,
  timing: ExecutionTimingMode["kind"],
): CoreJitAction {
  const profile = loaded.traceProfile.worker;
  const sampled = timing === "exact"
    || timing === "sampled" && profile.prepareCalls % PREPARE_SAMPLE_INTERVAL === 0;
  const startedAt = sampled ? performance.now() : 0;
  profile.prepareCalls += 1;
  assertStatus(
    callNumber(loaded, "oxidevm_jit_next", [maximumInstructions]),
  );
  const action = decodeJitAction(
    readExportedView(loaded, "oxidevm_jit_action"),
  );
  if (sampled) {
    profile.prepareSamples += 1;
    profile.prepareSampleMilliseconds += performance.now() - startedAt;
  }
  return action;
}

/** A fault preparing or installing a module on the guest's thread, other than the engine refusing
 * to compile or instantiate it, disables the JIT and stays a fault. */
function failSynchronousCompile(
  loaded: Core,
  action: CompiledJitAction,
  bindingKey: string,
  artifactKey: string,
  error: unknown,
): VMError {
  recordJitFailure(loaded.jitHealth, {
    phase: "synchronous-compile",
    generation: loaded.runtimeEpoch,
    cacheKey: action.cacheKey,
    error: jitFailureError(error),
    reason: "module-abi",
  });
  return new VMError(
    "VM_FAULT",
    "synchronous JIT generation failed",
    {
      bindingKey,
      artifactKey,
      cause: error instanceof Error ? error.message : "non-Error failure",
    },
  );
}
