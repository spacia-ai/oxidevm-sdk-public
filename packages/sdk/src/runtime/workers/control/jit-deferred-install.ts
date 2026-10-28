import { VMError } from "../../errors.js";
import { MAX_LINKED_JIT_MEMBERS } from "../../jit-cache.js";
import type { SystemJitInstallMode } from "../../protocol/system-trace-background-compile.js";
import { assertStatus, callNumber, type Core } from "./core.js";
import type { CompiledJitAction } from "./jit-blocks.js";
import type { JitCompileResult, JitCompilerClient } from "./jit-compiler-client.js";
import { jitLinkSignature, linkJitModules, MAX_LINKED_BYTES } from "./jit-link.js";
import { recordCompileLatency } from "./telemetry.js";
import {
  installCompiledJitModule,
  installLinkedJitMember,
  instantiateLinkedJitModule,
  type LinkedJitInstance,
  type PreparedJitModule,
} from "./jit-module-install.js";
import {
  type JitDegradation,
  JitModuleFailure,
  jitFailureError,
  recordJitFailure,
  recordPromotionFailure,
  recordPromotionDiscard,
} from "./jit-health.js";
import { decodeDeferredTraceValidation } from "./jit-promotion-validation.js";

/** The core's `JitSettleOutcome` wire values. */
const SETTLE_COMPILED = 0;
const SETTLE_FAILED = 1;
const SETTLE_ABANDONED = 2;
/** `oxidevm_jit_defer` refused the transaction; the module is compiled inside it instead. */
const STATUS_REFUSED = 2;
/** Without a shared ready counter, slices with compiles outstanding last at most this long. */
const POLL_MILLISECONDS = 4;

/** A Tier-1 module the core holds in flight: its artifact stays unbound until it settles. */
interface DeferredModule {
  readonly prepared: PreparedJitModule;
  readonly deferredAt: number;
}

/** One compile in the compiler: a standalone module, or the members of a linked one. */
interface DeferredCompile {
  readonly core: Core;
  readonly members: readonly DeferredModule[];
  /** The linked module's batch number, or null for a standalone module. */
  readonly batch: number | null;
  /** Bytes of the module sent to the compiler. */
  readonly bytes: number;
}

/** Modules of one core sharing a link signature, waiting to be linked into one compile. */
interface OpenBatch {
  readonly core: Core;
  readonly members: DeferredModule[];
  readonly modules: Uint8Array<ArrayBuffer>[];
  bytes: number;
  /** When the first member joined. */
  readonly openedAt: number;
}

/**
 * When an open batch is sealed in `batched` mode. A batch is sealed once it holds
 * `sealMembers` modules, or once the compiler is idle and its first module has waited
 * `sealWaitMilliseconds`; a full batch (`MAX_LINKED_JIT_MEMBERS` or `MAX_LINKED_BYTES`) is
 * always sealed. `{ sealMembers: MAX_LINKED_JIT_MEMBERS, sealWaitMilliseconds: 0 }` seals
 * whenever the compiler is idle, so only modules that arrive while a compile runs share a batch.
 */
export interface JitBatchPolicy {
  readonly sealMembers: number;
  readonly sealWaitMilliseconds: number;
}

/** Seal whenever the compiler is idle (the policy before per-engine batching). */
export const IDLE_SEAL_BATCH_POLICY: JitBatchPolicy = {
  sealMembers: MAX_LINKED_JIT_MEMBERS,
  sealWaitMilliseconds: 0,
};

/** What `defer` did with a Compile transaction. */
export type JitDeferral = "deferred" | "joined" | "refused";

/** A translation a degraded JIT left in flight in the core, which interprets its sites. */
interface ParkedArtifact {
  readonly core: Core;
  readonly artifactCacheKey: bigint;
  readonly artifactModuleLength: number;
}

/**
 * Tier-1 modules compiling off the guest's thread for one JIT runtime. A Compile transaction's
 * module goes to the compiler and the core keeps its translation unbound while the guest
 * interprets the site; between transactions, each finished compile is instantiated, installed
 * and settled in the core. In `batched` mode modules wait in an open batch while a compile is
 * running and are linked into one module when the compiler is idle or the batch is full, so the
 * engine compiles them together. The core owns which artifacts are in flight; this owns the
 * compiles, the open batches and the SDK side of their accounting.
 */
export class JitDeferredInstall {
  readonly #compiler: JitCompilerClient | undefined;
  readonly #compiles = new Map<number, DeferredCompile>();
  readonly #open = new Map<string, OpenBatch>();
  /** Artifacts in flight and the core that deferred them, so another visit joins them. */
  readonly #artifacts = new Map<string, Core>();
  /** Translations parked by a degraded JIT, by artifact key; settled abandoned on invalidation. */
  readonly #parked = new Map<string, ParkedArtifact>();
  readonly #batchPolicy: JitBatchPolicy;
  #mode: SystemJitInstallMode;
  #abandonAll = false;
  #recordedFor: Core | undefined;
  #batches = 0;

  constructor(
    mode: SystemJitInstallMode = "immediate",
    compiler?: JitCompilerClient,
    batchPolicy: JitBatchPolicy = IDLE_SEAL_BATCH_POLICY,
  ) {
    this.#mode = compiler === undefined ? "immediate" : mode;
    this.#compiler = compiler;
    this.#batchPolicy = batchPolicy;
  }

  get mode(): SystemJitInstallMode {
    return this.#mode;
  }

  /** Whether Compile transactions are deferred now. */
  get active(): boolean {
    return this.#mode !== "immediate" && this.#compiler?.unavailable === null;
  }

  /** Selects the install mode; leaving for `immediate` abandons the modules in flight. */
  configure(mode: SystemJitInstallMode): void {
    if (this.#compiler === undefined) return;
    if (mode === "immediate" && this.#hasModules()) this.#abandonAll = true;
    this.#mode = mode;
    this.#recordedFor = undefined;
  }

  /** Writes the install mode into `loaded`'s profile the first time `loaded` runs with it. */
  record(loaded: Core): void {
    if (this.#recordedFor === loaded) return;
    this.#recordedFor = loaded;
    const profile = loaded.traceProfile.worker.backgroundCompile;
    profile.installMode = this.#mode;
    profile.fallback = this.#compiler?.unavailable ?? null;
  }

  /** Whether finished, abandoned or batched modules wait to be settled or sealed. */
  hasWork(): boolean {
    const compiler = this.#compiler;
    return this.#abandonAll
      || compiler?.hasResults() === true
      || this.#open.size !== 0 && compiler?.inFlight === 0 && this.#idleSealDue();
  }

  /** Whether the guest's slice should end so a finished compile is installed: one is ready, or,
   * without a shared ready counter, compiles are outstanding and the slice has run for
   * `POLL_MILLISECONDS`. */
  shouldYield(sliceMilliseconds: number): boolean {
    const compiler = this.#compiler;
    if (compiler === undefined || this.#compiles.size === 0) return false;
    return compiler.resultReady()
      || !compiler.signalsReady() && sliceMilliseconds >= POLL_MILLISECONDS;
  }

  /**
   * Hands the pending Compile transaction's module to the compiler, or to an open batch, and
   * ends the transaction unexecuted. Joins an artifact already in flight; returns `refused` when
   * the core or the compiler cannot take it, leaving the transaction to compile its module.
   */
  defer(loaded: Core, prepared: PreparedJitModule, moduleBytes: Uint8Array): JitDeferral {
    const compiler = this.#compiler;
    const profile = loaded.traceProfile.worker.backgroundCompile;
    if (compiler === undefined || compiler.unavailable !== null) return "refused";
    const joined = this.#artifacts.get(prepared.entry.key) === loaded;
    if (!joined && !compiler.accepts()) {
      profile.queueFull += 1;
      return "refused";
    }
    const status = callNumber(loaded, "oxidevm_jit_defer", [prepared.action.cacheKey]);
    if (status === STATUS_REFUSED) {
      profile.refused += 1;
      return "refused";
    }
    assertStatus(status);
    if (joined) {
      profile.joined += 1;
      return "joined";
    }
    this.#artifacts.set(prepared.entry.key, loaded);
    profile.submitted += 1;
    const deferred = { prepared, deferredAt: performance.now() };
    const bytes = moduleBytes.slice();
    // Promoted traces already internalize their hot boundaries; keep their artifact standalone.
    const signature = this.#mode === "batched" && prepared.entry.tier === "tier1" ? jitLinkSignature(bytes) : null;
    if (signature === null) this.#submit(loaded, [deferred], bytes, null);
    else this.#addToBatch(loaded, signature, deferred, bytes);
    this.#recordInFlight(loaded);
    return "deferred";
  }

  /**
   * Installs or settles every finished compile and seals open batches once the compiler is
   * idle. Call between transactions only. A module the engine refused to compile or instantiate
   * settles as failed and degrades the JIT (`jit-health.ts`); the first resulting state change is
   * returned. A fault around an install throws once every other result has settled.
   */
  settle(loaded: Core): JitDegradation | undefined {
    if (this.#abandonAll) this.#discardAll(loaded);
    const compiler = this.#compiler;
    if (compiler === undefined) return undefined;
    const profile = loaded.traceProfile.worker.backgroundCompile;
    let fault: VMError | undefined;
    let degradation: JitDegradation | undefined;
    for (const result of compiler.take()) {
      const compile = this.#compiles.get(result.id);
      if (compile === undefined) {
        profile.staleResults += 1;
        continue;
      }
      this.#compiles.delete(result.id);
      for (const member of compile.members) this.#forget(compile.core, member);
      if (compile.core !== loaded) continue;
      const outcome = this.#settleResult(loaded, compile, result);
      if (outcome instanceof VMError) fault ??= outcome;
      else degradation ??= outcome;
    }
    if (compiler.unavailable !== null) profile.fallback = compiler.unavailable;
    // A degraded JIT seals no new compiles; the open members settle as abandoned.
    if (compiler.unavailable !== null || loaded.jitHealth.state !== "active") {
      this.#abandonOpen(loaded);
    } else if (compiler.inFlight === 0 && this.#open.size !== 0) {
      const now = performance.now();
      for (const [signature, batch] of [...this.#open]) {
        if (batch.core !== loaded) this.#dropBatch(signature, batch);
        else if (this.#batchWaited(batch, now)) this.#seal(signature, batch);
      }
    }
    this.#recordInFlight(loaded);
    if (fault !== undefined) throw fault;
    return degradation;
  }

  /**
   * Parks the pending Compile transaction's translation in the core without compiling it: the
   * core ends the transaction unexecuted and, while the artifact is in flight, interprets its
   * sites itself instead of offering the translation again (which would emit its module on every
   * visit). Only a degraded JIT parks; returns false when the core refuses, leaving the
   * transaction pending.
   */
  park(loaded: Core, action: CompiledJitAction, artifactKey: string): boolean {
    const status = callNumber(loaded, "oxidevm_jit_defer", [action.cacheKey]);
    if (status === STATUS_REFUSED) return false;
    assertStatus(status);
    if (this.#artifacts.get(artifactKey) !== loaded && this.#parked.get(artifactKey)?.core !== loaded) {
      this.#parked.set(artifactKey, {
        core: loaded,
        artifactCacheKey: action.artifactCacheKey,
        artifactModuleLength: action.artifactModuleLength,
      });
    }
    return true;
  }

  /** Abandons every module in flight and every parked translation; they settle at the next
   * `settle`. */
  invalidate(): void {
    if (this.#hasModules()) this.#abandonAll = true;
  }

  dispose(): void {
    this.#compiles.clear();
    this.#open.clear();
    this.#artifacts.clear();
    this.#parked.clear();
    this.#abandonAll = false;
    this.#compiler?.dispose();
  }

  #hasModules(): boolean {
    return this.#compiles.size !== 0 || this.#open.size !== 0 || this.#parked.size !== 0;
  }

  #addToBatch(
    loaded: Core,
    signature: string,
    deferred: DeferredModule,
    bytes: Uint8Array<ArrayBuffer>,
  ): void {
    const current = this.#open.get(signature);
    if (current !== undefined && current.core !== loaded) this.#dropBatch(signature, current);
    else if (current !== undefined && current.bytes + bytes.byteLength > MAX_LINKED_BYTES) {
      this.#seal(signature, current);
    }
    let batch = this.#open.get(signature);
    if (batch === undefined) {
      batch = { core: loaded, members: [], modules: [], bytes: 0, openedAt: deferred.deferredAt };
      this.#open.set(signature, batch);
    }
    batch.members.push(deferred);
    batch.modules.push(bytes);
    batch.bytes += bytes.byteLength;
    if (
      batch.members.length >= Math.min(this.#batchPolicy.sealMembers, MAX_LINKED_JIT_MEMBERS)
      || this.#compiler?.inFlight === 0 && this.#batchWaited(batch, deferred.deferredAt)
    ) {
      this.#seal(signature, batch);
    }
  }

  /** Whether an open batch has waited long enough to be sealed while the compiler is idle. */
  #batchWaited(batch: OpenBatch, now: number): boolean {
    return now - batch.openedAt >= this.#batchPolicy.sealWaitMilliseconds;
  }

  /** Whether some open batch is due to be sealed now that the compiler is idle; without a wait
   * every batch is, and the clock is not read. */
  #idleSealDue(): boolean {
    if (this.#batchPolicy.sealWaitMilliseconds === 0) return true;
    const now = performance.now();
    for (const batch of this.#open.values()) if (this.#batchWaited(batch, now)) return true;
    return false;
  }

  /** Sends an open batch to the compiler: one module alone, or several linked into one. */
  #seal(signature: string, batch: OpenBatch): void {
    this.#open.delete(signature);
    const loaded = batch.core;
    const [only] = batch.modules;
    if (batch.members.length === 1 && only !== undefined) {
      this.#submit(loaded, batch.members, only, null);
      return;
    }
    const profile = loaded.traceProfile.worker.backgroundCompile;
    const linked = linkJitModules(loaded, batch.modules);
    if (linked === undefined) {
      profile.linkFailures += 1;
      for (const [index, member] of batch.members.entries()) {
        const module = batch.modules[index];
        if (module !== undefined) this.#submit(loaded, [member], module, null);
      }
      return;
    }
    this.#batches += 1;
    profile.batches += 1;
    profile.batchedModules += batch.members.length;
    profile.largestBatch = Math.max(profile.largestBatch, batch.members.length);
    this.#submit(loaded, batch.members, linked, this.#batches);
  }

  #submit(
    loaded: Core,
    members: readonly DeferredModule[],
    bytes: Uint8Array<ArrayBuffer>,
    batch: number | null,
  ): void {
    const compiler = this.#compiler;
    if (compiler?.accepts() !== true) {
      for (const member of members) this.#abandon(loaded, member);
      return;
    }
    const length = bytes.byteLength;
    this.#compiles.set(compiler.submit(bytes), { core: loaded, members, batch, bytes: length });
  }

  /** Drops the open batch of a core that no longer runs; its members cannot settle. */
  #dropBatch(signature: string, batch: OpenBatch): void {
    this.#open.delete(signature);
    for (const member of batch.members) this.#forget(batch.core, member);
  }

  /** Settles every open member of `loaded` as abandoned: nothing will compile it. */
  #abandonOpen(loaded: Core): void {
    for (const [signature, batch] of [...this.#open]) {
      if (batch.core !== loaded) continue;
      this.#open.delete(signature);
      for (const member of batch.members) this.#abandon(loaded, member);
    }
  }

  #abandon(loaded: Core, member: DeferredModule): void {
    loaded.traceProfile.worker.backgroundCompile.abandoned += 1;
    settleInCore(loaded, member, SETTLE_ABANDONED);
    this.#forget(loaded, member);
  }

  /** The runtime was reset: every module of `loaded` in flight settles as discarded. */
  #discardAll(loaded: Core): void {
    this.#abandonAll = false;
    this.#compiler?.reset();
    for (const parked of this.#parked.values()) {
      if (parked.core !== loaded) continue;
      assertStatus(callNumber(loaded, "oxidevm_jit_compile_settled", [
        parked.artifactCacheKey,
        parked.artifactModuleLength,
        SETTLE_ABANDONED,
      ]));
    }
    this.#parked.clear();
    const profile = loaded.traceProfile.worker.backgroundCompile;
    const discarded = [
      ...[...this.#compiles.values()].filter((compile) => compile.core === loaded),
      ...[...this.#open.values()].filter((batch) => batch.core === loaded),
    ].flatMap((owner) => owner.members);
    for (const member of discarded) {
      settleInCore(loaded, member, SETTLE_ABANDONED);
      loaded.jitCode.releaseReservation(member.prepared.codeBytes);
      profile.discarded += 1;
    }
    this.#compiles.clear();
    this.#open.clear();
    this.#artifacts.clear();
  }

  /** `member` leaves the deferred install, whatever became of it: its artifact is no longer in
   * flight here and its code reservation ends (an installed member's unit now holds it). */
  #forget(core: Core, member: DeferredModule): void {
    const key = member.prepared.entry.key;
    if (this.#artifacts.get(key) === core) this.#artifacts.delete(key);
    core.jitCode.releaseReservation(member.prepared.codeBytes);
  }

  /** Modules of `loaded` in flight, open or compiling, into its profile. */
  #recordInFlight(loaded: Core): void {
    let count = 0;
    for (const compile of this.#compiles.values()) {
      if (compile.core === loaded) count += compile.members.length;
    }
    for (const batch of this.#open.values()) {
      if (batch.core === loaded) count += batch.members.length;
    }
    const profile = loaded.traceProfile.worker.backgroundCompile;
    profile.inFlight = count;
    profile.peakInFlight = Math.max(profile.peakInFlight, count);
  }

  /** Installs or settles one result; returns the degradation or the install fault it caused.
   * An exhausted JIT still installs modules that compiled: their code already exists. */
  #settleResult(
    loaded: Core,
    compile: DeferredCompile,
    result: JitCompileResult,
  ): JitDegradation | VMError | undefined {
    const profile = loaded.traceProfile.worker.backgroundCompile;
    const [first] = compile.members;
    if (first === undefined) return undefined;
    if (result.kind === "abandoned" || loaded.jitHealth.state === "disabled") {
      for (const member of compile.members) {
        profile.abandoned += 1;
        settleInCore(loaded, member, SETTLE_ABANDONED);
      }
      return undefined;
    }
    if (result.kind === "failed") {
      for (const member of compile.members) {
        profile.failed += 1;
        settleInCore(loaded, member, SETTLE_FAILED);
      }
      const failure = {
        phase: "background-compile",
        generation: loaded.runtimeEpoch,
        cacheKey: first.prepared.action.cacheKey,
        error: { name: result.errorName, message: result.reason },
      } as const;
      if (first.prepared.entry.tier === "tier2") {
        recordPromotionFailure(loaded.jitHealth, failure);
        return undefined;
      }
      return recordJitFailure(loaded.jitHealth, failure);
    }
    const failure = compile.batch === null
      ? installStandalone(loaded, first, result)
      : installLinked(loaded, compile, compile.batch, result);
    if (failure === undefined) {
      recordCompileLatency(loaded.runtimeStats, result.compileMilliseconds);
      profile.compileMilliseconds += result.compileMilliseconds;
    }
    return failure;
  }
}

type CompiledResult = Extract<JitCompileResult, { readonly kind: "compiled" }>;

function installStandalone(
  loaded: Core,
  member: DeferredModule,
  result: CompiledResult,
): JitDegradation | VMError | undefined {
  if (member.prepared.entry.tier === "tier2") {
    let discard: ReturnType<typeof decodeDeferredTraceValidation>;
    try {
      discard = decodeDeferredTraceValidation(callNumber(loaded, "oxidevm_jit_deferred_trace_validate", [
        member.prepared.action.artifactCacheKey, member.prepared.action.artifactModuleLength,
      ]));
    } catch (error) { return failInstall(loaded, [member], error); }
    if (discard !== null) {
      loaded.traceProfile.worker.backgroundCompile.staleResults += 1;
      loaded.traceProfile.worker.backgroundCompile.abandoned += 1;
      recordPromotionDiscard(loaded.jitHealth, {
        generation: loaded.runtimeEpoch, cacheKey: member.prepared.action.cacheKey, reason: discard,
      });
      settleInCore(loaded, member, SETTLE_ABANDONED);
      return undefined;
    }
  }
  try {
    installCompiledJitModule(loaded, member.prepared, result.module, result.compileMilliseconds);
  } catch (error) {
    return failInstall(loaded, [member], error);
  }
  settleCompiled(loaded, member);
  return undefined;
}

/** Instantiates a linked module once and installs each member from its member tables. */
function installLinked(
  loaded: Core,
  { members, bytes }: DeferredCompile,
  batch: number,
  result: CompiledResult,
): JitDegradation | VMError | undefined {
  let linked: LinkedJitInstance & { readonly instantiationMilliseconds: number };
  try {
    linked = instantiateLinkedJitModule(loaded, result.module, members.length, bytes);
  } catch (error) {
    return failInstall(loaded, members, error);
  }
  const timing = {
    compileMilliseconds: result.compileMilliseconds / members.length,
    instantiationMilliseconds: linked.instantiationMilliseconds / members.length,
  };
  for (const [memberIndex, member] of members.entries()) {
    const artifact = { kind: "linked", batch, memberIndex, members: members.length } as const;
    try {
      installLinkedJitMember(loaded, member.prepared, linked, artifact, timing);
    } catch (error) {
      return failInstall(loaded, members.slice(memberIndex), error);
    }
    settleCompiled(loaded, member);
  }
  return undefined;
}

function settleCompiled(loaded: Core, member: DeferredModule): void {
  settleInCore(loaded, member, SETTLE_COMPILED);
  const profile = loaded.traceProfile.worker.backgroundCompile;
  profile.compiled += 1;
  profile.latencyMilliseconds += performance.now() - member.deferredAt;
}

/**
 * The first of `members` failed to install and settles as failed; the rest are abandoned. The
 * engine refusing to instantiate degrades the JIT; any other failure disables it and stays a
 * fault, as it was before the JIT degraded.
 */
function failInstall(
  loaded: Core,
  members: readonly DeferredModule[],
  error: unknown,
): JitDegradation | VMError | undefined {
  const [failed, ...rest] = members;
  if (failed === undefined) return undefined;
  const profile = loaded.traceProfile.worker.backgroundCompile;
  profile.failed += 1;
  settleInCore(loaded, failed, SETTLE_FAILED);
  for (const member of rest) {
    profile.abandoned += 1;
    settleInCore(loaded, member, SETTLE_ABANDONED);
  }
  const failure = {
    phase: "instantiation",
    generation: loaded.runtimeEpoch,
    cacheKey: failed.prepared.action.cacheKey,
  } as const;
  if (error instanceof JitModuleFailure) {
    if (failed.prepared.entry.tier === "tier2") {
      recordPromotionFailure(loaded.jitHealth, { ...failure, phase: error.phase, error: error.engineError });
      return undefined;
    }
    return recordJitFailure(loaded.jitHealth, { ...failure, phase: error.phase, error: error.engineError });
  }
  recordJitFailure(loaded.jitHealth, {
    ...failure,
    error: jitFailureError(error),
    reason: "module-abi",
  });
  return new VMError("VM_FAULT", "background JIT compilation failed", {
    bindingKey: failed.prepared.entry.bindingKey,
    artifactKey: failed.prepared.entry.key,
    cause: error instanceof Error ? error.message : "non-Error failure",
  });
}

function settleInCore(loaded: Core, member: DeferredModule, outcome: number): void {
  assertStatus(callNumber(loaded, "oxidevm_jit_compile_settled", [
    member.prepared.action.artifactCacheKey,
    member.prepared.action.artifactModuleLength,
    outcome,
  ]));
}
